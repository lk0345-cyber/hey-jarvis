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

  // 우측 상단 로그인 버튼
  await page.locator('a[href*="/login"], button:has-text("로그인")').first().click();

  // PAYCO 로그인 버튼
  await page.locator('a[href*="payco"], button[class*="payco"], img[alt*="PAYCO"]').first().click();

  await page.waitForURL('**/payco.com/**', { timeout: 15000 });
  log('📱 PAYCO 로그인 페이지 진입');

  await page.waitForSelector('input[name="id"], #idInput', { timeout: 10000 });
  await page.locator('input[name="id"], #idInput').fill(config.paycoId);
  await page.locator('input[name="pw"], input[type="password"]').fill(config.paycoPw);
  await page.locator('.btn_login, button[type="submit"]').first().click();

  // 새 기기/브라우저 인증 처리
  try {
    await page.waitForSelector('text=새로운 기기', { timeout: 6000 });
    log('📲 새 기기 인증 입력 중...');
    await page.locator('input[placeholder*="인증"], input[type="number"], input[maxlength="8"]').fill(
      config.verificationCode
    );
    await page.locator('button:has-text("확인")').click();
  } catch {
    // 인증 팝업 없음
  }

  await page.waitForURL('**/ticketlink.co.kr/**', { timeout: 20000 });
  log('✅ 로그인 완료');
}

// ─────────────────────────────────────────────
// 정시 대기 (밀리초 정밀)
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

  log(`⏱  오픈까지 ${Math.round(waitMs / 1000)}초 대기 (목표: ${openTimeStr})`);

  if (waitMs > 31000) {
    await sleep(waitMs - 30000);
  }

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
// 예매하기 버튼 클릭 (대전 한화생명 볼파크)
// ─────────────────────────────────────────────

async function clickBookingButton(page, targetDate) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  log(`🔍 "${VENUE_NAME}" 경기 탐색 중... (날짜: ${targetDate || '최초 활성'})`);

  // 경기 목록의 각 행을 순회
  const rows = page.locator('li, tr, [class*="schedule"], [class*="event-item"], [class*="game"]');
  const count = await rows.count();

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const text = await row.textContent().catch(() => '');

    if (!text.includes(VENUE_NAME)) continue;
    if (targetDate && !text.includes(targetDate)) continue;

    // 활성 예매하기 버튼 확인 (회색 오픈예정 버튼 제외)
    const btn = row.locator('button:has-text("예매하기"), a:has-text("예매하기")');
    const btnCount = await btn.count();
    if (btnCount === 0) continue;

    // 오픈예정(disabled) 버튼 스킵
    const isDisabled =
      (await btn.first().getAttribute('disabled')) !== null ||
      (await btn.first().getAttribute('class') || '').includes('disabled') ||
      (await btn.first().getAttribute('class') || '').includes('planned');
    if (isDisabled) continue;

    log(`🎯 예매하기 클릭! (${text.match(/\d{2}\.\d{2}/)?.[0] || ''})`);
    await btn.first().click();
    return;
  }

  throw new Error('활성화된 예매하기 버튼을 찾지 못했습니다. 날짜/오픈 여부를 확인해주세요.');
}

// ─────────────────────────────────────────────
// 팝업 확인 버튼 공통 처리
// ─────────────────────────────────────────────

async function handleConfirmPopup(page, label = '', timeout = 5000) {
  try {
    await page.waitForSelector('.modal, [role="dialog"], .popup, [class*="modal"]', { timeout });
    const confirmBtn = page.locator('button:has-text("확인")');
    if (await confirmBtn.count() > 0) {
      log(`📋 팝업 처리${label ? ` [${label}]` : ''}...`);
      await confirmBtn.last().click();
      await sleep(400);
    }
  } catch {
    // 팝업 없음
  }
}

// ─────────────────────────────────────────────
// 보안문자(클린예매) 대기
// ─────────────────────────────────────────────

async function waitForCaptchaDone(page) {
  log('🔒 보안문자 입력 대기 중...');
  log('   → 화면의 보안문자를 직접 입력하고 [입력완료] 버튼을 눌러주세요.');

  await page
    .waitForSelector('[class*="captcha"], [class*="clean"], button:has-text("입력완료")', {
      state: 'hidden',
      timeout: 120000,
    })
    .catch(async () => {
      // 폴백: 좌석 맵이 보일 때까지 대기
      await page.waitForSelector('svg, canvas, [class*="seat-map"]', { timeout: 120000 });
    });

  log('✅ 보안문자 통과');
  await sleep(1000);
}

