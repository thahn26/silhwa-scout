#!/bin/bash
# 실화탐사대 실행: 로컬 서버를 켜고 앱 창을 연다.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${SS_PORT:-8766}"
URL="http://127.0.0.1:$PORT/"
SUPPORT="$HOME/Library/Application Support/SilhwaScout"
mkdir -p "$SUPPORT"

PY=""
for p in /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
  if [ -x "$p" ]; then PY="$p"; break; fi
done
if [ -z "$PY" ]; then
  osascript -e 'display alert "Python 3가 필요합니다" message "python.org에서 Python 3를 설치한 뒤 다시 열어 주세요."'
  exit 1
fi

alive() { curl -s -m 1 -X POST "${URL}api/ping" >/dev/null 2>&1; }
if ! alive; then
  nohup "$PY" "$DIR/server.py" >> "$SUPPORT/server.log" 2>&1 &
  for _ in $(seq 1 50); do alive && break; sleep 0.1; done
fi
if ! alive; then
  osascript -e "display alert \"레이더 서버를 켜지 못했습니다\" message \"$SUPPORT/server.log 를 확인해 주세요.\""
  exit 1
fi

if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$URL" --user-data-dir="$SUPPORT/chrome" --no-first-run --no-default-browser-check
else
  open "$URL"
fi
