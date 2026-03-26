'use strict';

const { chromium } = require('patchright');
const fs = require('fs');
const { PNG } = require('pngjs');

// 환경에 따라 Chrome 경로 자동 감지
function getChromePath() {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // Mac
    '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome',  // 클라우드
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  for (const p of paths) {
    try { fs.accessSync(p); return p; } catch { /* 없음 */ }
  }
  return undefined; // patchright 기본값 사용
}
const IS_MAC = process.platform === 'darwin';

const SPORTS_PAGE = 'https://www.ticketlink.co.kr/sports/137/63';
const RESERVE_BASE = 'https://www.ticketlink.co.kr/reserve/plan/schedule';
const VENUE_NAME = '대전 한화생명 볼파크';

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
  const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// ─────────────────────────────────────────────
// PAYCO 로그인
// ─────────────────────────────────────────────

async function login(page, config) {
  log('🔐 티켓링크 메인 접속...');
  await page.goto('https://www.ticketlink.co.kr/sports', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // 팝업 제거
  try {
    await page.evaluate(() => {
      document.querySelectorAll('.full_page_pop').forEach(el => el.remove());
    });
  } catch { /* ignore */ }

  log('🔐 로그인 버튼 클릭...');

  // PAYCO 팝업 창 대기 후 클릭
  const [paycoPopup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 15000 }),
    page.locator('a.header_util_link:has-text("로그인")').click(),
  ]);

  log('📱 PAYCO 팝업 감지됨');
  await paycoPopup.waitForLoadState('domcontentloaded');
  await sleep(1000);

  // 팝업에 계정 정보 입력
  await paycoPopup.locator('input[placeholder*="아이디"], input[name="id"], #idInput').fill(config.paycoId);
  await paycoPopup.locator('input[placeholder*="비밀번호"], input[name="pw"], input[type="password"]').fill(config.paycoPw);
  await paycoPopup.locator('button:has-text("로그인"), .btn_login').first().click();

  // 새 기기 인증 (PAYCO OTP — 사용자가 직접 입력)
  try {
    await paycoPopup.waitForSelector('text=새로운 기기', { timeout: 6000 });
    log('📲 새 기기 인증 팝업 감지!');
    log('   ✋ 브라우저에서 인증번호를 직접 입력 후 확인을 눌러주세요.');
    log('   ⏳ 최대 120초 대기...');
    // 팝업이 닫힐 때까지 대기 (사용자가 직접 인증번호 입력)
    await paycoPopup.waitForEvent('close', { timeout: 120000 }).catch(() => {});
    log('   ✅ 인증 완료');
    return; // 이미 팝업 닫혔으므로 아래 close() 불필요
  } catch { /* 인증 팝업 없음 */ }

  // 팝업 처리 완료 대기 후 강제 정리
  await sleep(3000);
  if (!paycoPopup.isClosed()) {
    await paycoPopup.close().catch(() => {});
  }

  // 메인 페이지를 스포츠 페이지로 직접 이동 (리다이렉트 루프 차단)
  await page.goto('https://www.ticketlink.co.kr/sports', { waitUntil: 'domcontentloaded' });
  log('✅ 로그인 완료');
}

// ─────────────────────────────────────────────
// 전략 A: 스포츠 페이지에서 Schedule ID 사전 추출
// (오픈 전 disabled 버튼에서 data 속성으로 추출)
// ─────────────────────────────────────────────

async function extractScheduleId(page, targetDate) {
  log('🔍 Schedule ID 사전 추출 시도...');
  await page.goto(SPORTS_PAGE, { waitUntil: 'domcontentloaded' });

  const id = await page.evaluate(({ venue, date }) => {
    // 모든 a/button 요소에서 reserve/plan/schedule URL 탐색
    const allEls = document.querySelectorAll('a, button, [data-url], [data-href], [onclick]');
    for (const el of allEls) {
      const text = el.closest('li, tr, [class*="item"], [class*="row"]')?.textContent || '';
      if (!text.includes(venue)) continue;
      if (date && !text.includes(date)) continue;

      // href 직접 포함
      const href = el.href || el.getAttribute('href') || '';
      const m = href.match(/\/reserve\/plan\/schedule\/(\d+)/);
      if (m) return m[1];

      // data 속성
      for (const attr of ['data-url', 'data-href', 'data-link', 'data-schedule-id', 'data-id']) {
        const v = el.getAttribute(attr) || '';
        const dm = v.match(/(\d{8,})/);
        if (dm) return dm[1];
      }

      // onclick 속성
      const oc = el.getAttribute('onclick') || '';
      const om = oc.match(/\/reserve\/plan\/schedule\/(\d+)/);
      if (om) return om[1];
    }

    // 페이지 전체 HTML에서 reserve URL 패턴 검색 (script 포함)
    const html = document.documentElement.innerHTML;
    const matches = [...html.matchAll(/\/reserve\/plan\/schedule\/(\d+)/g)];
    // 날짜로 필터링은 어렵지만 중복 제거 후 반환
    const ids = [...new Set(matches.map((m) => m[1]))];
    // 가장 큰 ID (최신 경기일 가능성)
    if (ids.length > 0) {
      return ids.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    }
    return null;
  }, { venue: VENUE_NAME, date: targetDate });

  if (id) {
    log(`✅ Schedule ID 발견: ${id}`);
    return id;
  }

  log('⚠️  Schedule ID 추출 실패 → 스포츠 페이지 폴링 전략으로 전환');
  return null;
}

