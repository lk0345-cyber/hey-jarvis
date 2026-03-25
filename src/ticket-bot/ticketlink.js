'use strict';

const { chromium } = require('patchright');
const fs = require('fs');

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

  // 새 기기 인증 (팝업에서)
  try {
    await paycoPopup.waitForSelector('text=새로운 기기', { timeout: 6000 });
    log('📲 새 기기 인증 입력...');
    await paycoPopup.locator('input[placeholder*="인증"], input[type="number"], input[maxlength="8"]').fill(
      config.verificationCode
    );
    await paycoPopup.locator('button:has-text("확인")').click();
  } catch { /* 인증 없음 */ }

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

async function waitForOpenTime(openTimeStr) {
  if (openTimeStr === 'now') {
    log('⚡ 즉시 예매 모드 — 대기 없이 바로 진행');
    return;
  }

  const now = new Date();
  const [h, m, s] = openTimeStr.split(':').map(Number);
  const target = new Date(now);
  target.setHours(h, m, s, 0);

  const waitMs = target.getTime() - now.getTime();
  if (waitMs <= 0) {
    log('⚡ 오픈 시간이 이미 지났습니다. 바로 진행합니다.');
    return;
  }

  log(`⏱  오픈까지 ${Math.round(waitMs / 1000)}초 대기 (목표: ${openTimeStr})`);

  if (waitMs > 31000) await sleep(waitMs - 30000);

  let remaining = Math.min(waitMs, 30000);
  while (remaining > 1000) {
    process.stdout.write(`\r⏱  ${Math.round(remaining / 1000)}초 남음...   `);
    await sleep(1000);
    remaining -= 1000;
  }
  await sleep(remaining);
  process.stdout.write('\r');
  log('🚀 오픈 시간! 예매 시작!');
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
  log('⚡ 예매하기 버튼 폴링 시작 (100ms 간격)...');

  for (let attempt = 0; attempt < 300; attempt++) {
    // 팝업이 이미 나타났으면 즉시 중단 (이전 클릭이 성공한 것)
    const popupVisible = await page.evaluate(() =>
      !!document.querySelector('.common_modal[role="dialog"]')
    ).catch(() => false);
    if (popupVisible) {
      log(`✅ 예매하기 성공 → 팝업 감지 (총 ${attempt}번 시도)`);
      break;
    }

    if (attempt > 0 && attempt % 10 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    try {
      // 날짜·장소를 포함한 행에서 예매하기 버튼 탐색
      const btn = page.locator('li, tr')
        .filter({ hasText: targetDate })
        .filter({ hasText: VENUE_NAME })
        .locator('a:has-text("예매하기"), button:has-text("예매하기")')
        .first();

      const visible = await btn.isVisible().catch(() => false);
      if (!visible) { await sleep(100); continue; }

      const disabled = await btn.isDisabled().catch(() => false);
      if (disabled) { await sleep(100); continue; }

      const text = await btn.textContent().catch(() => '');
      if (text.includes('오픈') || text.includes('예정')) { await sleep(100); continue; }

      await btn.scrollIntoViewIfNeeded();
      const box = await btn.boundingBox().catch(() => null);
      if (!box) { await sleep(100); continue; }
      const tx = box.x + box.width / 2;
      const ty = box.y + box.height / 2;

      // 자연스러운 마우스 이동 후 클릭 (mousemove 이벤트 포함)
      await page.mouse.move(tx - 120, ty + 40);
      await sleep(40);
      await page.mouse.move(tx, ty, { steps: 12 });
      await sleep(60);
      await page.mouse.click(tx, ty);

      // 팝업이 나타날 때까지 최대 2초 대기 → 재클릭 방지
      const appeared = await page.waitForSelector('.common_modal[role="dialog"]', { timeout: 2000 })
        .then(() => true).catch(() => false);
      if (appeared) {
        log(`✅ 예매하기 클릭 성공 (${attempt + 1}번째 시도) → 팝업 감지`);
        break;
      }
    } catch {
      await sleep(100);
    }
  }

  // 팝업 처리 (루프 종료 후 단 1회 호출)
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

async function clickTargetGradeInPanel(page, targetGrade) {
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
      log(`⚠️  "${targetGrade}" 현재 0석. 계속 진행...`);
    }

    await item.click();
    log(`✅ "${targetGrade}" 클릭`);
    await sleep(600);
    return;
  }

  throw new Error(`등급 "${targetGrade}"을 목록에서 찾을 수 없습니다.`);
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

async function clickAvailableSeats(page, ticketCount) {
  log(`🪑 사용 가능한 좌석 ${ticketCount}장 선택 중...`);

  // ── 1회만 실행: DOM 구조 디버그 ──
  const dbg = await page.evaluate(() => ({
    iframes:  document.querySelectorAll('iframe').length,
    rects:    document.querySelectorAll('rect').length,
    circles:  document.querySelectorAll('circle').length,
    titles:   document.querySelectorAll('title').length,
    rowTitles: [...document.querySelectorAll('title')].filter(t => t.textContent.includes('열')).length,
    firstRect: (() => {
      for (const el of document.querySelectorAll('rect, circle')) {
        const f = el.getAttribute('fill') || '';
        const r = el.getBoundingClientRect();
        if (r.width > 0) return `fill="${f}" @(${Math.round(r.left)},${Math.round(r.top)}) ${Math.round(r.width)}x${Math.round(r.height)}`;
      }
      return 'none';
    })(),
  })).catch(() => ({}));
  log(`   📊 DOM: iframe=${dbg.iframes}, rect=${dbg.rects}, circle=${dbg.circles}, title(열)=${dbg.rowTitles}/${dbg.titles}`);
  log(`   📊 첫번째요소: ${dbg.firstRect}`);

  // ── 탐색 대상 프레임 결정 (메인 + 모든 iframe) ──
  const allFrames = page.frames();
  if (allFrames.length > 1) log(`   📊 프레임 수: ${allFrames.length} (iframe 존재)`);

  let clicked = 0;

  for (let attempt = 0; attempt < 5 && clicked < ticketCount; attempt++) {
    if (attempt > 0) await sleep(800);

    let seatCoords = [];

    for (const frame of allFrames) {
      if (seatCoords.length > 0) break;

      const found = await frame.evaluate(() => {
        function isUnavailableColor(fill) {
          if (!fill || fill === 'none' || fill === 'transparent') return true;
          const f = fill.toLowerCase().trim();
          if (f === 'white' || f === '#fff' || f === '#ffffff') return true;
          if (/^#[c-f][c-f][c-f]/i.test(f)) return true;
          if (/^#[89ab][89ab][89ab]/i.test(f)) return true;
          const rgb = f.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
          if (rgb && +rgb[1] > 160 && +rgb[2] > 160 && +rgb[3] > 160) return true;
          return false;
        }

        const coords = [];

        // 1순위: SVG <title>에 "열" 포함 = 좌석 메타데이터
        for (const titleEl of document.querySelectorAll('title')) {
          const txt = titleEl.textContent || '';
          if (!txt.includes('열')) continue;
          const seat = titleEl.parentElement;
          if (!seat) continue;
          const r = seat.getBoundingClientRect();
          if (r.width >= 2 && r.width <= 60 && r.height >= 2)
            coords.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, label: txt.trim() });
        }
        if (coords.length > 0) return coords;

        // 2순위: data-* 속성에 좌석 정보
        for (const el of document.querySelectorAll('[data-seatno],[data-seat-no],[data-seat],[data-row],[data-col]')) {
          const r = el.getBoundingClientRect();
          if (r.width >= 2 && r.width <= 60 && r.height >= 2)
            coords.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, label: el.dataset.seatno || '' });
        }
        if (coords.length > 0) return coords;

        // 3순위: 색상 기반 SVG (크기 필터만, 위치는 프레임 내 좌표라 제한 없음)
        for (const el of document.querySelectorAll('rect, circle, path')) {
          if (el.closest('button, a, [role="button"]')) continue;
          const attrFill = el.getAttribute('fill');
          const fill = (attrFill && attrFill !== 'none') ? attrFill : (window.getComputedStyle(el).fill || '');
          if (isUnavailableColor(fill)) continue;
          const cls = ((el.className?.baseVal || el.className) + '').toLowerCase();
          if (cls.includes('disabled') || cls.includes('sold') || cls.includes('bg') || cls.includes('background')) continue;
          const r = el.getBoundingClientRect();
          if (r.width >= 3 && r.width <= 40 && r.height >= 3)
            coords.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, label: '' });
        }
        return coords;
      }).catch(() => []);

      if (found.length === 0) continue;

      // iframe이면 좌표에 iframe 오프셋 추가
      if (frame !== page.mainFrame()) {
        const iframeIdx = allFrames.indexOf(frame);
        const offset = await page.evaluate((idx) => {
          const iframes = document.querySelectorAll('iframe');
          const f = iframes[idx - 1]; // mainFrame이 0번이므로 -1
          if (!f) return { left: 0, top: 0 };
          const r = f.getBoundingClientRect();
          return { left: r.left, top: r.top };
        }, iframeIdx).catch(() => ({ left: 0, top: 0 }));
        log(`   📄 iframe[${iframeIdx}] 좌석 감지, 오프셋 (+${Math.round(offset.left)}, +${Math.round(offset.top)})`);
        seatCoords = found.map(c => ({ x: c.x + offset.left, y: c.y + offset.top, label: c.label }));
      } else {
        seatCoords = found;
      }
    }

    if (seatCoords.length === 0) {
      log(`   ⚠️  좌석 미감지 (${attempt + 1}번째) → 재시도`);
      continue;
    }

    for (const { x, y, label } of seatCoords.slice(0, ticketCount - clicked)) {
      log(`   🪑 좌석 클릭 ${clicked + 1}/${ticketCount} @ (${Math.round(x)}, ${Math.round(y)})${label ? ' [' + label + ']' : ''}`);
      await page.mouse.click(x, y);
      await sleep(600);
      clicked++;
    }
  }

  if (clicked === 0) {
    log('⚠️  자동 좌석 클릭 실패. 직접 선택해주세요.');
  } else {
    log(`✅ 좌석 ${clicked}/${ticketCount}장 선택 완료`);
  }

  await handleConfirmPopup(page, '좌석 확인', 3000);
  await sleep(500);
}