// ─────────────────────────────────────────────
// 등급 패널에서 목표 등급 클릭
// ─────────────────────────────────────────────

async function clickTargetGradeInPanel(page, targetGrade) {
  log(`🎫 등급 선택: "${targetGrade}"`);

  // 우측 등급 목록에서 텍스트 매칭으로 클릭
  // 가용 석수가 0인 경우 경고
  const gradeItems = page.locator('li, [class*="grade-item"], [class*="seat-grade"]');
  const count = await gradeItems.count();

  for (let i = 0; i < count; i++) {
    const item = gradeItems.nth(i);
    const text = await item.textContent().catch(() => '');
    if (!text.includes(targetGrade)) continue;

    // "0 석" 인 경우 경고만 출력 (시도는 함)
    const seatMatch = text.match(/(\d+)\s*석/);
    const seatCount = seatMatch ? parseInt(seatMatch[1]) : -1;
    if (seatCount === 0) {
      log(`⚠️  "${targetGrade}" 현재 0석. 오픈 후 갱신될 수 있으니 계속 진행...`);
    }

    await item.click();
    log(`✅ "${targetGrade}" 클릭 완료`);
    await sleep(600);
    return;
  }

  throw new Error(`등급 "${targetGrade}"을 목록에서 찾을 수 없습니다.`);
}

// ─────────────────────────────────────────────
// 하위 구역(섹션) 선택
// ─────────────────────────────────────────────

async function selectBestSubSection(page, ticketCount) {
  // 구역 목록이 나타나는지 잠시 대기
  await sleep(600);

  // 하위 구역 항목 탐색 (예: "405구역 2석")
  const subItems = page.locator(
    '[class*="sub"] li, [class*="section-item"], [class*="zone-item"], li[class*="area"]'
  );
  const count = await subItems.count();
  if (count === 0) return; // 구역 없으면 바로 진행

  log(`📍 하위 구역 선택 (요청 ${ticketCount}장)...`);

  // 필요한 장수 이상인 첫 번째 구역 선택
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

  // 부족해도 가장 많은 구역 선택
  let maxCount = 0;
  let maxIdx = 0;
  for (let i = 0; i < count; i++) {
    const text = await subItems.nth(i).textContent().catch(() => '');
    const m = text.match(/(\d+)\s*석/);
    const n = m ? parseInt(m[1]) : 0;
    if (n > maxCount) { maxCount = n; maxIdx = i; }
  }
  log(`⚠️  ${ticketCount}석 이상 구역 없음. 가용 최대(${maxCount}석) 구역 선택`);
  await subItems.nth(maxIdx).click();
  await sleep(600);
}

// ─────────────────────────────────────────────
// 좌석 유형 선택 팝업 처리 (잔디석/외야커플석 등)
// ─────────────────────────────────────────────

async function handleSeatTypePopup(page, targetGrade) {
  try {
    await page.waitForSelector('text=좌석 유형 선택', { timeout: 3000 });
    log('📋 좌석 유형 선택 팝업 처리...');

    // 팝업 내 목표 등급에 해당하는 직접선택 버튼 클릭
    // 팝업 구조: [등급명 텍스트] + [직접선택 버튼] 반복
    const sections = page.locator('[class*="type-item"], [class*="seat-type"], .modal li, [role="dialog"] li');
    const count = await sections.count();

    for (let i = 0; i < count; i++) {
      const sec = sections.nth(i);
      const text = await sec.textContent().catch(() => '');
      if (text.includes(targetGrade) || targetGrade.includes('잔디') && text.includes('잔디')) {
        const btn = sec.locator('button:has-text("직접선택")');
        if (await btn.count() > 0) {
          await btn.click();
          log(`✅ "${targetGrade}" 직접선택 클릭`);
          await sleep(500);
          return;
        }
      }
    }

    // 폴백: 마지막 직접선택 버튼 (잔디석은 두 번째)
    const allDirect = page.locator('button:has-text("직접선택")');
    const btnCount = await allDirect.count();
    await allDirect.nth(btnCount - 1).click();
    await sleep(500);
  } catch {
    // 팝업 없음 - 정상
  }
}

// ─────────────────────────────────────────────
// 사용 가능한 좌석 N장 클릭
// ─────────────────────────────────────────────