// ─────────────────────────────────────────────
// 전략 B: 정시 폴링 (100ms 간격)
// ─────────────────────────────────────────────

// 페이지 로딩 선행 시간 (ms) — 11시 정각보다 이 만큼 먼저 폴링 시작
const OPEN_LEAD_MS = 3500;

async function waitForOpenTime(openTimeStr) {
  if (openTimeStr === 'now') {
    log('⚡ 즉시 예매 모드 — 대기 없이 바로 진행');
    return;
  }

  const now = new Date();
  const [h, m, s] = openTimeStr.split(':').map(Number);
  const target = new Date(now);
  target.setHours(h, m, s, 0);

  // 페이지 로딩 선행: 목표 시각 OPEN_LEAD_MS 전에 폴링 시작
  const waitMs = target.getTime() - now.getTime() - OPEN_LEAD_MS;

  if (waitMs <= 0) {
    log('⚡ 오픈 시간이 이미 지났습니다. 바로 진행합니다.');
    return;
  }

  log(`⏱  오픈까지 ${Math.round((waitMs + OPEN_LEAD_MS) / 1000)}초 대기 → ${openTimeStr} 기준 ${OPEN_LEAD_MS / 1000}초 선행`);

  if (waitMs > 31000) await sleep(waitMs - 30000);

  let remaining = Math.min(waitMs, 30000);
  while (remaining > 1000) {
    process.stdout.write(`\r⏱  ${Math.round(remaining / 1000)}초 남음...   `);
    await sleep(1000);
    remaining -= 1000;
  }
  await sleep(Math.max(remaining, 0));
  process.stdout.write('\r');
  log(`🚀 폴링 시작! (${openTimeStr} 기준 ${OPEN_LEAD_MS / 1000}초 선행)`);
}

// ─────────────────────────────────────────────
// 대기열(Queue) 팝업 처리
// ─────────────────────────────────────────────

async function handleQueueIfAppears(page, detectTimeout = 8000) {
  // 대기열 팝업 감지
  try {
    const queueSelector = 'text=대기순번, text=접속 대기중, text=접속자가 많아, text=잠시만 기다리시면';
    await page.waitForSelector(queueSelector, { timeout: detectTimeout });
    log('🚦 대기열 팝업 감지됨. 자동 대기 중...');

    // 대기열이 끝날 때까지 반복 확인 (최대 10분)
    for (let i = 0; i < 600; i++) {
      await sleep(1000);
      const stillWaiting = await page.locator(queueSelector).count();
      if (stillWaiting === 0) {
        log('✅ 대기열 통과!');
        return;
      }
      if (i % 10 === 0) {
        process.stdout.write(`\r🚦 대기 중... ${i}초 경과   `);
      }
    }
  } catch {
    // 대기열 없음 - 바로 진행
  }
}

// ─────────────────────────────────────────────
// 예매 진입 (전략 A or B 자동 선택)
// ─────────────────────────────────────────────

async function enterReservePage(page, config) {
  // 로그인 후 나타나는 팝업/오버레이 제거
  await sleep(1000);
  await page.evaluate(() => {
    document.querySelectorAll('.full_page_pop, .layer_pop, .dimmed').forEach(el => {
      // 로그인 모달이 아닌 경우만 제거
      if (!el.closest('.login_layer')) el.remove();
    });
  }).catch(() => {});

  const { targetGameDate, openTime } = config;

  // ── 전략 A: 사전 URL 추출 ──────────────────────
  const scheduleId = await extractScheduleId(page, targetGameDate);

  if (scheduleId) {
    const reserveUrl = `${RESERVE_BASE}/${scheduleId}?menuIndex=reserve`;
    log(`🎯 직접 예매 URL로 선접: ${reserveUrl}`);

    // 오픈 30초 전에 미리 페이지 진입 (연결 선점)
    await waitForOpenTime(openTime);

    // 직접 URL 접근 (트래픽 우회)
    await page.goto(reserveUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 페이지가 아직 잠겨있으면 오픈 후 새로고침
    const isLocked = await page.locator('text=예매 가능 시간이 아닙니다, text=오픈 전, text=준비 중').count();
    if (isLocked > 0) {
      log('⏳ 페이지 잠김 상태 → 오픈 후 새로고침...');
      await sleep(500);
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
  } else {
    // ── 전략 B: 스포츠 페이지 폴링 ───────────────
    log('📍 스포츠 페이지 폴링 전략');
    await page.goto(SPORTS_PAGE, { waitUntil: 'domcontentloaded' });
    await waitForOpenTime(openTime);
    await pollAndClickBookingButton(page, targetGameDate);
  }

  // 대기열 처리 (runTicketBot에서 팝업과 병렬 실행)
}

// ─────────────────────────────────────────────
// 폴링 방식 예매하기 클릭 (100ms 간격, 최대 30초)
// ─────────────────────────────────────────────

async function pollAndClickBookingButton(page, targetDate) {
  log('⚡ 예매하기 버튼 폴링 시작...');

  for (let attempt = 0; attempt < 60; attempt++) {
    // 페이지 로드 완료 대기 (새로고침 후 빈 화면 방지)
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});

    // 팝업이 이미 나타났으면 즉시 중단
    const popupVisible = await page.evaluate(() =>
      !!document.querySelector('.common_modal[role="dialog"]')
    ).catch(() => false);
    if (popupVisible) {
      log(`✅ 예매하기 성공 → 팝업 감지 (${attempt + 1}번째 시도)`);
      break;
    }

    try {
      const btn = page.locator('li, tr')
        .filter({ hasText: targetDate })
        .filter({ hasText: VENUE_NAME })
        .locator('a:has-text("예매하기"), button:has-text("예매하기")')
        .first();

      const visible = await btn.isVisible().catch(() => false);
      if (!visible) {
        log(`   [${attempt + 1}] 버튼 없음 → 새로고침`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        continue;
      }

      const disabled = await btn.isDisabled().catch(() => false);
      const text = await btn.textContent().catch(() => '');
      if (disabled || text.includes('오픈') || text.includes('예정')) {
        log(`   [${attempt + 1}] 버튼 비활성 → 새로고침`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        continue;
      }

      await btn.scrollIntoViewIfNeeded();
      const box = await btn.boundingBox().catch(() => null);
      if (!box) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}); continue; }

      log(`   [${attempt + 1}] 예매하기 버튼 활성 → 클릭`);
      await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 + 40);
      await sleep(40);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
      await sleep(60);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      const appeared = await page.waitForSelector('.common_modal[role="dialog"]', { timeout: 3000 })
        .then(() => true).catch(() => false);
      if (appeared) {
        log(`✅ 예매하기 클릭 성공 (${attempt + 1}번째 시도) → 팝업 감지`);
        break;
      }
      // 팝업 미감지 → 재시도
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    } catch {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    }
  }

  await handleConfirmPopup(page, '예매안내', 10000);
}

