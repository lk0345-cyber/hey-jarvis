# 티켓링크 예매봇 실행

티켓링크 한화 이글스 예매봇을 실행합니다.

## 사용 예시
- "04.01 외야지정석 1장 즉시 예매해"
- "04.11 잔디석 1장 11시에 예매해줘"
- "03.31 1루 내야지정석B 2장 예매해줘"

## 실행 절차

$ARGUMENTS 를 파싱하여 다음 순서로 즉시 실행하세요:

1. **인자 파싱**:
   - 날짜: MM.DD 형식
   - 1순위 좌석등급 + 매수: 예) `잔디석 1장`
   - 폴백 순위 (선택): 예) `없으면 스카이박스 1장, 내야박스석 1장, 1루 내야지정석A 6장`
   - 오픈시간: "지금/당장/즉시/now" 또는 미지정 → `now` / "11시/11:00" → `11:00:00`

2. **프로젝트 루트 확인 후 .env 업데이트**:
   ```bash
   PROJECT=$(git rev-parse --show-toplevel)
   # macOS / Linux 구분
   if [ "$(uname)" = "Darwin" ]; then SED="sed -i ''"; else SED="sed -i"; fi
   $SED "s|TICKETBOT_TARGET_DATE=.*|TICKETBOT_TARGET_DATE=<날짜>|" $PROJECT/.env
   $SED "s|TICKETBOT_TARGET_GRADE=.*|TICKETBOT_TARGET_GRADE=<1순위등급>|" $PROJECT/.env
   $SED "s|TICKETBOT_TICKET_COUNT=.*|TICKETBOT_TICKET_COUNT=<1순위매수>|" $PROJECT/.env
   $SED "s|TICKETBOT_OPEN_TIME=.*|TICKETBOT_OPEN_TIME=<오픈시간>|" $PROJECT/.env
   # 폴백이 있으면: "스카이박스:1,내야박스석:1,1루 내야지정석A:6" 형식으로 변환
   $SED "s|TICKETBOT_FALLBACK_GRADES=.*|TICKETBOT_FALLBACK_GRADES=<폴백목록>|" $PROJECT/.env
   ```

3. **봇 실행**:
   ```bash
   cd $PROJECT && pnpm ticket
   ```

4. 실행 결과 요약 보고
