#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
UI="$ROOT/extension-ui"

echo "==> OpenClaw extension UI build"
cd "$UI"
if [[ ! -f package.json ]]; then
  echo "Missing $UI/package.json"
  exit 1
fi
npm install
npm run build

echo ""
echo "Built: $UI/dist"
echo "  · Static site: serve dist/ over HTTP, or open via dev server (npm run dev)."
echo "  · Chrome: Extensions → Load unpacked → select dist/"
echo ""

ZIP="$ROOT/openclaw-friday-ui.zip"
if command -v zip >/dev/null 2>&1; then
  (cd "$UI/dist" && zip -r "$ZIP" .)
  echo "Zipped: $ZIP"
else
  echo "(zip not installed — skip archive)"
fi