// ─────────────────────────────────────────────
// 팝업 확인 버튼 공통 처리
// ─────────────────────────────────────────────

async function handleConfirmPopup(page, label = '', timeout = 10000) {
  log(`📋 팝업 처리 대기${label ? ` [${label}]` : ''}...`);
  const deadline = Date.now() + timeout;
  let clickCount = 0;

  while (Date.now() < deadline) {
    try {
      // button/a 우선 탐색 → span/div 폴백
      const btnInfo = await page.evaluate(() => {
        function getMaxZ(el) {
          let maxZ = 0;
          let p = el;
          while (p) {
            const z = parseInt(getComputedStyle(p).zIndex);
            if (!isNaN(z) && z > maxZ) maxZ = z;
            p = p.parentElement;
          }
          return maxZ;
        }
        // 1순위: footer 버튼  2순위: button/a  3순위: span/div
        for (const sel of ['.common_modal_footer button, .common_modal_footer a', 'button, a', 'span, div, p, li']) {
          let best = null;
          let bestZ = -1;
          for (const el of document.querySelectorAll(sel)) {
            if (el.textContent?.trim() !== '확인') continue;
            if (!el.offsetParent) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) continue;
            if (rect.y < 0 || rect.y + rect.height > window.innerHeight) continue;
            const z = getMaxZ(el);
            if (best === null || z > bestZ) {
              bestZ = z;
              best = {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                z,
                tag: el.tagName,
                cls: typeof el.className === 'string' ? el.className : '',
              };
            }
          }
          if (best) return best;
        }
        return null;
      }).catch(() => null);

      if (btnInfo) {
        if (clickCount === 0) {
          log(`🔍 확인 버튼: ${btnInfo.tag}.${btnInfo.cls} z=${btnInfo.z} @ (${Math.round(btnInfo.x)},${Math.round(btnInfo.y)})`);
        }
        // 자연스러운 마우스 이동 후 클릭
        await page.mouse.move(btnInfo.x - 80, btnInfo.y + 20);
        await sleep(30);
        await page.mouse.move(btnInfo.x, btnInfo.y, { steps: 8 });
        await sleep(50);
        await page.mouse.click(btnInfo.x, btnInfo.y);
        clickCount++;
        await sleep(500);
        // 팝업이 사라졌는지 확인 (페이지 이동 포함)
        const stillExists = await page.evaluate(() =>
          [...document.querySelectorAll('button, a, span, div, p')]
            .some(el => el.textContent?.trim() === '확인' && el.offsetParent)
        ).catch(() => false);
        if (!stillExists) {
          log(`✅ 팝업 확인 클릭 완료${label ? ` [${label}]` : ''}`);
          return;
        }
        if (clickCount >= 3) {
          log(`⚠️  확인 ${clickCount}회 클릭 후 팝업 유지 → 강제 진행`);
          return;
        }
      }
    } catch { /* 무시 */ }
    await sleep(50);
  }
  log(`⚠️  팝업 처리 실패${label ? ` [${label}]` : ''}: timeout`);
}

// ─────────────────────────────────────────────
// 보안문자(클린예매) 대기
// ─────────────────────────────────────────────

