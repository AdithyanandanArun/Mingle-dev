#!/bin/sh
# Launched from terminals inside Electron-based tools, these variables would make
# the Electron binary run as plain Node and treat mingle:// links as script paths.
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH
exec /opt/mingle/mingle "$@"
