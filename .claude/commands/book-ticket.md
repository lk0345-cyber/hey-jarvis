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
   - 좌석등급: 예) `1루 내야지정석B`, `잔디석`, `외야지정석`
   - 매수: 숫자
   - 오픈시간: "지금/당장/즉시/now" 또는 미지정 → `now` / "11시/11:00" → `11:00:00`

2. **프로젝트 루트 확인 후 .env 업데이트**:
   ```bash
   PROJECT=$(git rev-parse --show-toplevel)
   # macOS / Linux 구분
   if [ "$(uname)" = "Darwin" ]; then SED="sed -i ''"; else SED="sed -i"; fi
   $SED "s|TICKETBOT_TARGET_DATE=.*|TICKETBOT_TARGET_DATE=<날짜>|" $PROJECT/.env
   $SED "s|TICKETBOT_TARGET_GRADE=.*|TICKETBOT_TARGET_GRADE=<좌석등급>|" $PROJECT/.env
   $SED "s|TICKETBOT_TICKET_COUNT=.*|TICKETBOT_TICKET_COUNT=<매수>|" $PROJECT/.env
   $SED "s|TICKETBOT_OPEN_TIME=.*|TICKETBOT_OPEN_TIME=<오픈시간>|" $PROJECT/.env
   ```

3. **봇 실행**:
   ```bash
   cd $PROJECT && pnpm ticket
   ```

4. 실행 결과 요약 보고
