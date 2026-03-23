#!/usr/bin/env node
/**
 * 실업급여 일정 로컬 알림 스크립트 (macOS + Telegram)
 * 매일 오전 9시 launchd 또는 cron으로 실행
 *
 * 사용법:
 *   node scripts/remind-macos.js
 *   TELEGRAM_BOT_TOKEN=xxx node scripts/remind-macos.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const { execSync } = require("child_process");

const CHAT_ID = process.env.UNEMPLOYMENT_REMINDER_CHAT_ID || "8737921782";

// ─── 날짜 유틸 ───────────────────────────────────────────────
function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isToday(dateStr) {
  return today() === dateStr;
}

function isInRange(from, to) {
  const t = today();
  return t >= from && t <= to;
}

function isBiweeklyMonday(baseDate) {
  const d = new Date();
  if (d.getDay() !== 1) return false; // 월요일만
  const base = new Date(baseDate);
  const diff = Math.round((d - base) / (1000 * 60 * 60 * 24));
  return diff >= 0 && diff % 14 === 0;
}

// ─── macOS 알림 ──────────────────────────────────────────────
function notify(title, body) {
  // macOS osascript
  const safe = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  try {
    execSync(
      `osascript -e 'display notification "${safe(body)}" with title "${safe(title)}" sound name "Glass"'`
    );
    console.log(`[notify] ${title}`);
  } catch {
    console.log(`[notify:skip] macOS not available — ${title}`);
  }
}

// ─── Telegram ────────────────────────────────────────────────
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
    });
    const data = await res.json();
    if (!data.ok) console.error("[telegram]", data.description);
    else console.log("[telegram] sent");
  } catch (e) {
    console.error("[telegram] error:", e.message);
  }
}

// ─── 알림 정의 ───────────────────────────────────────────────
const REMINDERS = [
  {
    date: "2026-03-23",
    title: "📋 실업급여 D-38 서류 확인",
    body: "근로계약서 종료일(4/30) · 4대보험 · 출근기록 확인\n절대 먼저 퇴사 의사 밝히지 말 것!",
    telegram: `📋 <b>[실업급여 준비 D-38] 지금 당장 확인하세요</b>

✅ 근로계약서 계약 종료일이 <b>2026년 4월 30일</b>인지 확인
✅ 4대보험 가입 여부 확인 (고용보험 필수)
✅ 급여명세서 보관 시작
✅ 출근기록 캡처/보관
⚠️ 절대 먼저 퇴사 의사 밝히지 말 것!`,
  },
  {
    date: "2026-04-01",
    title: "📅 실업급여 D-29 4월 체크",
    body: "3월 급여명세서 수령 · 4대보험 납입 확인\n재계약 제안 시 조건 기록해두기",
    telegram: `📅 <b>[실업급여 준비 D-29] 4월 시작 체크</b>

✅ 3월 급여명세서 수령 및 보관
✅ 출근기록 3월분 정리
✅ 4대보험 납입 확인 (고용보험 가입 유지)
📌 재계약 제안이 오면 조건 꼼꼼히 확인 후 기록`,
  },
  {
    date: "2026-04-15",
    title: "⚡️ 실업급여 D-15 — 2주 전 준비!",
    body: "고용24 피보험단위기간 180일 확인\n계약서 사본 백업 · HR에 이직사유 확인",
    telegram: `⚡️ <b>[실업급여 준비 D-15] 2주 전 준비 시작!</b>

✅ 근로계약서 사본 확보 (원본 + 사진 백업)
✅ 고용24에서 피보험단위기간 180일 이상 확인
✅ 이직사유 <b>계약만료</b>로 처리될지 HR 확인
✅ 고용센터 방문 준비 (신분증 챙기기)`,
  },
  {
    date: "2026-04-25",
    title: "🔔 실업급여 D-5 최종 점검",
    body: "근로계약서·급여명세서·출근기록·신분증 준비\n상실신고 사유 계약만료 확인",
    telegram: `🔔 <b>[실업급여 준비 D-5] 5일 전 최종 점검</b>

<b>서류 체크리스트:</b>
☐ 근로계약서 (계약기간 명시)
☐ 급여명세서 (3월, 4월)
☐ 출근기록 or 근태확인서
☐ 신분증
⚠️ 4월 30일까지 절대 먼저 나가지 말 것!`,
  },
  {
    date: "2026-04-28",
    title: "⏰ 실업급여 D-2",
    body: "이직확인서 발급 요청 준비\n개인 물품 정리 시작",
    telegram: `⏰ <b>[실업급여 준비 D-2] 이틀 전!</b>

☐ 개인 물품 정리 시작
☐ 퇴직확인서/이직확인서 발급 요청 예정 확인
☐ 마지막 급여명세서 수령 예정일 확인`,
  },
  {
    date: "2026-04-30",
    title: "🚨 오늘 퇴사일 — 계약만료 확인!",
    body: "고용보험 상실신고 사유 계약만료 확인\n이직확인서 수령 · 마지막 급여명세서 보관",
    telegram: `🚨 <b>[오늘이 퇴사일] 4월 30일 체크리스트</b>

☐ 고용보험 상실신고 사유 → <b>계약만료</b> 확인 요청
☐ 이직확인서 발급 요청 (또는 발급 예정일 확인)
☐ 마지막 급여명세서 수령
☐ 근로계약서 사본 최종 확보
<b>내일(5/1)부터 바로 고용24 접속!</b>`,
  },
  {
    date: "2026-05-01",
    title: "🟢 실업급여 Step 1 — 고용24 구직등록",
    body: "www.work.go.kr → 워크넷 구직신청\n(약 15분 소요)",
    telegram: `🟢 <b>[실업급여 신청 Step 1] 오늘 할 일</b>

☐ 고용24 (www.work.go.kr) → 구직등록 완료
구직등록을 먼저 해야 이후 절차 진행 가능
⏱ 소요시간: 약 15분`,
  },
  {
    date: "2026-05-02",
    title: "📚 실업급여 Step 2 — 온라인 교육 수강",
    body: "고용24 → 수급자격 신청자 온라인 교육\n(약 1시간, PC 권장)",
    telegram: `📚 <b>[실업급여 신청 Step 2] 온라인 교육</b>

☐ 고용24 → 실업급여 → 수급자격 신청자 온라인 교육 수강
(약 1시간 소요, PC 권장)
내일은 수급자격 인정 신청!`,
  },
  {
    date: "2026-05-04",
    title: "📝 실업급여 Step 3 — 수급자격 인정 신청",
    body: "고용24 또는 고용센터 방문\n신분증·계약서·이직확인서 지참",
    telegram: `📝 <b>[실업급여 신청 Step 3] 수급자격 인정 신청</b>

☐ 고용24 → 실업급여 → 수급자격 인정 신청
  또는 관할 고용센터 방문
지참: 신분증 · 근로계약서 · 이직확인서
📞 고용노동부 상담: 1350`,
  },
  {
    date: "2026-05-11",
    title: "🔔 실업급여 — 처리 현황 확인",
    body: "고용24 수급자격 처리 현황 확인\n첫 실업인정일 일정 확인",
    telegram: `🔔 <b>[실업급여 진행 확인] 신청 후 1주일</b>

☐ 고용24 수급자격 처리 현황 확인
☐ 첫 번째 실업인정일 일정 확인
☐ 구직활동 실적 기록 시작
⚠️ 소득 발생 시 반드시 신고`,
  },
  {
    date: "2026-08-01",
    title: "💰 조기재취업수당 조건 확인",
    body: "14일 경과 후 취업 · 잔여일수 1/2 이상\n재취업 후 12개월 근속 → 청구",
    telegram: `💰 <b>[조기재취업수당 안내]</b>

재취업하셨다면 확인하세요!
☐ 실업신고일로부터 14일 경과 후 취업
☐ 재취업 전날 기준 잔여 급여일수 1/2 이상
☐ 재취업 후 12개월 이상 계속 고용 유지
지급액: 남은 구직급여의 1/2
📞 1350 사전 확인 추천`,
  },
];

const BIWEEKLY = {
  title: "📋 실업인정 준비 — 구직활동 체크",
  body: "구직활동 2건 이상 완료 + 고용24 입력\n실업인정 신청 (온라인 or 고용센터)",
  telegram: `📋 <b>[실업인정 준비] 이번 주 구직활동 체크</b>

☐ 구직활동 2건 이상 완료 (이력서/면접/취업박람회)
☐ 고용24에 구직활동 내역 입력
☐ 실업인정 신청 (온라인 or 고용센터)
⚠️ 소득 발생 시 즉시 신고
⚠️ 취업 확정 시 즉시 신고 → 조기재취업수당 검토`,
};

// ─── 메인 ────────────────────────────────────────────────────
async function main() {
  const t = today();
  console.log(`[remind] 오늘 날짜: ${t}`);
  let fired = false;

  // 단발성 알림
  for (const r of REMINDERS) {
    if (isToday(r.date)) {
      notify(r.title, r.body);
      await sendTelegram(r.telegram);
      fired = true;
    }
  }

  // 격주 월요일 구직활동 (2026-05-18 ~ 2026-10-31)
  if (isInRange("2026-05-18", "2026-10-31") && isBiweeklyMonday("2026-05-18")) {
    notify(BIWEEKLY.title, BIWEEKLY.body);
    await sendTelegram(BIWEEKLY.telegram);
    fired = true;
  }

  if (!fired) {
    console.log("[remind] 오늘 예정된 알림 없음.");
  }
}

main().catch(console.error);