async function clickAvailableSeats(page, ticketCount) {
  log(`🪑 사용 가능한 좌석 ${ticketCount}장 선택 중...`);

  let clicked = 0;

  // SVG/Canvas 기반 좌석 맵에서 사용 가능한 좌석 탐색
  for (let attempt = 0; attempt < 5 && clicked < ticketCount; attempt++) {
    const newClicks = await page.evaluate(
      ({ needed }) => {
        // 사용 불가(회색/흰색) 판별 함수
        function isUnavailableColor(fill) {
          if (!fill || fill === 'none' || fill === 'transparent') return true;
          const f = fill.toLowerCase().trim();
          // 회색/흰색 계열 필터
          const grayPatterns = [
            /^#[c-f][c-f][c-f]/i, // #ccc~#fff
            /^#[89a-b][89a-b][89a-b]/i,
            /^rgb\(\s*([2-9]\d\d|1[6-9]\d)\s*,\s*([2-9]\d\d|1[6-9]\d)\s*,\s*([2-9]\d\d|1[6-9]\d)/,
            'none', 'transparent', 'white', '#fff', '#ffffff',
          ];
          for (const p of grayPatterns) {
            if (p instanceof RegExp ? p.test(f) : f === p) return true;
          }
          return false;
        }

        // 클래스 기반 우선 탐색
        const byClass = Array.from(
          document.querySelectorAll('[class*="seat"]:not([class*="disabled"]):not([class*="sold"]):not([class*="empty"])')
        ).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });

        // SVG 요소 탐색 (색상 기반)
        const bySvg = Array.from(document.querySelectorAll('rect, circle')).filter((el) => {
          const fill = el.getAttribute('fill') || window.getComputedStyle(el).fill;
          if (isUnavailableColor(fill)) return false;
          const cls = (el.className?.baseVal || '').toLowerCase();
          if (cls.includes('disabled') || cls.includes('sold') || cls.includes('bg')) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 4 && r.width <= 30; // 좌석 크기 범위 필터
        });

        const candidates = byClass.length > 0 ? byClass : bySvg;
        let count = 0;
        for (const el of candidates) {
          if (count >= needed) break;
          el.click();
          count++;
        }
        return count;
      },
      { needed: ticketCount - clicked }
    );

    clicked += newClicks;
    if (clicked < ticketCount) await sleep(500);
  }

  if (clicked === 0) {
    log('⚠️  자동 좌석 클릭 실패. 직접 선택해주세요.');
  } else {
    log(`✅ 좌석 ${clicked}/${ticketCount}장 클릭 완료`);
  }

  // 좌석 선택 후 확인 팝업
  await handleConfirmPopup(page, '좌석 확인');
  await sleep(500);
}

// ─────────────────────────────────────────────
// 전체 좌석 선택 플로우
// ─────────────────────────────────────────────

async function selectSeat(page, config) {
  const { targetGrade, ticketCount } = config;

  // 좌석 맵/등급 패널 로드 대기
  await page.waitForSelector(
    'svg, canvas, [class*="seat-map"], [class*="grade"], [class*="등급"]',
    { timeout: 15000 }
  );
  log('🗺️  좌석 선택 화면 로드 완료');
  await sleep(800);

  // 1. 등급 패널에서 목표 등급 클릭
  await clickTargetGradeInPanel(page, targetGrade);

  // 2. 하위 구역 선택 (있는 경우)
  await selectBestSubSection(page, ticketCount);

  // 3. 좌석 유형 선택 팝업 처리 (잔디석/외야커플석 등)
  await handleSeatTypePopup(page, targetGrade);

  // 팝업 닫힌 후 확인 팝업 처리
  await handleConfirmPopup(page, '유형 확인');

  // 4. 사용 가능한 좌석 N장 클릭
  await clickAvailableSeats(page, ticketCount);

  // 5. 다음단계
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
    slowMo: 60,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  try {
    await login(page, config);

    log(`📍 ${SPORTS_PAGE} 이동...`);
    await page.goto(SPORTS_PAGE, { waitUntil: 'domcontentloaded' });

    await waitForOpenTime(config.openTime);

    await clickBookingButton(page, config.targetGameDate);

    await handleConfirmPopup(page, '예매안내');

    await waitForCaptchaDone(page);

    await selectSeat(page, config);
  } catch (err) {
    log(`❌ 오류: ${err.message}`);
    log('   브라우저는 열어둡니다. 수동으로 이어서 진행해주세요.');
    // 오류 시 브라우저 유지
  }
}

module.exports = { runTicketBot };
