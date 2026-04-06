#!/usr/bin/env bash
# oc-speak.sh — Thin wrapper to trigger TTS via pc-agent HTTP API.
# Usage:
#   oc-speak.sh "text to speak"                          # cooperative priority
#   oc-speak.sh "text" 1                                 # priority 1 (pre-empt)
#   oc-speak.sh "text" 1 subagent                        # subagent session
#   oc-speak.sh "text" 1 "" thinking                     # thinking singleton
#   oc-speak.sh "text" 1 subagent thinking               # subagent + thinking
#
# Environment:
#   PC_AGENT_URL     — default http://localhost:3847
#   PC_AGENT_SECRET  — Bearer token for /voice/speak-async
#   OPENCLAW_HOME    — repo root (auto-detected if unset)

set -euo pipefail

TEXT="${1:?Usage: oc-speak.sh \"text\" [priority] [session] [thinking]}"
PRIORITY="${2:-cooperative}"
SESSION="${3:-}"
THINKING="${4:-}"

OPENCLAW_HOME="${OPENCLAW_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
# Source .env so PC_AGENT_URL / PC_AGENT_SECRET apply (pipe+while subshell breaks exports).
if [ -f "$OPENCLAW_HOME/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$OPENCLAW_HOME/.env" || true
  set +a
fi

URL="${PC_AGENT_URL:-http://localhost:3847}"
SECRET="${PC_AGENT_SECRET:-}"
NGROK_HDR=()
case "$URL" in
  *ngrok*) NGROK_HDR=(-H "ngrok-skip-browser-warning: true") ;;
esac

if [ -z "$SECRET" ]; then
  echo "oc-speak: PC_AGENT_SECRET is empty — POST voice slash speak-async will be unauthorized. Set it in your env file to match the pc-agent host." >&2
fi

# Build JSON body safely using python for proper escaping
BODY=$(python3 -c "
import json, sys
body = {'text': sys.argv[1], 'priority': sys.argv[2]}
session = sys.argv[3]
thinking = sys.argv[4]
if session:
    body['channel'] = f'cursor_{session}'
if thinking in ('1', 'true') or thinking.lower() == 'thinking':
    body['channel'] = 'thinking'
print(json.dumps(body))
" "$TEXT" "$PRIORITY" "$SESSION" "$THINKING")

(
  _resp=$(mktemp) || exit 0
  code=$(curl -sS -o "$_resp" -w "%{http_code}" -X POST "$URL/voice/speak-async" \
    "${NGROK_HDR[@]}" \
    -H "Authorization: Bearer $SECRET" \
    -H "Content-Type: application/json" \
    -d "$BODY") || code="000"
  if [ "$code" != "200" ]; then
    echo "oc-speak: HTTP $code from speak-async: $(tr -d '\n\r' <"$_resp" | head -c 400)" >&2
  fi
  rm -f "$_resp"
) &