async function waitForCaptchaDone(page) {
  const deadline = Date.now() + 120000; // 최대 2분
  let lastProgressLog = Date.now();
  let captchaLogged = false;

  log('🔍 보안문자/좌석화면 대기 중...');

  while (Date.now() < deadline) {
    try {
      // 5초마다 현재 URL 진행상황 로그
      if (Date.now() - lastProgressLog > 5000) {
        const url = page.url();
        log(`   → 현재 URL: ${url.split('?')[0].split('/').slice(-2).join('/')}`);
        lastProgressLog = Date.now();
      }

      // ① 좌석선택 화면 먼저 체크 (보안문자보다 우선순위)
      const onSeatPage = await page.evaluate(() => {
        const txt = document.body?.innerText || '';
        if (txt.includes('내야지정석') || txt.includes('잔디석') || txt.includes('응원단석')) return true;
        if (document.querySelector('[class*="grade"],[class*="Grade"],[class*="seat_grade"],[class*="seatGrade"]')) return true;
        // 큰 SVG = 좌석 지도
        const svgs = document.querySelectorAll('svg');
        for (const svg of svgs) {
          const r = svg.getBoundingClientRect();
          if (r.width > 100 && r.height > 100) return true;
        }
        return false;
      }).catch(() => false);

      if (onSeatPage) {
        log('✅ 좌석선택 화면 진입 확인');
        return;
      }

      // ② 보안문자 감지 (캡차 이미지/입력란 기반)
      const hasCaptcha = await page.evaluate(() => {
        const txt = document.body?.innerText || '';
        if (txt.includes('보안문자')) return true;
        return !!(
          document.querySelector('img[src*="captcha"]') ||
          document.querySelector('[class*="captcha"], [id*="captcha"]') ||
          document.querySelector('input[placeholder*="보안문자"], input[placeholder*="문자"]')
        );
      }).catch(() => false);

      if (hasCaptcha) {
        if (!captchaLogged) {
          log('🔒 보안문자 감지 → 직접 입력 후 확인 버튼 클릭해주세요.');
          captchaLogged = true;
        }
      } else if (captchaLogged) {
        log('✅ 보안문자 통과');
        await sleep(800);
        return;
      }
    } catch { /* 무시 */ }

    await sleep(300);
  }
  log('⚠️  보안문자/좌석화면 감지 실패 → 그대로 진행');
}

// ─────────────────────────────────────────────
// 등급 패널에서 목표 등급 클릭
// ─────────────────────────────────────────────

// 등급 클릭 — 'ok': 성공 / 'zero_seats': 0석 / 'insufficient_seats': 잔여<필요 / 'not_found': 목록에 없음
async function clickTargetGradeInPanel(page, targetGrade, needed) {
  log(`🎫 등급 선택: "${targetGrade}"`);

  const gradeItems = page.locator(
    'li, [class*="grade_item"], [class*="gradeItem"], [class*="grade-item"], ' +
    '[class*="seat_grade"], [class*="seatGrade"], [class*="grade_list"] > *, [class*="gradeList"] > *'
  );
  const count = await gradeItems.count();

  for (let i = 0; i < count; i++) {
    const item = gradeItems.nth(i);
    const text = await item.textContent().catch(() => '');
    if (!text.includes(targetGrade)) continue;

    const seatMatch = text.match(/(\d+)\s*석/);
    const seatCount = seatMatch ? parseInt(seatMatch[1]) : -1;
    if (seatCount === 0) {
      log(`   ❌ "${targetGrade}" 잔여석 0석 (매진)`);
      return 'zero_seats';
    }
    if (seatCount > 0 && seatCount < needed) {
      log(`   ❌ "${targetGrade}" 잔여 ${seatCount}석 < 필요 ${needed}장 → 부족`);
      return 'insufficient_seats';
    }

    await item.click();
    log(`   ✅ "${targetGrade}" 클릭 (잔여: ${seatCount >= 0 ? seatCount + '석' : '확인불가'})`);
    await sleep(600);
    return 'ok';
  }

  log(`   ❌ "${targetGrade}" 등급이 패널 목록에 없음`);
  return 'not_found';
}

// ─────────────────────────────────────────────
// 하위 구역 선택
// ─────────────────────────────────────────────

