#!/bin/bash
# Builds Wash.app from the Swift package. No Xcode project needed, only the command line tools.
#   ./scripts/build-app.sh            build to build/Wash.app
#   ./scripts/build-app.sh --install  also copy it to /Applications and open it
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release
BIN="$(swift build -c release --show-bin-path)/Wash"
APP="build/Wash.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Wash"
cp Support/Info.plist "$APP/Contents/Info.plist"
cp Support/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"
echo "Built $APP"

if [ "${1:-}" = "--install" ]; then
    osascript -e 'tell application "Wash" to quit' >/dev/null 2>&1 || true
    rm -rf "/Applications/Wash.app"
    cp -R "$APP" "/Applications/Wash.app"
    open "/Applications/Wash.app"
    echo "Installed to /Applications and opened. Wash is in the Dock."
fi
