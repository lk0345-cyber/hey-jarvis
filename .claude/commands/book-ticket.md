# 티켓링크 예매봇 실행

티켓링크 한화 이글스 예매봇을 실행합니다.

## 사용법
```
/book-ticket [날짜] [좌석등급] [매수] [오픈시간]
```

예시:
- `/book-ticket 03.31 "1루 내야지정석B" 2`         → 즉시 예매
- `/book-ticket 03.31 "1루 내야지정석B" 2 11:00`   → 11시 오픈 대기 후 예매
- `/book-ticket 04.11 잔디석 1 11:00`              → 11시 오픈 대기 후 예매

또는 자연어로:
- "지금 당장 03.31 1루 내야지정석B 2장 예매해"
- "04.11 잔디석 1장 11시에 예매해줘"

## 실행 절차

$ARGUMENTS 를 파싱하여 다음 순서로 실행하세요:

1. **인자 파싱**:
   - 날짜: MM.DD 형식 (예: `03.31`) — 없으면 .env 기본값
   - 좌석등급: (예: `1루 내야지정석B`) — 없으면 .env 기본값
   - 매수: 숫자 — 없으면 .env 기본값
   - 오픈시간:
     - "지금", "당장", "즉시", "now" 또는 시간 미지정 → `now`
     - "11시", "11:00", "HH:MM" 형식 → `HH:00:00` 형식으로 변환

2. **프로젝트 루트 확인**:
   ```bash
   git rev-parse --show-toplevel
   ```

3. **.env 업데이트** (PROJECT_ROOT/.env, macOS는 `sed -i ''`):
   - TICKETBOT_TARGET_DATE
   - TICKETBOT_TARGET_GRADE
   - TICKETBOT_TICKET_COUNT
   - TICKETBOT_OPEN_TIME (`now` 또는 `HH:MM:SS`)

4. **.env 확인** — PAYCO_ID, PAYCO_PW 비어있으면 요청

5. **봇 실행**:
   ```bash
   cd <PROJECT_ROOT> && pnpm ticket
   ```

6. 실행 결과 요약 보고
