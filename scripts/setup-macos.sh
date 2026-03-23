#!/usr/bin/env bash
# 실업급여 알림 — macOS launchd 자동 설치 스크립트
# 실행: bash scripts/setup-macos.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_LABEL="com.hey-jarvis.unemployment-reminder"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/hey-jarvis"
NODE_BIN="$(which node)"

echo "=== 실업급여 알림 설치 ==="
echo "프로젝트: $PROJECT_DIR"
echo "Node:     $NODE_BIN"

# 1. 환경변수 설정 안내
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo ""
  echo "⚠️  TELEGRAM_BOT_TOKEN 이 설정되지 않았습니다."
  echo "   텔레그램 알림을 원하면 .env 파일에 아래를 추가하세요:"
  echo "   TELEGRAM_BOT_TOKEN=your-bot-token-here"
  echo ""
fi

# 2. 로그 디렉토리 생성
mkdir -p "$LOG_DIR"

# 3. launchd plist 생성 (매일 오전 9시 실행)
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PROJECT_DIR}/scripts/remind-macos.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/reminder.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/reminder-error.log</string>

  <key>RunAtLoad</key>
  <false/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
EOF

# 4. 기존 agent 언로드 후 재등록
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo ""
echo "✅ 설치 완료!"
echo ""
echo "매일 오전 9시에 알림이 실행됩니다."
echo ""
echo "─── 유용한 명령어 ───────────────────────────────"
echo "지금 즉시 테스트:  node $PROJECT_DIR/scripts/remind-macos.js"
echo "로그 확인:         tail -f $LOG_DIR/reminder.log"
echo "알림 제거:         launchctl unload $PLIST_PATH && rm $PLIST_PATH"
echo "────────────────────────────────────────────────"

# 5. .ics 파일 자동 열기 제안
ICS_PATH="$PROJECT_DIR/unemployment-schedule.ics"
if [ -f "$ICS_PATH" ]; then
  echo ""
  read -p "Apple 캘린더에 일정을 바로 추가할까요? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    open "$ICS_PATH"
    echo "📅 캘린더가 열렸습니다. '모두 추가' 버튼을 누르세요."
  fi
fi
