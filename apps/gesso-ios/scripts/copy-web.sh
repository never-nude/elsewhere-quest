#!/bin/sh
set -eu
/usr/bin/python3 "$SRCROOT/scripts/copy-web.py" "$SRCROOT/../gesso" "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/web"