async function selectBestSubSection(page, ticketCount) {
  await sleep(800);

  // 텍스트 패턴으로 구역 목록 탐색: "407구역 1석", "밤켈존 3석", "500구역 12석" 등
  const sectionData = await page.evaluate(() => {
    const result = [];
    const seen = new Set();
    const pattern = /^(\d+구역|[가-힣0-9]+존(?:\s*\d+구역)?)\s*(\d+)\s*석$/;

    for (const el of document.querySelectorAll('li, div, span')) {
      if (el.children.length > 5) continue; // 컨테이너는 스킵
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const m = txt.match(pattern);
      if (!m) continue;
      const name = m[1].trim();
      if (seen.has(name)) continue;
      seen.add(name);
      const count = parseInt(m[2]);
      if (count <= 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 8 || rect.width > 600) continue;
      result.push({ name, count, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }
    return result;
  });

  if (sectionData.length === 0) {
    log('⚠️  구역 목록 없음 → 좌석 직접 클릭으로 진행');
    return;
  }

  log(`📍 구역 목록: ${sectionData.slice(0, 8).map(s => `${s.name}(${s.count}석)`).join(', ')}`);

  const eligible = sectionData.filter(s => s.count >= ticketCount);
  const best = (eligible.length > 0 ? eligible : sectionData)
    .reduce((a, b) => (a.count >= b.count ? a : b));

  log(`   → "${best.name}" 선택 (${best.count}석 가용)`);
  await page.mouse.click(best.x, best.y);
  await sleep(1500);

  // 지도 새로고침 버튼 2회 클릭 (좌석 색상 강제 렌더링)
  const refreshed = await page.evaluate(() => {
    // 1순위: class/title에 reset·refresh·rotate 포함 버튼
    const byClass = document.querySelector(
      'button[class*="reset"], button[class*="refresh"], button[class*="reload"], button[class*="rotate"], ' +
      'button[title*="새로고침"], button[aria-label*="새로고침"], button[aria-label*="reset"]'
    );
    if (byClass) {
      const r = byClass.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    // 2순위: 텍스트 없는 작은 아이콘 버튼 중 화면 왼쪽(지도 영역) 마지막 버튼
    const iconBtns = Array.from(document.querySelectorAll('button')).filter(b => {
      const txt = (b.innerText || '').trim();
      if (txt.length > 2) return false; // 텍스트 버튼 제외
      const r = b.getBoundingClientRect();
      return r.width >= 20 && r.width <= 80 && r.height >= 20 && r.height <= 80
             && r.top > 150 && r.left < window.innerWidth * 0.78;
    });

    if (iconBtns.length > 0) {
      const btn = iconBtns[iconBtns.length - 1]; // 마지막 = 새로고침
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return false;
  });

  if (refreshed) {
    log('   🔄 지도 새로고침 1회...');
    await page.mouse.click(refreshed.x, refreshed.y);
    await sleep(1200);
    log('   🔄 지도 새로고침 2회...');
    await page.mouse.click(refreshed.x, refreshed.y);
    await sleep(1200);
  } else {
    log('   ⚠️  새로고침 버튼 미감지 → 스킵');
  }

  await sleep(800);
}

// ─────────────────────────────────────────────
// 좌석 유형 선택 팝업 처리
// ─────────────────────────────────────────────

async function handleSeatTypePopup(page, targetGrade) {
  try {
    await page.waitForSelector('text=좌석 유형 선택', { timeout: 3000 });
    log('📋 좌석 유형 선택 팝업 처리...');

    const sections = page.locator('[class*="type-item"], [class*="seat-type"], .modal li, [role="dialog"] li');
    const count = await sections.count();

    for (let i = 0; i < count; i++) {
      const sec = sections.nth(i);
      const text = await sec.textContent().catch(() => '');
      if (text.includes(targetGrade) || (targetGrade.includes('잔디') && text.includes('잔디'))) {
        const btn = sec.locator('button:has-text("직접선택")');
        if (await btn.count() > 0) {
          await btn.click();
          log(`✅ "${targetGrade}" 직접선택 클릭`);
          await sleep(500);
          return;
        }
      }
    }

    const allDirect = page.locator('button:has-text("직접선택")');
    const btnCount = await allDirect.count();
    await allDirect.nth(btnCount - 1).click();
    await sleep(500);
  } catch { /* 팝업 없음 */ }
}

// ─────────────────────────────────────────────
// 사용 가능한 좌석 N장 클릭
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// 스크린샷 기반 색상 좌석 좌표 탐색
// (pyautogui screenshot 방식과 동일 원리)
// ─────────────────────────────────────────────

async function findSeatsByScreenshot(page, needed, { relaxed = false } = {}) {
  // 스크린샷 (PNG Buffer)
  const buf = await page.screenshot({ type: 'png' });
  const png = PNG.sync.read(buf);
  const { width: W, height: H, data: d } = png;

  // viewport 기준 좌표 = 픽셀 좌표 / devicePixelRatio
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);

  // relaxed 모드: 범위 확대 + 채도 임계값 완화 (색상미감지 재시도용)
  const xMin = Math.floor(W * 0.05);
  const xMax = Math.floor(W * (relaxed ? 0.80 : 0.72));
  const yMin = Math.floor(H * (relaxed ? 0.35 : 0.45));
  const yMax = Math.floor(H * (relaxed ? 0.88 : 0.80));
  const SAT_THRESHOLD = relaxed ? 18 : 35;

  const colored = [];
  const STEP = 2;

  for (let py = yMin; py < yMax; py += STEP) {
    for (let px = xMin; px < xMax; px += STEP) {
      const i = (py * W + px) * 4;
      const r = d[i], g = d[i+1], b = d[i+2], a = d[i+3];
      if (a < 200) continue;
      if (r > 210 && g > 210 && b > 210) continue;            // 흰색 배경 제외
      if (r < 25 && g < 25 && b < 25) continue;               // 검정 제외
      if (r > 220 && g > 140) continue;                       // 밝은 주황/노랑 UI 버튼 제외
      const sat = Math.max(r,g,b) - Math.min(r,g,b);
      if (sat < SAT_THRESHOLD) continue;
      colored.push({ px, py });
    }
  }

  log(`   📸 스캔범위 x[${xMin}~${xMax}] y[${yMin}~${yMax}] 픽셀${W}x${H} dpr=${dpr} sat>=${SAT_THRESHOLD} 색상픽셀=${colored.length}${relaxed ? ' [완화모드]' : ''}`);

  if (colored.length === 0) {
    return [];
  }

  // 클러스터링: 가까운 픽셀 그룹 → 각 그룹 중심 = 좌석 1개
  const GAP = Math.round(14 * dpr);
  const clusters = [];

  for (const { px, py } of colored) {
    const existing = clusters.find(c => Math.abs(c.cx - px) < GAP && Math.abs(c.cy - py) < GAP);
    if (existing) {
      existing.sumX += px; existing.sumY += py; existing.n++;
      existing.cx = existing.sumX / existing.n;
      existing.cy = existing.sumY / existing.n;
    } else {
      clusters.push({ cx: px, cy: py, sumX: px, sumY: py, n: 1 });
    }
  }

  if (clusters.length === 0) return [];

  // 클러스터 필터링:
  // - n < 3: 노이즈
  // - n > 100: 너무 큰 덩어리 = 구역 헤더/경계선 (실제 좌석 한 칸은 n=5~80)
  // - cy < yMin+30: 스캔 상단 경계 근처 = 구역 경계선 (가장 상단 채색 영역)
  const EDGE_MARGIN = 30;
  const validClusters = clusters.filter(c => c.n >= 3 && c.n <= 100 && c.cy >= yMin + EDGE_MARGIN);
  const fallback = clusters.filter(c => c.n >= 3 && c.cy >= yMin + EDGE_MARGIN);
  const fallback2 = clusters.filter(c => c.n >= 3);

  const pool = validClusters.length > 0 ? validClusters
             : fallback.length > 0 ? fallback
             : fallback2;

  log(`   📸 전체클러스터=${clusters.length} 유효=${validClusters.length} 폴백=${fallback.length}`);

  // y 오름차순 정렬 (위 → 아래)
  const seats = pool
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx)
    .slice(0, Math.max(needed * 4, 8))
    .map(c => ({ x: Math.round(c.cx / dpr), y: Math.round(c.cy / dpr), n: c.n }));

  log(`   📸 후보: ${seats.slice(0,5).map(s=>`(${s.x},${s.y})n=${s.n}`).join(' ')}`);
  return seats;
}

// 다음단계 버튼 클릭 후 이동 감지 (URL 변화 또는 페이지 내용 변화)
async function clickNextStep(page, urlBefore, shotIndex) {
  const home = require('os').homedir();

  const nextBtn = page.locator('button:has-text("다음단계"), a:has-text("다음단계")').first();
  if (!await nextBtn.isVisible().catch(() => false)) {
    log('   ⚠️  다음단계 버튼 안 보임');
    return false;
  }

  // 클릭 전 선택 좌석 상태 로그
  const stateBefore = await page.evaluate(() => {
    const txt = document.body?.innerText || '';
    const m = txt.match(/선택된\s*좌석[^\n]*/);
    return m ? m[0].trim() : '(좌석정보없음)';
  }).catch(() => '?');
  log(`   📋 클릭 전 상태: ${stateBefore}`);

  const box = await nextBtn.boundingBox().catch(() => null);
  const cx = box ? Math.round(box.x + box.width / 2) : 0;
  const cy = box ? Math.round(box.y + box.height / 2) : 0;
  log(`   ▶ 다음단계 클릭 @ (${cx}, ${cy})`);

  if (box) {
    await page.mouse.move(cx, cy, { steps: 5 });
    await sleep(100);
    await page.mouse.click(cx, cy);
  } else {
    await nextBtn.click();
  }

  // 클릭 직후 600ms 후 스크린샷 → 무슨 일이 일어나는지 확인
  await sleep(600);
  const shotPath = `${home}/Desktop/next-step-${shotIndex ?? 0}.png`;
  await page.screenshot({ path: shotPath }).catch(() => {});
  log(`   📸 클릭 후 스크린샷 → ${shotPath}`);

  // 모달/팝업 자동 처리 (DOM 기반 확인창, 경고창 등)
  const popupHandled = await page.evaluate(() => {
    const txt = document.body?.innerText || '';
    // 이미 다음 단계로 이동했으면 팝업 처리 불필요
    if (txt.includes('권종') || txt.includes('배송') || txt.includes('결제수단')) return 'navigated';

    // 모달/팝업 버튼 탐색: 확인 / 네 / 선택완료 / 직접선택
    const candidates = Array.from(document.querySelectorAll('button, a[role="button"]'));
    const confirmLabels = ['확인', '네', '선택완료', '직접선택', '계속하기', '진행', 'OK'];
    for (const btn of candidates) {
      const label = btn.innerText?.trim() || '';
      if (confirmLabels.some(l => label === l || label.includes(l))) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && !btn.disabled) {
          btn.click();
          return `popup:${label}`;
        }
      }
    }
    return null;
  }).catch(() => null);

  if (popupHandled) log(`   🔔 팝업 처리: ${popupHandled}`);

  if (popupHandled === 'navigated') return true;
  if (popupHandled && popupHandled.startsWith('popup:')) await sleep(800);

  // 이동 감지: URL 변화 OR 페이지 내용 변화
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    if (page.url() !== urlBefore) {
      log(`   ✅ URL 변화 감지 → ${page.url().split('/').slice(-2).join('/')}`);
      return true;
    }
    const moved = await page.evaluate(() => {
      const txt = document.body?.innerText || '';
      return txt.includes('권종') || txt.includes('배송') || txt.includes('결제수단');
    }).catch(() => false);
    if (moved) { log('   ✅ 페이지 내용 변화 감지 (권종/배송)'); return true; }
    // 새 탭 확인
    const newTab = page.context().pages().find(p => p !== page && !p.isClosed());
    if (newTab && newTab.url() !== 'about:blank') {
      log(`   📄 새 탭 감지 → ${newTab.url().split('?')[0].split('/').slice(-2).join('/')}`);
      return true;
    }
    // 팝업이 새로 생겼으면 한번 더 처리
    if (i === 2) {
      const retry = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a[role="button"]'));
        for (const btn of btns) {
          const label = btn.innerText?.trim() || '';
          if (['확인', '네', '선택완료'].some(l => label === l)) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && !btn.disabled) { btn.click(); return label; }
          }
        }
        return null;
      }).catch(() => null);
      if (retry) log(`   🔔 추가 팝업 처리: ${retry}`);
    }
  }
  return false;
}

