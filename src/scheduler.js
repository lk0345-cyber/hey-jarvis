/**
 * 실업급여 일정 알림 스케줄러
 * - 2026-03-01 ~ 04-30: 계약직 근무 기간
 * - 2026-04-30: 계약만료 퇴사
 * - 2026-05-01~: 실업급여 신청 절차
 */

const cron = require("node-cron");

const CHAT_ID = process.env.UNEMPLOYMENT_REMINDER_CHAT_ID || "8737921782";

async function sendTelegram(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("[scheduler] Telegram sendMessage failed:", data.description);
    } else {
      console.log("[scheduler] Message sent:", text.slice(0, 60));
    }
  } catch (err) {
    console.error("[scheduler] Failed to send Telegram message:", err.message);
  }
}

/**
 * 날짜 비교 유틸: 오늘이 target 날짜(YYYY-MM-DD)인지 확인
 */
function isToday(dateStr) {
  const today = new Date();
  const [y, m, d] = dateStr.split("-").map(Number);
  return (
    today.getFullYear() === y &&
    today.getMonth() + 1 === m &&
    today.getDate() === d
  );
}

/**
 * 단발성 알림 정의 (날짜, 시간, 메시지)
 * cron 매일 오전 9시 실행 → 오늘 날짜와 매칭
 */
const ONE_TIME_REMINDERS = [
  // ── 근무 기간 중 ──────────────────────────────────────────
  {
    date: "2026-03-23",
    message: `📋 <b>[실업급여 준비 D-38] 지금 당장 확인하세요</b>

✅ 근로계약서 계약 종료일이 <b>2026년 4월 30일</b>인지 확인
✅ 4대보험 가입 여부 확인 (고용보험 필수)
✅ 급여명세서 보관 시작
✅ 출근기록 캡처/보관

⚠️ 절대 먼저 퇴사 의사 밝히지 말 것!`,
  },
  {
    date: "2026-04-01",
    message: `📅 <b>[실업급여 준비 D-29] 4월 시작 체크</b>

✅ 3월 급여명세서 수령 및 보관
✅ 출근기록 3월분 정리
✅ 4대보험 납입 확인 (고용보험 가입 유지)

📌 재계약 제안이 오면 → 바로 응하지 말고 조건 꼼꼼히 확인
  조건이 달라졌다면 기록 남겨두기`,
  },
  {
    date: "2026-04-15",
    message: `⚡️ <b>[실업급여 준비 D-15] 2주 전 준비 시작!</b>

✅ 근로계약서 사본 확보 (원본 + 사진 백업)
✅ 고용보험 가입 이력 확인: 고용24 (www.work.go.kr) 로그인 후 확인
✅ 퇴직 후 고용센터 방문 준비 (신분증 지참 예정)
✅ 이직사유가 <b>계약만료</b>로 처리될지 HR/담당자에게 넌지시 확인

📌 피보험단위기간 180일 이상 여부 확인 필수
  고용24 → 나의 고용보험 → 피보험 이력 조회`,
  },
  {
    date: "2026-04-25",
    message: `🔔 <b>[실업급여 준비 D-5] 5일 전 최종 점검</b>

<b>서류 체크리스트:</b>
☐ 근로계약서 (계약기간 명시)
☐ 급여명세서 (3월, 4월)
☐ 출근기록 or 근태 확인서
☐ 신분증

<b>확인할 것:</b>
☐ 회사가 고용보험 상실신고를 <b>계약만료</b>로 할 것인지
☐ 4월 30일 이후 연장/재계약 없음 확인

⚠️ 절대 먼저 나가지 말 것 — 4월 30일까지 버텨야 합니다!`,
  },
  {
    date: "2026-04-28",
    message: `⏰ <b>[실업급여 준비 D-2] 이틀 전!</b>

☐ 마지막 출근 준비
☐ 개인 물품 정리 시작 (티 안 나게)
☐ 퇴직확인서 or 이직확인서 발급 요청 예정 확인
☐ 4대보험 상실신고 날짜 확인 (퇴사 후 14일 이내 신고됨)

📌 퇴사일 당일 받아야 할 것:
  → 이직확인서 (회사 발급) 또는 발급 일정 확인
  → 마지막 급여명세서`,
  },

  // ── 퇴사 당일 ─────────────────────────────────────────────
  {
    date: "2026-04-30",
    message: `🚨 <b>[오늘이 퇴사일] 4월 30일 체크리스트</b>

<b>오늘 반드시 확인:</b>
☐ 고용보험 상실신고 사유 → <b>계약만료</b> 확인 요청
☐ 이직확인서 발급 요청 (또는 발급 예정일 확인)
☐ 마지막 급여명세서 수령
☐ 근로계약서 사본 최종 확보
☐ 퇴직 관련 서류 서명 시 이직사유 항목 확인

<b>퇴사 후 12개월 이내에 실업급여 신청 완료해야 합니다</b>
내일(5월 1일)부터 바로 고용24 접속하세요!`,
  },

  // ── 퇴사 후 신청 절차 ─────────────────────────────────────
  {
    date: "2026-05-01",
    message: `🟢 <b>[실업급여 신청 시작] 5월 1일 — 오늘 할 일</b>

<b>Step 1: 고용24 접속 (www.work.go.kr)</b>
☐ 구직등록 완료 (워크넷 구직신청)

📌 구직등록을 먼저 해야 이후 절차 진행 가능
  → 고용24 로그인 → 구직활동 → 구직신청

⏱ 소요시간: 약 15분`,
  },
  {
    date: "2026-05-02",
    message: `📚 <b>[실업급여 신청 Step 2] 온라인 교육 수강</b>

☐ 고용24 → 실업급여 → 수급자격 신청자 온라인 교육 수강
  URL: https://www.work.go.kr

📌 교육 수강 완료해야 수급자격 신청 가능
  (약 1시간 소요, PC 권장)

내일(5/4 or 5/5)은 수급자격 인정 신청!`,
  },
  {
    date: "2026-05-04",
    message: `📝 <b>[실업급여 신청 Step 3] 수급자격 인정 신청</b>

☐ 고용24 → 실업급여 → 수급자격 인정 신청
  또는 관할 고용센터 방문

<b>지참 서류:</b>
☐ 신분증
☐ 근로계약서 사본
☐ 이직확인서 (회사 발급 완료 확인)

📞 고용노동부 상담: 1350

📌 심사 후 수급자격 인정되면 실업인정일 통보됩니다`,
  },
  {
    date: "2026-05-11",
    message: `🔔 <b>[실업급여 진행 확인] 신청 후 1주일</b>

☐ 고용24에서 수급자격 처리 현황 확인
☐ 첫 번째 실업인정일 일정 확인
☐ 구직활동 실적 기록 시작 (이력서 제출, 채용공고 열람 등)

⚠️ 수급 중 주의사항:
  - 알바/프리랜서 소득 발생 시 반드시 신고
  - 취업 시 즉시 신고
  - 해외여행 전 사전 신고`,
  },
];

