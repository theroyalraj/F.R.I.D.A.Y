#!/usr/bin/env bash
# Interactive setup: writes keys into repo-root .env (append if missing).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

echo "OpenClaw ship setup — repo: $ROOT"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "No .env at $ENV_FILE — create one from your backup or .env.example first."
  exit 1
fi

append_kv() {
  local key="$1"
  local val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    echo "  (keep existing) $key"
  else
    echo "$key=$val" >> "$ENV_FILE"
    echo "  appended $key"
  fi
}

read_secret() {
  local prompt="$1"
  local var
  read -r -s -p "$prompt" var || true
  echo
  printf '%s' "$var"
}

echo ""
echo "OpenRouter API key (sk-or-..., empty to skip):"
OR_KEY="$(read_secret "OPENROUTER_API_KEY: ")"
if [[ -n "${OR_KEY}" ]]; then
  append_kv "OPENROUTER_API_KEY" "$OR_KEY"
fi

echo "N8N / OpenClaw webhook secret (empty to skip — generate a long random string):"
WH_SECRET="$(read_secret "N8N_WEBHOOK_SECRET: ")"
if [[ -n "${WH_SECRET}" ]]; then
  append_kv "N8N_WEBHOOK_SECRET" "$WH_SECRET"
fi

echo "pc-agent Bearer secret for daemons (empty to skip):"
PA_SECRET="$(read_secret "PC_AGENT_SECRET: ")"
if [[ -n "${PA_SECRET}" ]]; then
  append_kv "PC_AGENT_SECRET" "$PA_SECRET"
fi

append_kv "OPENCLAW_ALEXA_ENABLED" "false"
append_kv "OPENCLAW_DIRECT_INTAKE" "true"
append_kv "OPENCLAW_START_MODE" "all"

echo ""
echo "Optional: pc-agent base URL for a *client-only* Mac (empty = default http://127.0.0.1:3847):"
read -r -p "PC_AGENT_URL: " PA_URL || true
if [[ -n "${PA_URL// }" ]]; then
  append_kv "PC_AGENT_URL" "$PA_URL"
fi

echo ""
echo "Done. Review $ENV_FILE — then:"
echo "  Server:  cd $ROOT && npm run start:server-stack"
echo "  Client:  cd $ROOT && npm run start:client-stack"
echo "  Both:    npm run start:all"
