#!/usr/bin/env bash
# openclaw-client-bootstrap.sh — clone or pull OpenClaw, install deps, point at a remote pc-agent (ngrok), start client stack.
# Host the raw URL on a GitHub Gist; users: curl -fsSL https://gist.githubusercontent.com/.../raw/.../openclaw-client-bootstrap.sh | bash -s -- --ngrok-url https://xxx.ngrok-free.app --repo https://github.com/you/openclaw.git
# Requires: git, npm, curl, bash. On Windows use Git Bash or WSL.
set -euo pipefail

REPO="${OPENCLAW_REPO_URL:-}"
BRANCH="${OPENCLAW_BRANCH:-main}"
NGROK_URL=""
CELEBRATION=1
INSTALL_ROOT="${OPENCLAW_HOME:-$HOME/openclaw}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ngrok-url) NGROK_URL="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --celebration-off) CELEBRATION=0; shift ;;
    --home) INSTALL_ROOT="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: OPENCLAW_REPO_URL=https://... $0 --ngrok-url https://host [--repo URL] [--branch main] [--home path] [--celebration-off]"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${NGROK_URL}" ]]; then
  echo "Required: --ngrok-url https://your-tunnel (or set nothing and fix this script)" >&2
  exit 1
fi
if [[ -z "${REPO}" ]]; then
  echo "Set OPENCLAW_REPO_URL or pass --repo https://github.com/you/openclaw.git" >&2
  exit 1
fi

NGROK_URL="${NGROK_URL%/}"

mkdir -p "${INSTALL_ROOT}"
if [[ ! -d "${INSTALL_ROOT}/.git" ]]; then
  git clone --depth 1 --branch "${BRANCH}" "${REPO}" "${INSTALL_ROOT}" || {
    git clone --depth 1 "${REPO}" "${INSTALL_ROOT}"
    git -C "${INSTALL_ROOT}" checkout "${BRANCH}" || true
  }
else
  git -C "${INSTALL_ROOT}" fetch origin "${BRANCH}" --depth 1 || true
  git -C "${INSTALL_ROOT}" checkout "${BRANCH}" || true
  git -C "${INSTALL_ROOT}" pull --ff-only origin "${BRANCH}" || true
fi

cd "${INSTALL_ROOT}"

if command -v python3 >/dev/null 2>&1; then
  python3 scripts/openclaw_company.py --generate-rule 2>/dev/null || true
elif command -v python >/dev/null 2>&1; then
  python scripts/openclaw_company.py --generate-rule 2>/dev/null || true
fi

npm ci

PY="python3"
command -v python3 >/dev/null 2>&1 || PY="python"
${PY} -m pip install -r scripts/requirements-openclaw-client.txt

ENV_FILE="${INSTALL_ROOT}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[bootstrap] No .env in repo — copy from .env.example or create .env with PC_AGENT_SECRET matching your server." >&2
fi

upsert_env() {
  local key="$1" val="$2"
  local f="${ENV_FILE}"
  [[ -f "$f" ]] || touch "$f"
  if grep -q "^${key}=" "$f" 2>/dev/null; then
    local tmp
    tmp="$(mktemp)"
    grep -v "^${key}=" "$f" > "$tmp" || true
    mv "$tmp" "$f"
  fi
  echo "${key}=${val}" >> "$f"
}

upsert_env "OPENCLAW_START_MODE" "client"
upsert_env "PC_AGENT_URL" "${NGROK_URL}"
upsert_env "FRIDAY_PC_AGENT_URL" "${NGROK_URL}"
upsert_env "FRIDAY_EMAIL_WATCH" "false"

STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
mkdir -p "${STATE_DIR}"
CELEB_FILE="${STATE_DIR}/last-connect-celebration"
now="$(date +%s)"
last="0"
[[ -f "${CELEB_FILE}" ]] && last="$(cat "${CELEB_FILE}" || echo 0)"
delta="$((now - last))"

if [[ "${CELEBRATION}" -eq 1 ]] && { [[ ! -f "${CELEB_FILE}" ]] || [[ "${delta}" -ge 1800 ]]; }; then
  if curl -fsS -H "ngrok-skip-browser-warning: true" "${NGROK_URL}/voice/ping" -o /dev/null; then
    msg="OpenClaw client linked. You are on the home stack."
    if command -v python3 >/dev/null 2>&1; then
      ( cd "${INSTALL_ROOT}" && FRIDAY_TTS_PRIORITY=1 FRIDAY_TTS_BYPASS_CURSOR_DEFER=true python3 skill-gateway/scripts/friday-speak.py "${msg}" ) &
    elif [[ "$(uname -s)" == "Darwin" ]]; then
      VOICE="${FRIDAY_MACOS_SAY_VOICE:-Samantha}"
      ( say -v "${VOICE}" "${msg}" ) &
    fi
    echo "${now}" > "${CELEB_FILE}"
  fi
fi

LOG="${STATE_DIR}/openclaw-client.log"
PIDF="${STATE_DIR}/openclaw-client.pid"
nohup npm run start:client-stack >> "${LOG}" 2>&1 &
echo $! > "${PIDF}"
echo "[bootstrap] client stack PID $(cat "${PIDF}") log ${LOG}"
