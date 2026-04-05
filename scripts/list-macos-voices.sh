#!/usr/bin/env bash
# List Apple voices for FRIDAY_MACOS_SAY_VOICE (macOS only).
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only runs on macOS."
  exit 1
fi
exec say -v '?'
