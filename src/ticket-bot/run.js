'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { runTicketBot } = require('./ticketlink');

const config = {
  paycoId:          process.env.TICKETBOT_PAYCO_ID,
  paycoPw:          process.env.TICKETBOT_PAYCO_PW,
  verificationCode: process.env.TICKETBOT_VERIFY_CODE  || '19931027',
  targetGameDate:   process.env.TICKETBOT_TARGET_DATE  || '',   // 예: '03.31' / '04.11'
  openTime:         process.env.TICKETBOT_OPEN_TIME    || '11:00:00',
  targetGrade:      process.env.TICKETBOT_TARGET_GRADE || '잔디석',  // 예: '잔디석' / '1루 내야지정석B'
  ticketCount:      parseInt(process.env.TICKETBOT_TICKET_COUNT || '1', 10),
};

if (!config.paycoId || !config.paycoPw) {
  console.error('❌ .env 파일에 TICKETBOT_PAYCO_ID 와 TICKETBOT_PAYCO_PW 를 설정해주세요.');
  process.exit(1);
}

console.log('──────────────────────────────────────────');
console.log('  티켓링크 예매봇');
console.log('──────────────────────────────────────────');
console.log(`  대상 날짜 : ${config.targetGameDate || '첫번째 대전 한화생명 볼파크 경기'}`);
console.log(`  목표 등급 : ${config.targetGrade}`);
console.log(`  예매 장수 : ${config.ticketCount}장`);
console.log(`  오픈 시간 : ${config.openTime}`);
console.log('──────────────────────────────────────────\n');

runTicketBot(config).catch((err) => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
