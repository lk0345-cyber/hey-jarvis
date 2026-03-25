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

async function handleQueueIfAppears(page) {
  // 대기열 팝업 감지 (최대 3분 대기)
  try {
    const queueSelector = 'text=대기, text=잠시 후, text=접속자가 많아, [class*="queue"], [class*="waiting"]';
    await page.waitForSelector(queueSelector, { timeout: 4000 });
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
    // 매 10회마다 새로고침 (트래픽 고려해 너무 자주 하지 않음)
    if (attempt > 0 && attempt % 10 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    // 버튼 좌표를 추출한 뒤 실제 마우스 이벤트로 클릭 (isTrusted: true → NetFunnel 우회)
    const coords = await page.evaluate(({ venue, date }) => {
      const rows = document.querySelectorAll('li, tr, [class*="schedule"], [class*="item"]');
      for (const row of rows) {
        const text = row.textContent || '';
        if (!text.includes(venue)) continue;
        if (date && !text.includes(date)) continue;

        const btns = row.querySelectorAll('button, a');
        for (const btn of btns) {
          const btnText = btn.textContent?.trim() || '';
          if (!btnText.includes('예매하기')) continue;
          if (btn.disabled || btn.classList.contains('disabled')) continue;
          if (btnText.includes('오픈') || btnText.includes('예정')) continue;
          const rect = btn.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
      return null;
    }, { venue: VENUE_NAME, date: targetDate });

    if (coords) {
      // 실제 마우스 클릭 → isTrusted: true 이벤트 → NetFunnel 세션 정상 초기화
      await Promise.all([
        page.waitForURL('**/reserve/**', { timeout: 10000 }).catch(() => {}),
        page.mouse.click(coords.x, coords.y),
      ]);
      log(`✅ 예매하기 클릭 성공 (${attempt + 1}번째 시도)`);
      return;
    }

    await sleep(100);
  }

  throw new Error('30초 내 예매하기 버튼 활성화 실패');
}

// ─────────────────────────────────────────────
// 팝업 확인 버튼 공통 처리
// ─────────────────────────────────────────────

async function handleConfirmPopup(page, label = '', timeout = 8000) {
  // button, a, span, div 등 태그 불문하고 "확인" 텍스트 요소 탐색
  const sel = ':is(button, a, span, div, input[type="button"]):has-text("확인")';
  try {
    await page.waitForSelector(sel, { timeout });
    const confirmBtn = page.locator(sel);
    const count = await confirmBtn.count();
    if (count > 0) {
      log(`📋 팝업 처리${label ? ` [${label}]` : ''}...`);
      const btn = confirmBtn.last();
      const box = await btn.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await btn.click({ force: true });
      }
      await sleep(600);
      log(`✅ 팝업 확인 클릭 완료${label ? ` [${label}]` : ''}`);
    }
  } catch (e) {
    log(`⚠️  팝업 처리 실패${label ? ` [${label}]` : ''}: ${e.message}`);
  }
}

// ─────────────────────────────────────────────
// 보안문자(클린예매) 대기
// ─────────────────────────────────────────────

async function waitForCaptchaDone(page) {
  // 15초 안에 ① 보안문자(입력완료 버튼) 또는 ② 등급 목록(좌석선택 화면) 중 먼저 등장하는 것으로 분기
  const which = await Promise.race([
    page.waitForSelector('button:has-text("입력완료")', { timeout: 15000 })
      .then(() => 'captcha').catch(() => null),
    page.waitForSelector(
      '[class*="grade-list"], [class*="gradeList"], li:has-text("내야"), li:has-text("잔디"), li:has-text("응원"), .reserve-seat',
      { timeout: 15000 }
    ).then(() => 'seat').catch(() => null),
  ]);

  if (which === 'captcha') {
    log('🔒 보안문자 입력 대기 중...');
    log('   → 화면의 보안문자를 직접 입력하고 [입력완료] 버튼을 눌러주세요.');
    // 입력완료 버튼이 사라질 때까지 300ms 간격으로 폴링 (최대 2분)
    for (let i = 0; i < 400; i++) {
      await sleep(300);
      const still = await page.locator('button:has-text("입력완료")').count().catch(() => 0);
      if (still === 0) break;
    }
    log('✅ 보안문자 통과');
    await sleep(800);
  } else if (which === 'seat') {
    log('✅ 보안문자 없음, 좌석선택 화면 진입');
  } else {
    log('⚠️  보안문자/좌석화면 감지 실패 → 그대로 진행');
  }
}

// ─────────────────────────────────────────────
// 등급 패널에서 목표 등급 클릭
// ─────────────────────────────────────────────

async function clickTargetGradeInPanel(page, targetGrade) {
  log(`🎫 등급 선택: "${targetGrade}"`);

  const gradeItems = page.locator('li, [class*="grade-item"], [class*="seat-grade"]');
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
  await sleep(600);

  const subItems = page.locator(
    '[class*="sub"] li, [class*="section-item"], [class*="zone-item"], li[class*="area"]'
  );
  const count = await subItems.count();
  if (count === 0) return;

  log(`📍 하위 구역 선택 (요청 ${ticketCount}장)...`);

  for (let i = 0; i < count; i++) {
    const item = subItems.nth(i);
    const text = await item.textContent().catch(() => '');
    const seatMatch = text.match(/(\d+)\s*석/);
    const available = seatMatch ? parseInt(seatMatch[1]) : 0;

    if (available >= ticketCount) {
      log(`   → ${text.trim()} 선택`);
      await item.click();
      await sleep(600);
      return;
    }
  }

  // 가장 많은 구역 선택
  let maxCount = 0, maxIdx = 0;
  for (let i = 0; i < count; i++) {
    const text = await subItems.nth(i).textContent().catch(() => '');
    const m = text.match(/(\d+)\s*석/);
    const n = m ? parseInt(m[1]) : 0;
    if (n > maxCount) { maxCount = n; maxIdx = i; }
  }
  log(`⚠️  ${ticketCount}석 이상 구역 없음. 최대(${maxCount}석) 구역 선택`);
  await subItems.nth(maxIdx).click();
  await sleep(600);
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

  let clicked = 0;

  for (let attempt = 0; attempt < 5 && clicked < ticketCount; attempt++) {
    const newClicks = await page.evaluate(({ needed }) => {
      function isUnavailableColor(fill) {
        if (!fill || fill === 'none' || fill === 'transparent') return true;
        const f = fill.toLowerCase().trim();
        return (
          /^#[c-f][c-f][c-f]/i.test(f) ||
          /^#[89ab][89ab][89ab]/i.test(f) ||
          f === 'white' || f === '#fff' || f === '#ffffff'
        );
      }

      const byClass = Array.from(
        document.querySelectorAll('[class*="seat"]:not([class*="disabled"]):not([class*="sold"]):not([class*="empty"])')
      ).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      const bySvg = Array.from(document.querySelectorAll('rect, circle')).filter((el) => {
        const fill = el.getAttribute('fill') || window.getComputedStyle(el).fill;
        if (isUnavailableColor(fill)) return false;
        const cls = (el.className?.baseVal || '').toLowerCase();
        if (cls.includes('disabled') || cls.includes('sold') || cls.includes('bg')) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 4 && r.width <= 30;
      });

      const candidates = byClass.length > 0 ? byClass : bySvg;
      let count = 0;
      for (const el of candidates) {
        if (count >= needed) break;
        el.click();
        count++;
      }
      return count;
    }, { needed: ticketCount - clicked });

    clicked += newClicks;
    if (clicked < ticketCount) await sleep(500);
  }

  if (clicked === 0) {
    log('⚠️  자동 좌석 클릭 실패. 직접 선택해주세요.');
  } else {
    log(`✅ 좌석 ${clicked}/${ticketCount}장 선택 완료`);
  }

  await handleConfirmPopup(page, '좌석 확인');
  await sleep(500);
}

// ─────────────────────────────────────────────
// 전체 좌석 선택 플로우
// ─────────────────────────────────────────────

async function selectSeat(page, config) {
  const { targetGrade, ticketCount } = config;

  await page.waitForSelector(
    'svg, canvas, [class*="seat-map"], [class*="grade"], [class*="등급"]',
    { timeout: 15000 }
  );
  log('🗺️  좌석 선택 화면 로드 완료');
  await sleep(800);

  await clickTargetGradeInPanel(page, targetGrade);
  await selectBestSubSection(page, ticketCount);
  await handleSeatTypePopup(page, targetGrade);
  await handleConfirmPopup(page, '유형 확인');
  await clickAvailableSeats(page, ticketCount);

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

  const page = await context.newPage();

  page.on('dialog', async (dialog) => {
    try { await dialog.accept(); } catch { /* ignore */ }
  });

  // 전면 팝업 배너 리소스 요청 차단 (아예 안 뜨게)
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('FlashBanner') || url.includes('full_page_pop')) {
      route.abort();
    } else {
      route.continue();
    }
  });

  try {
    await login(page, config);
    await enterReservePage(page, config);
    // 대기열 처리와 팝업 확인을 병렬 실행 → 팝업이 뜨는 즉시 클릭
    await Promise.all([
      handleQueueIfAppears(page),
      handleConfirmPopup(page, '예매안내'),
    ]);
    // 대기열이 있었던 경우 대기열 해소 후 팝업이 다시 뜰 수 있으므로 재시도
    await handleConfirmPopup(page, '예매안내(재)', 3000).catch(() => {});
    await waitForCaptchaDone(page);
    await selectSeat(page, config);
  } catch (err) {
    log(`❌ 오류: ${err.message}`);
    log('   브라우저는 열어둡니다. 수동으로 이어서 진행해주세요.');
  }
}

module.exports = { runTicketBot };
