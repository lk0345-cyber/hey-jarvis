'use strict';

const { chromium } = require('playwright');

const SPORTS_PAGE = 'https://www.ticketlink.co.kr/sports/137/63';
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
  log('🔐 티켓링크 접속...');
  await page.goto('https://www.ticketlink.co.kr', { waitUntil: 'domcontentloaded' });

  // 우측 상단 로그인 버튼 클릭
  await page.locator('a[href*="/login"], button:has-text("로그인")').first().click();

  // PAYCO 로그인 버튼
  await page.locator('a[href*="payco"], button[class*="payco"], img[alt*="PAYCO"]').first().click();

  // PAYCO 로그인 페이지 대기
  await page.waitForURL('**/payco.com/**', { timeout: 15000 });
  log('📱 PAYCO 로그인 페이지 진입');

  // 아이디/비밀번호 입력
  await page.waitForSelector('input[name="id"], #idInput', { timeout: 10000 });
  await page.locator('input[name="id"], #idInput').fill(config.paycoId);
  await page.locator('input[name="pw"], input[type="password"]').fill(config.paycoPw);
  await page.locator('.btn_login, button[type="submit"]').first().click();

  // 새 기기 인증 팝업 처리
  try {
    await page.waitForSelector('text=새로운 기기', { timeout: 6000 });
    log('📲 새 기기 인증 입력 중...');
    await page.locator('input[placeholder*="인증"], input[type="number"], input[maxlength="8"]').fill(config.verificationCode);
    await page.locator('button:has-text("확인")').click();
  } catch {
    // 인증 없이 통과
  }

  await page.waitForURL('**/ticketlink.co.kr/**', { timeout: 20000 });
  log('✅ 로그인 완료');
}

// ─────────────────────────────────────────────
// 정시 대기 (밀리초 정밀도)
// ─────────────────────────────────────────────

async function waitForOpenTime(openTimeStr) {
  const now = new Date();
  const [h, m, s] = openTimeStr.split(':').map(Number);
  const target = new Date(now);
  target.setHours(h, m, s, 0);

  const waitMs = target.getTime() - now.getTime();
  if (waitMs <= 0) {
    log('⚠️  오픈 시간이 이미 지났습니다. 바로 진행합니다.');
    return;
  }

  log(`⏱  오픈까지 ${Math.round(waitMs / 1000)}초 대기 중... (목표: ${openTimeStr})`);

  // 30초 전까지 여유 있게 대기
  if (waitMs > 31000) {
    await sleep(waitMs - 30000);
  }

  // 마지막 30초: 1초 단위 카운트다운
  let remaining = Math.min(waitMs, 30000);
  while (remaining > 1000) {
    const secs = Math.round(remaining / 1000);
    process.stdout.write(`\r⏱  ${secs}초 남음...   `);
    await sleep(1000);
    remaining -= 1000;
  }
  await sleep(remaining);
  process.stdout.write('\r');
  log('🚀 오픈 시간! 예매 시작!');
}

// ─────────────────────────────────────────────
// 예매하기 버튼 클릭 (대전 한화생명 볼파크)
// ─────────────────────────────────────────────

async function clickBookingButton(page, targetDate) {
  // 페이지 새로고침으로 최신 상태 반영
  await page.reload({ waitUntil: 'domcontentloaded' });

  log(`🔍 "${VENUE_NAME}" 예매하기 버튼 탐색 중...`);

  // 카드 내 venue 텍스트 찾기
  // 구조: .venue-text → 부모 카드 → 예매하기 버튼
  const venueElements = page.locator(`text=${VENUE_NAME}`);
  const count = await venueElements.count();

  if (count === 0) {
    throw new Error(`"${VENUE_NAME}" 경기를 찾을 수 없습니다.`);
  }

  for (let i = 0; i < count; i++) {
    const venueEl = venueElements.nth(i);
    // 날짜 필터 (설정된 경우)
    if (targetDate) {
      const cardText = await venueEl.locator('..').locator('..').textContent();
      if (!cardText.includes(targetDate)) continue;
    }

    // 해당 카드의 예매하기 버튼 찾기
    const card = venueEl.locator('..').locator('..');
    const btn = card.locator('button:has-text("예매하기"), a:has-text("예매하기")');
    const btnCount = await btn.count();

    if (btnCount > 0) {
      const btnText = await btn.first().textContent();
      if (btnText.includes('예매하기')) {
        log('🎯 예매하기 버튼 클릭!');
        await btn.first().click();
        return;
      }
    }
  }

  throw new Error('활성화된 예매하기 버튼을 찾지 못했습니다.');
}

// ─────────────────────────────────────────────
// 팝업 확인 버튼 처리 (범용)
// ─────────────────────────────────────────────

async function handleConfirmPopup(page, label = '') {
  try {
    await page.waitForSelector('.modal, [role="dialog"], .popup', { timeout: 5000 });
    log(`📋 팝업 처리${label ? ` (${label})` : ''}...`);
    await page.locator('button:has-text("확인")').last().click();
    await sleep(500);
  } catch {
    // 팝업 없음
  }
}

// ─────────────────────────────────────────────
// 클린예매 보안문자 대기
// ─────────────────────────────────────────────

async function waitForCaptchaDone(page) {
  log('🔒 보안문자 대기 중...');
  log('   → 화면의 보안문자를 입력하고 [입력완료] 버튼을 눌러주세요.');

  // 보안문자 모달이 닫히고 좌석맵이 활성화될 때까지 대기
  await page.waitForSelector(
    '.captcha-modal, [class*="clean-book"], [class*="security"]',
    { state: 'hidden', timeout: 120000 }
  ).catch(async () => {
    // 셀렉터가 다를 경우 폴백: 입력완료 버튼이 사라질 때까지
    await page.waitForSelector('button:has-text("입력완료")', {
      state: 'hidden',
      timeout: 120000,
    });
  });

  log('✅ 보안문자 통과');
  await sleep(1000);
}