// ─────────────────────────────────────────────
// 전체 좌석 선택 플로우
// ─────────────────────────────────────────────

async function selectSeat(page, config) {
  const { targetGrade, ticketCount } = config;

  // 등급 목록·좌석도가 렌더링될 때까지 대기 (최대 40초)
  // waitForFunction으로 다양한 지표를 동시에 검사
  await page.waitForFunction(() => {
    const txt = document.body?.innerText || '';
    if (txt.includes('내야지정석') || txt.includes('잔디석') || txt.includes('응원단석')) return true;
    if (document.querySelector('[class*="grade"],[class*="Grade"],[class*="seat_grade"],[class*="seatGrade"]')) return true;
    if (document.querySelector('svg, canvas')) return true;
    return false;
  }, null, { timeout: 40000 }).catch(() => log('⚠️  좌석화면 로드 대기 timeout → 그대로 진행'));
  log('🗺️  좌석 선택 화면 로드 완료');
  await sleep(1000);

  await clickTargetGradeInPanel(page, targetGrade);
  await selectBestSubSection(page, ticketCount);
  await handleSeatTypePopup(page, targetGrade);
  await clickAvailableSeats(page, ticketCount);

  // 좌석 선택 여부 확인 (선택된 좌석이 없으면 중단)
  const selectedCount = await page.evaluate(() => {
    const txt = document.body?.innerText || '';
    const m = txt.match(/선택\s*(\d+)\s*석/) || txt.match(/(\d+)\s*석\s*선택/);
    if (m) return parseInt(m[1]);
    // 선택된 좌석 스타일 감지
    return document.querySelectorAll('[class*="selected"], [class*="Selected"], [class*="active-seat"]').length;
  }).catch(() => 0);

  if (selectedCount === 0) {
    log('⚠️  좌석이 선택되지 않았습니다. 직접 좌석을 클릭한 후 다음단계를 눌러주세요.');
    return;
  }

  log('➡️  다음단계 클릭...');
  await page.locator('button:has-text("다음단계"), a:has-text("다음단계")').first().click();
  log('🎉 좌석 선택 완료! 이후 단계(권종/배송/결제)를 진행해주세요.');
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
  } catch (err) {
    log(`❌ 오류: ${err.message}`);
    log('   브라우저는 열어둡니다. 수동으로 이어서 진행해주세요.');
  }
}

module.exports = { runTicketBot };
