#!/bin/bash
# Builds Rinse.app from the Swift package. No Xcode project needed, only the command line tools.
#   ./scripts/build-app.sh            build to build/Rinse.app
#   ./scripts/build-app.sh --install  also copy it to /Applications and open it
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release
BIN="$(swift build -c release --show-bin-path)/Rinse"
APP="build/Rinse.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Rinse"
cp Support/Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
echo "Built $APP"

if [ "${1:-}" = "--install" ]; then
    osascript -e 'tell application "Rinse" to quit' >/dev/null 2>&1 || true
    rm -rf "/Applications/Rinse.app"
    cp -R "$APP" "/Applications/Rinse.app"
    open "/Applications/Rinse.app"
    echo "Installed to /Applications and opened. Look for the drop in the menu bar."
fi