/**
 * 반복 알림 정의 (실업인정기간 중 격주 구직활동 리마인더)
 * 2026-05-15 ~ 2026-10-31 매 격주 월요일 오전 9시
 */
const BIWEEKLY_CHECKLIST = `📋 <b>[실업인정 준비] 이번 주 구직활동 체크</b>

<b>실업인정일 전 준비:</b>
☐ 구직활동 2건 이상 완료 (이력서 제출 / 면접 / 취업박람회 등)
☐ 고용24에 구직활동 내역 입력
☐ 실업인정 신청 (온라인 or 고용센터 방문)

<b>기억하세요:</b>
☐ 소득 발생 시 즉시 신고
☐ 취업 확정 시 즉시 신고 → 조기재취업수당 검토
☐ 수급기간 12개월 내 모두 사용

📞 문의: 고용노동부 1350`;

/**
 * 조기재취업수당 안내 (취업 후 리마인더)
 * 실제 취업 시점을 알 수 없으므로, 수급 종료 시점 추정일에 안내
 */
const EARLY_REEMPLOYMENT_REMINDER = `💰 <b>[조기재취업수당 안내]</b>

재취업하셨다면 확인하세요!

<b>조기재취업수당 조건:</b>
☐ 실업신고일로부터 14일 경과 후 취업
☐ 재취업 전날 기준 잔여 급여일수 1/2 이상 남아있을 것
☐ 재취업 후 12개월 이상 계속 고용 유지

<b>지급액:</b> 남은 구직급여의 1/2

<b>신청 시기:</b> 재취업 후 12개월 근속 확인된 후 청구

☐ 같은 회사 재고용이면 제외
☐ 실업신고 전 채용 약속된 곳이면 제외

📞 고용노동부 1350에서 사전 확인 추천`;

function startScheduler() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[scheduler] TELEGRAM_BOT_TOKEN not set — skipping reminders.");
    return;
  }

  // 매일 오전 9시 (KST = UTC+9, 서버 UTC 기준 00:00)
  // Railway 등 UTC 기준 서버에서 KST 09:00 = UTC 00:00
  const cronTime = "0 0 * * *";

  cron.schedule(
    cronTime,
    async () => {
      // 단발성 알림: 오늘 날짜와 매칭
      for (const reminder of ONE_TIME_REMINDERS) {
        if (isToday(reminder.date)) {
          await sendTelegram(token, CHAT_ID, reminder.message);
        }
      }

      // 격주 구직활동 리마인더: 2026-05-15 ~ 2026-10-31 월요일
      const today = new Date();
      const isMonday = today.getDay() === 1;
      const inRange =
        today >= new Date("2026-05-15") && today <= new Date("2026-10-31");

      if (isMonday && inRange) {
        // 격주: 2026-05-18 기준 2주 간격
        const base = new Date("2026-05-18");
        const diffDays = Math.round((today - base) / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays % 14 === 0) {
          await sendTelegram(token, CHAT_ID, BIWEEKLY_CHECKLIST);
        }
      }

      // 조기재취업수당 안내: 2026-08-01 (수급 중반 이후 1회)
      if (isToday("2026-08-01")) {
        await sendTelegram(token, CHAT_ID, EARLY_REEMPLOYMENT_REMINDER);
      }
    },
    {
      timezone: "Asia/Seoul",
    }
  );

  console.log("[scheduler] Unemployment benefits reminder scheduler started.");
  console.log("[scheduler] Scheduled reminders:");
  ONE_TIME_REMINDERS.forEach((r) => console.log(`  - ${r.date}`));
  console.log("  - Biweekly Mon (2026-05-18 ~ 2026-10-31)");
  console.log("  - 2026-08-01 (조기재취업수당 안내)");
}

module.exports = { startScheduler };