async function clickAvailableSeats(page, ticketCount) {
  log(`🪑 좌석 ${ticketCount}장 선택 중...`);
  const home = require('os').homedir();
  const urlBefore = page.url();

  // 클릭 전 스크린샷
  await page.screenshot({ path: `${home}/Desktop/seat-before.png` }).catch(() => {});

  // 좌석 탐색 — 실패 시 최대 3회 재시도 (canvas 렌더링 지연 대응)
  let candidates = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const relaxed = attempt >= 2; // 3번째 시도는 완화 모드
    if (attempt > 0) {
      log(`   ⏳ canvas 렌더링 대기 후 재탐색 (${attempt + 1}/3)${relaxed ? ' [완화모드]' : ''}...`);
      await sleep(2000);
    }
    candidates = await findSeatsByScreenshot(page, ticketCount * 3, { relaxed });
    if (candidates.length > 0) break;

    // 디버그용 스크린샷 저장
    await page.screenshot({ path: `${home}/Desktop/no-candidates-${attempt + 1}.png` }).catch(() => {});
  }

  if (candidates.length === 0) {
    log('   ❌ 좌석 후보 없음 — 3회 재시도 모두 실패 (색상미감지)');
    log(`   💡 ~/Desktop/no-candidates-*.png 확인 후 구역 색상이 맞는지 검토하세요`);
    return 'no_candidates';
  }
  log(`   후보: ${candidates.slice(0, 8).map(s => `(${s.x},${s.y})n=${s.n}`).join(' ')}`);

  // ① ticketCount 만큼 좌석 클릭 (한 번에)
  //    이후 다음단계 버튼만 반복 시도 — 절대 추가 좌석을 클릭하지 않음
  let clicked = 0;
  for (let ci = 0; ci < candidates.length && clicked < ticketCount; ci++) {
    const { x, y, n } = candidates[ci];
    log(`   🪑 좌석 클릭 ${clicked + 1}/${ticketCount} @ (${x}, ${y}) n=${n}`);
    await page.mouse.click(x, y);
    await sleep(1200);
    clicked++;
  }

  // 좌석 클릭 후 상태 스크린샷
  await page.screenshot({ path: `${home}/Desktop/seat-clicked.png` }).catch(() => {});

  // 선택 상태 확인
  const selInfo = await page.evaluate(() => {
    const txt = document.body?.innerText || '';
    const m = txt.match(/선택된\s*좌석[^\n]*/);
    return m ? m[0].trim() : null;
  }).catch(() => null);
  log(`   📋 선택 상태: ${selInfo ?? '(정보없음)'}`);

  // ② 다음단계를 최대 8회 시도 — 좌석 추가 클릭 없이
  for (let retry = 0; retry < 8; retry++) {
    if (retry > 0) await sleep(1000);
    const ok = await clickNextStep(page, urlBefore, retry);
    if (ok) {
      await page.screenshot({ path: `${home}/Desktop/seat-after.png` }).catch(() => {});
      log(`   ✅ 다음단계 이동 성공!`);
      return true;
    }
    log(`   ↩️  다음단계 이동 실패 (${retry + 1}/8)`);
  }

  await page.screenshot({ path: `${home}/Desktop/seat-after.png` }).catch(() => {});
  log('   ❌ 좌석 클릭했으나 다음단계 이동 실패 (다음단계 버튼 응답 없음)');
  return 'next_step_failed';
}

