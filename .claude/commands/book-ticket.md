# 티켓링크 예매봇 실행

티켓링크 한화 이글스 예매봇을 실행합니다.

## 사용법
```
/book-ticket [날짜] [좌석등급] [매수]
```

예시:
- `/book-ticket 03.31 "1루 내야지정석B" 2`
- `/book-ticket 04.11 잔디석 1`
- `/book-ticket 03.31 "외야 1루 내야지정석B" 2`

## 실행 절차

$ARGUMENTS 를 파싱하여 다음 순서로 실행하세요:

1. **인자 파싱**:
   - 첫 번째 인자: `날짜` (MM.DD 형식, 예: `03.31`)
   - 두 번째 인자: `좌석등급` (예: `1루 내야지정석B`, `잔디석`)
   - 세 번째 인자: `매수` (숫자, 기본값 1)

2. **Bash 도구로 .env 파일 업데이트**:
   ```bash
   # TICKETBOT_TARGET_DATE, TICKETBOT_TARGET_GRADE, TICKETBOT_TICKET_COUNT 값을 설정
   sed -i "s|TICKETBOT_TARGET_DATE=.*|TICKETBOT_TARGET_DATE=<날짜>|" /home/user/hey-jarvis/.env
   sed -i "s|TICKETBOT_TARGET_GRADE=.*|TICKETBOT_TARGET_GRADE=<좌석등급>|" /home/user/hey-jarvis/.env
   sed -i "s|TICKETBOT_TICKET_COUNT=.*|TICKETBOT_TICKET_COUNT=<매수>|" /home/user/hey-jarvis/.env
   ```

3. **.env 설정 확인** - TICKETBOT_PAYCO_ID, TICKETBOT_PAYCO_PW가 비어있으면 사용자에게 입력 요청

4. **봇 실행**:
   ```bash
   cd /home/user/hey-jarvis && pnpm ticket
   ```

5. 실행 후 터미널 출력 내용을 사용자에게 요약하여 보고
