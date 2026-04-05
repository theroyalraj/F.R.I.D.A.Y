#!/usr/bin/env bash
# Reference script: copy Node LTS, python-build-standalone, ffmpeg (evermeet), redis-server, yt-dlp
# into apps/desktop/src-tauri/bundled/macos-arm64 (and x64) before shipping a fully offline .app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${ROOT}/apps/desktop/src-tauri/bundled"
echo "Target bundle dir: $OUT — populate with your licensed/redistributable binaries."
mkdir -p "$OUT/macos-arm64" "$OUT/macos-x64"
echo "Done (placeholder). See docs/packaging/macos-desktop.md."