// ─────────────────────────────────────────────
// 잔디석 선택 → 직접선택 → 좌석 클릭
// ─────────────────────────────────────────────

async function selectSeat(page) {
  // 좌석 맵 로드 대기
  await page.waitForSelector('svg, canvas, [class*="seat-map"], [class*="seatmap"]', {
    timeout: 15000,
  });
  log('🗺️  좌석 맵 로드 완료');
  await sleep(1000);

  // ── Step 1: 잔디석 영역 클릭 ──────────────────
  log('🟢 잔디석 영역 클릭 시도...');

  // 방법 1: 텍스트 레이블로 클릭
  const jandikLabel = page.locator('text=잔디석').first();
  if (await jandikLabel.count() > 0) {
    await jandikLabel.click();
  } else {
    // 방법 2: 좌측 등급 목록에서 잔디석 클릭
    await page.locator('[class*="grade-list"] li:has-text("잔디석"), [class*="legend"]:has-text("잔디석")').first().click();
  }
  await sleep(800);

  // ── Step 2: 좌석 유형 선택 팝업 → 잔디석 직접선택 ──
  log('📋 좌석 유형 선택 팝업 처리...');
  try {
    await page.waitForSelector('text=좌석 유형 선택', { timeout: 5000 });

    // 잔디석 섹션의 직접선택 버튼 (두 번째 버튼 = 잔디석)
    const directBtns = page.locator('button:has-text("직접선택")');
    const btnCount = await directBtns.count();
    // 외야커플석(첫번째) / 잔디석(두번째)
    await directBtns.nth(btnCount > 1 ? 1 : 0).click();
    log('✅ 잔디석 직접선택 클릭');
  } catch {
    // 팝업이 안 떴으면 이미 직접 선택 뷰
  }

  // 확인 팝업
  await handleConfirmPopup(page, '좌석 유형 확인');
  await sleep(800);

  // ── Step 3: 사용 가능한 잔디석 좌석 클릭 ──────────
  log('🪑 사용 가능한 좌석 탐색...');

  const clicked = await page.evaluate(() => {
    // 잔디석 초록색 HEX 범위 (실제 색상에 따라 조정 가능)
    const GREEN_FILLS = ['#4a8a4c', '#5b8c5a', '#4d8b47', '#528a4e', '#3d7a40'];

    function isGreenFill(fill) {
      if (!fill) return false;
      const f = fill.toLowerCase().trim();
      if (GREEN_FILLS.some((g) => f.startsWith(g))) return true;
      // rgb 형태도 처리
      const match = f.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (match) {
        const [, r, g, b] = match.map(Number);
        return g > r + 20 && g > b + 20 && g > 80; // 초록 계열
      }
      return false;
    }

    // SVG rect/circle/path 중 초록색이고 클릭 가능한 것
    const candidates = [
      ...document.querySelectorAll('rect, circle, path, [class*="seat"]'),
    ];

    for (const el of candidates) {
      const fill =
        el.getAttribute('fill') ||
        el.getAttribute('data-color') ||
        window.getComputedStyle(el).fill;

      // 클릭 불가 요소 스킵
      const cls = el.className?.toString() || '';
      if (cls.includes('disabled') || cls.includes('sold') || cls.includes('empty')) continue;

      if (isGreenFill(fill)) {
        el.click();
        return true;
      }
    }

    // Fallback: class에 available 포함된 잔디석 좌석
    const available = document.querySelector(
      '[class*="available"][class*="grass"], [class*="seat-on"][data-grade*="잔디"], [data-available="true"]'
    );
    if (available) {
      available.click();
      return true;
    }

    return false;
  });

  if (!clicked) {
    log('⚠️  자동 좌석 클릭 실패. 직접 좌석을 선택해주세요.');
  } else {
    log('✅ 좌석 클릭 완료');
  }

  // 좌석 선택 후 팝업 처리
  await handleConfirmPopup(page, '좌석 확인');
  await sleep(500);

  // ── Step 4: 다음단계 클릭 ──────────────────────
  log('➡️  다음단계 클릭...');
  await page.locator('button:has-text("다음단계"), a:has-text("다음단계")').first().click();
  log('🎉 좌석 선택 완료! 이후 단계(권종/배송/결제)를 진행해주세요.');
}

// ─────────────────────────────────────────────
// 메인 진입점
// ─────────────────────────────────────────────

async function runTicketBot(config) {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 80,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  try {
    // 1. 로그인
    await login(page, config);

    // 2. 스포츠 페이지 이동 후 오픈 대기
    log(`📍 ${SPORTS_PAGE} 이동...`);
    await page.goto(SPORTS_PAGE, { waitUntil: 'domcontentloaded' });

    await waitForOpenTime(config.openTime);

    // 3. 예매하기 클릭
    await clickBookingButton(page, config.targetGameDate);

    // 4. 예매안내 팝업 확인
    await handleConfirmPopup(page, '예매안내');

    // 5. 보안문자 대기 (사용자 직접 입력)
    await waitForCaptchaDone(page);

    // 6. 잔디석 선택 → 다음단계
    await selectSeat(page);
  } catch (err) {
    log(`❌ 오류 발생: ${err.message}`);
    log('   브라우저를 열어둘 테니 수동으로 진행해주세요.');
    // 오류 시 브라우저 닫지 않음
    return;
  }
}

module.exports = { runTicketBot };
