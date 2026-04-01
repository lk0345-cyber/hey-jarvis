'use strict';

// Ctrl+C: 봇 중단, 브라우저는 열어둠
// SIGKILL 로 Node 즉시 종료 → Playwright cleanup 실행 기회 없음 → Chrome 생존
process.on('SIGINT', () => {
  process.stdout.write('\n⏹  봇 중단 — 브라우저는 그대로 열려있습니다. 직접 이어서 진행하세요.\n');
  process.kill(process.pid, 'SIGKILL');
});

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { runTicketBot } = require('./ticketlink');

// 실행 시 ticketlink.js 를 바탕화면 pc 폴더에 자동 백업
try {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const src = path.join(__dirname, 'ticketlink.js');
  const dstDir = path.join(os.homedir(), 'Desktop', 'pc');
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, 'ticketlink-backup.js');
  fs.copyFileSync(src, dst);
  console.log(`💾 백업 저장: ${dst}`);
} catch { /* 바탕화면 없는 환경에서는 무시 */ }

// TICKETBOT_FALLBACK_GRADES 파싱: "스카이박스:1,내야박스석:1,1루 내야지정석A:6"
function parseFallbackGrades(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const lastColon = s.lastIndexOf(':');
    if (lastColon < 0) return { grade: s, count: 1 };
    const grade = s.slice(0, lastColon).trim();
    const count = parseInt(s.slice(lastColon + 1).trim(), 10) || 1;
    return { grade, count };
  });
}

const config = {
  paycoId:          process.env.TICKETBOT_PAYCO_ID,
  paycoPw:          process.env.TICKETBOT_PAYCO_PW,
  verificationCode: process.env.TICKETBOT_VERIFY_CODE  || '19931027',
  targetGameDate:   process.env.TICKETBOT_TARGET_DATE  || '',   // 예: '03.31' / '04.11'
  openDate:         process.env.TICKETBOT_OPEN_DATE    || '',   // 예매 오픈 날짜 '04.03' (미입력 시 당일)
  openTime:         process.env.TICKETBOT_OPEN_TIME    || '11:00:00', // 'now' = 즉시 예매
  targetGrade:      process.env.TICKETBOT_TARGET_GRADE || '잔디석',  // 예: '잔디석' / '1루 내야지정석B'
  ticketCount:      parseInt(process.env.TICKETBOT_TICKET_COUNT || '1', 10),
  fallbackGrades:   parseFallbackGrades(process.env.TICKETBOT_FALLBACK_GRADES),
};

if (!config.paycoId || !config.paycoPw) {
  console.error('❌ .env 파일에 TICKETBOT_PAYCO_ID 와 TICKETBOT_PAYCO_PW 를 설정해주세요.');
  process.exit(1);
}

console.log('──────────────────────────────────────────');
console.log('  티켓링크 예매봇');
console.log('──────────────────────────────────────────');
console.log(`  대상 날짜 : ${config.targetGameDate || '첫번째 대전 한화생명 볼파크 경기'}`);
console.log(`  1순위    : ${config.targetGrade} ${config.ticketCount}장`);
if (config.fallbackGrades.length > 0) {
  config.fallbackGrades.forEach(({ grade, count }, i) => {
    console.log(`  ${i + 2}순위    : ${grade} ${count}장`);
  });
}
console.log(`  오픈 시간 : ${config.openTime === 'now' ? '즉시 예매' : `${config.openDate ? config.openDate + ' ' : ''}${config.openTime}`}`);
console.log('──────────────────────────────────────────\n');

runTicketBot(config).catch((err) => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