// ─────────────────────────────────────────────
// 전체 좌석 선택 플로우
// ─────────────────────────────────────────────

// 단일 등급 시도 — 'success' | 'zero_seats' | 'insufficient_seats' | 'not_found' | 'no_candidates' | 'next_step_failed'
async function trySelectGrade(page, grade, count) {
  const gradeResult = await clickTargetGradeInPanel(page, grade, count);
  if (gradeResult !== 'ok') return gradeResult;

  await selectBestSubSection(page, count);
  await handleSeatTypePopup(page, grade);
  const seatResult = await clickAvailableSeats(page, count);
  return seatResult === true ? 'success' : seatResult;
}

const FAIL_REASON = {
  zero_seats:         '잔여석 0 (매진)',
  insufficient_seats: '잔여석 부족 (필요 장수 미달)',
  not_found:          '등급 패널에 없음',
  no_candidates:    '좌석 색상 미감지',
  next_step_failed: '다음단계 이동 실패',
};

async function selectSeat(page, config) {
  // 등급 목록·좌석도가 렌더링될 때까지 대기 (최대 40초)
  await page.waitForFunction(() => {
    const txt = document.body?.innerText || '';
    if (txt.includes('내야지정석') || txt.includes('잔디석') || txt.includes('응원단석')) return true;
    if (document.querySelector('[class*="grade"],[class*="Grade"],[class*="seat_grade"],[class*="seatGrade"]')) return true;
    if (document.querySelector('svg, canvas')) return true;
    return false;
  }, null, { timeout: 40000 }).catch(() => log('⚠️  좌석화면 로드 대기 timeout → 그대로 진행'));
  log('🗺️  좌석 선택 화면 로드 완료');
  await sleep(1000);

  // 1순위 + 폴백 순서대로 시도
  const gradeQueue = [
    { grade: config.targetGrade, count: config.ticketCount },
    ...(config.fallbackGrades || []),
  ];

  if (gradeQueue.length === 1) {
    log('   ℹ️  폴백 없음 (TICKETBOT_FALLBACK_GRADES 미설정)');
  }

  const results = [];

  for (let i = 0; i < gradeQueue.length; i++) {
    const { grade, count } = gradeQueue[i];
    const label = `${i + 1}순위`;
    log(`\n🎯 [${label}] "${grade}" ${count}장 시도`);
    const reason = await trySelectGrade(page, grade, count);
    results.push({ label, grade, count, reason });

    if (reason === 'success') {
      log('🎉 좌석 선택 & 다음단계 완료!');
      return;
    }

    const reasonText = FAIL_REASON[reason] || reason;
    log(`   → [${label}] 실패: ${reasonText}`);
    if (i < gradeQueue.length - 1) {
      log(`   → 다음 순위로 전환...`);
      await sleep(500);
    }
  }

  // 최종 실패 요약
  log('\n─────────────────────────────');
  log('⚠️  모든 순위 실패 요약:');
  results.forEach(({ label, grade, count, reason }) => {
    log(`   ${label}: "${grade}" ${count}장 → ${FAIL_REASON[reason] || reason}`);
  });
  log('─────────────────────────────');
  log('직접 브라우저에서 좌석 선택 후 다음단계를 눌러주세요.');
}

