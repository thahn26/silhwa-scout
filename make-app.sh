#!/bin/bash
# '실화탐사대.app'을 만든다. 필요한 파일(web/, *.py, launch.sh)을 앱 안에 복사하므로
# 앱은 이 폴더 없이도 열린다. 파일을 고친 뒤에는 이 스크립트를 다시 실행해야 앱에 반영된다.
# 사용법: ./make-app.sh [설치할 폴더]   (기본: /Applications, 쓸 수 없으면 ~/Applications)
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-/Applications}"
if [ ! -w "$DEST" ]; then DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
NAME="실화탐사대"
APP="$DEST/$NAME.app"
rm -rf "$APP" "$DEST/실화탐사대 아이템 레이더.app"  # 예전 이름으로 설치된 앱도 지운다
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -R "$DIR/web" "$DIR/server.py" "$DIR/sources.py" "$DIR/minisoup.py" "$DIR/updater.py" "$DIR/launch.sh" "$APP/Contents/Resources/"
cat > "$APP/Contents/MacOS/launcher" <<'L'
#!/bin/bash
exec "$(cd "$(dirname "$0")/../Resources" && pwd)/launch.sh"
L
chmod +x "$APP/Contents/MacOS/launcher" "$APP/Contents/Resources/launch.sh"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>local.silhwa.scout</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PL
if [ -f "$DIR/icon.icns" ]; then cp "$DIR/icon.icns" "$APP/Contents/Resources/icon.icns"; fi
touch "$APP"
# 이전 버전 서버가 떠 있으면 끈다(다음에 열 때 새 버전으로 켜진다)
# (한글 경로는 macOS가 자모를 풀어 저장해서 이름으로 찾기 어렵다 — 포트로 찾는다)
PIDS="$(lsof -ti tcp:${SS_PORT:-8766} -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null || true; sleep 0.5; fi
echo "만들었습니다: $APP"
