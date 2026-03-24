# 티켓링크 예매봇 실행

티켓링크 한화 이글스 예매봇을 실행합니다.

## 사용법
```
/book-ticket [날짜] [좌석등급] [매수]
```

예시:
- `/book-ticket 03.31 "1루 내야지정석B" 2`
- `/book-ticket 04.11 잔디석 1`

## 실행 절차

$ARGUMENTS 를 파싱하여 다음 순서로 실행하세요:

1. **인자 파싱**:
   - 첫 번째 인자: `날짜` (MM.DD 형식, 예: `03.31`) — 없으면 .env 기본값 사용
   - 두 번째 인자: `좌석등급` (예: `1루 내야지정석B`) — 없으면 .env 기본값 사용
   - 세 번째 인자: `매수` (숫자) — 없으면 .env 기본값 사용

2. **프로젝트 루트 확인**:
   ```bash
   git rev-parse --show-toplevel
   ```
   이 경로를 PROJECT_ROOT로 사용

3. **인자가 있을 경우 .env 업데이트** (PROJECT_ROOT/.env):
   - macOS: `sed -i ''` 사용
   - Linux: `sed -i` 사용

4. **.env 확인** — TICKETBOT_PAYCO_ID, TICKETBOT_PAYCO_PW가 비어있으면 사용자에게 입력 요청

5. **봇 실행**:
   ```bash
   cd <PROJECT_ROOT> && pnpm ticket
   ```

6. 실행 결과를 사용자에게 요약 보고