// ─────────────────────────────────────────────
// 좌석 선택 이후 단계: 권종 → 배송 → 결제수단
// ─────────────────────────────────────────────

async function handlePostSeatFlow(page) {
  const home = require('os').homedir();

  // 결제 페이지 도달까지 다음단계 버튼만 반복 클릭 (최대 5회)
  for (let step = 0; step < 5; step++) {
    await sleep(1500);

    const isPayment = await page.evaluate(() => {
      const txt = document.body?.innerText || '';
      return txt.includes('결제수단') || txt.includes('신용카드') || txt.includes('카카오페이') || txt.includes('결제하기');
    }).catch(() => false);

    if (isPayment) {
      log('\n💳 결제 페이지 도달!');
      await page.screenshot({ path: `${home}/Desktop/payment-page.png` }).catch(() => {});
      log('   📸 ~/Desktop/payment-page.png 저장');
      log('   ✋ 결제수단 선택 & 결제는 직접 진행해주세요.');
      return;
    }

    const nextBtn = page.locator('button:has-text("다음단계"), a:has-text("다음단계")').first();
    if (!await nextBtn.isVisible().catch(() => false)) break;

    const urlBefore = page.url();
    await nextBtn.click();
    log(`   ▶ 다음단계 클릭 (${step + 1}단계)`);

    // URL 또는 내용 변화 대기
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      if (page.url() !== urlBefore) break;
    }
  }

  log('\n⚠️  결제 페이지 미감지 — 직접 이어서 진행해주세요.');
}

// ─────────────────────────────────────────────
// 메인 진입점
// ─────────────────────────────────────────────

async function runTicketBot(config) {
  const chromePath = getChromePath();
  const headless = !IS_MAC;
  log(`🌐 Chrome 실행... (${IS_MAC ? 'Mac' : '클라우드'} / ${headless ? 'headless' : 'headed'})`);

  const browser = await chromium.launch({
    headless,
    executablePath: chromePath,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      ...(headless ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    ],
    ignoreDefaultArgs: [
      '--enable-automation',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-popup-blocking',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.alert = () => {};
    window.confirm = () => true;
  });

  let page = await context.newPage();

  page.on('dialog', async (dialog) => {
    try { await dialog.accept(); } catch { /* ignore */ }
  });

  // FlashBanner 광고만 차단 (예매 관련 팝업은 허용)
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('FlashBanner')) {
      route.abort();
    } else {
      route.continue();
    }
  });

  try {
    await login(page, config);
    await enterReservePage(page, config); // 예매안내 팝업 처리 포함

    // 새 탭으로 예매 페이지가 열렸는지 확인 (팝업 확인 클릭 후 최대 5초 대기)
    for (let i = 0; i < 10; i++) {
      const reserveTab = context.pages().find(p => p.url().includes('/reserve/'));
      if (reserveTab) {
        if (reserveTab !== page) {
          log(`📄 예매 탭 감지 → 전환`);
          page = reserveTab;
        }
        break;
      }
      await sleep(500);
    }
    log(`📍 예매 탭 URL: ${page.url()}`);

    // 대기열 처리
    await handleQueueIfAppears(page, 5000);
    await waitForCaptchaDone(page);
    await selectSeat(page, config);
    await handlePostSeatFlow(page);
  } catch (err) {
    log(`❌ 오류: ${err.message}`);
    log('   브라우저는 열어둡니다. 수동으로 이어서 진행해주세요.');
  }
}

module.exports = { runTicketBot };
