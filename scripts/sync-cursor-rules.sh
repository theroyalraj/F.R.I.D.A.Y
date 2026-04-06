#!/usr/bin/env bash
# sync-cursor-rules.sh — Copy OpenClaw .cursor/rules/ to registered project directories.
# OpenClaw is the single source of truth for all Cursor rules.
#
# Usage:
#   scripts/sync-cursor-rules.sh                 # sync to all targets
#   scripts/sync-cursor-rules.sh /path/to/project  # sync to a specific project
#
# Targets are read from OPENCLAW_SYNC_RULE_TARGETS in .env (colon-separated paths)
# or passed as command-line arguments.

set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
SOURCE="$OPENCLAW_HOME/.cursor/rules"

if [ ! -d "$SOURCE" ]; then
  echo "ERROR: Source rules directory not found: $SOURCE"
  exit 1
fi

# Load .env for OPENCLAW_SYNC_RULE_TARGETS
if [ -f "$OPENCLAW_HOME/.env" ]; then
  TARGETS_ENV=$(grep -E '^OPENCLAW_SYNC_RULE_TARGETS=' "$OPENCLAW_HOME/.env" | head -1 | cut -d= -f2- || true)
fi

# Build target list from CLI args or .env
TARGETS=()
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    TARGETS+=("$arg/.cursor/rules")
  done
else
  IFS=':' read -ra TARGETS <<< "${TARGETS_ENV:-}"
fi

# Default targets if nothing specified
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(
    "/Users/utkarshraj/IdeaProjects/store-finance/jarvis/.cursor/rules"
  )
fi

for target in "${TARGETS[@]}"; do
  if [ -z "$target" ]; then continue; fi
  mkdir -p "$target"
  rsync -av --delete "$SOURCE/" "$target/"
  echo "Synced rules to $target"
done

echo "Done. ${#TARGETS[@]} target(s) synced."
