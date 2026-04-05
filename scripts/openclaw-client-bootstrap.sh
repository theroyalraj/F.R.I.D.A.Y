#!/usr/bin/env bash
# openclaw-client-bootstrap.sh — clone/pull OpenClaw, Cursor rules + deps, optional ngrok client attach.
#
# Gist (update raw URL after republish):
#   curl -fsSL 'https://gist.githubusercontent.com/USER/ID/raw/openclaw-client-bootstrap.sh' | bash -s -- --help
#
# Modes:
#   --pull-only     git clone or pull only (needs --repo)
#   --setup-only    after repo exists: regenerate .cursor rules, npm ci, pip client deps (needs --repo if not cloned)
#   (default)       full client: pull + setup + write PC_AGENT_URL + celebration + start:client-stack (needs --ngrok-url)
#   --no-setup      with default mode: skip npm ci and pip (fast path; you already ran --setup-only)
#
# Requires: git, npm, curl, bash. On Windows use Git Bash or WSL.
set -euo pipefail

REPO="${OPENCLAW_REPO_URL:-}"
BRANCH="${OPENCLAW_BRANCH:-main}"
NGROK_URL=""
CELEBRATION=1
INSTALL_ROOT="${OPENCLAW_HOME:-$HOME/openclaw}"
PULL_ONLY=0
SETUP_ONLY=0
NO_SETUP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ngrok-url) NGROK_URL="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --celebration-off) CELEBRATION=0; shift ;;
    --home) INSTALL_ROOT="${2:-}"; shift 2 ;;
    --pull-only) PULL_ONLY=1; shift ;;
    --setup-only) SETUP_ONLY=1; shift ;;
    --no-setup) NO_SETUP=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage:
  OPENCLAW_REPO_URL=https://github.com/you/openclaw.git  OPENCLAW_HOME=~/openclaw  $0 --pull-only
  OPENCLAW_REPO_URL=...  $0 --setup-only
  $0 --ngrok-url https://host.ngrok-free.app --repo https://github.com/you/openclaw.git

Flags:
  --repo URL          Git remote (or env OPENCLAW_REPO_URL)
  --branch NAME       Default main
  --home PATH         Install dir (or OPENCLAW_HOME), default ~/openclaw
  --ngrok-url HTTPS   Public pc-agent base, no trailing slash (full client mode only)
  --pull-only         Only clone or git pull
  --setup-only        Pull if needed, then: openclaw_company rule, npm ci, pip client requirements
  --no-setup          Full client mode but skip npm ci and pip
  --celebration-off   Skip first-connect TTS
  -h, --help          This text

Examples:
  curl -fsSL .../openclaw-client-bootstrap.sh | bash -s -- --pull-only --repo https://github.com/you/repo.git
  curl ... | bash -s -- --setup-only --repo https://github.com/you/repo.git
  curl ... | bash -s -- --ngrok-url https://x.ngrok-free.app --repo https://github.com/you/repo.git
EOF
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ "${PULL_ONLY}" -eq 1 && "${SETUP_ONLY}" -eq 1 ]]; then
  echo "Use only one of --pull-only or --setup-only" >&2
  exit 1
fi

ensure_repo_clone_or_pull() {
  mkdir -p "${INSTALL_ROOT}"
  if [[ ! -d "${INSTALL_ROOT}/.git" ]]; then
    if [[ -z "${REPO}" ]]; then
      echo "Clone needs --repo or OPENCLAW_REPO_URL" >&2
      exit 1
    fi
    git clone --depth 1 --branch "${BRANCH}" "${REPO}" "${INSTALL_ROOT}" || {
      git clone --depth 1 "${REPO}" "${INSTALL_ROOT}"
      git -C "${INSTALL_ROOT}" checkout "${BRANCH}" || true
    }
  else
    git -C "${INSTALL_ROOT}" fetch origin "${BRANCH}" --depth 1 || true
    git -C "${INSTALL_ROOT}" checkout "${BRANCH}" || true
    git -C "${INSTALL_ROOT}" pull --ff-only origin "${BRANCH}" || true
  fi
}

run_generate_rule() {
  if command -v python3 >/dev/null 2>&1; then
    python3 scripts/openclaw_company.py --generate-rule 2>/dev/null || true
  elif command -v python >/dev/null 2>&1; then
    python scripts/openclaw_company.py --generate-rule 2>/dev/null || true
  fi
}

pip_install_client() {
  PY="python3"
  command -v python3 >/dev/null 2>&1 || PY="python"
  if [[ -f scripts/requirements-openclaw-client.txt ]]; then
    ${PY} -m pip install -r scripts/requirements-openclaw-client.txt
  else
    ${PY} -m pip install -r scripts/requirements-cursor-reply-watch.txt
  fi
}

run_setup() {
  cd "${INSTALL_ROOT}"
  run_generate_rule
  npm ci
  pip_install_client
}

# --- pull-only ---
if [[ "${PULL_ONLY}" -eq 1 ]]; then
  if [[ -z "${REPO}" ]]; then
    echo "--pull-only needs --repo or OPENCLAW_REPO_URL" >&2
    exit 1
  fi
  ensure_repo_clone_or_pull
  echo "[bootstrap] pull-only done → ${INSTALL_ROOT}"
  exit 0
fi

# --- setup-only ---
if [[ "${SETUP_ONLY}" -eq 1 ]]; then
  if [[ ! -d "${INSTALL_ROOT}/.git" ]]; then
    if [[ -z "${REPO}" ]]; then
      echo "--setup-only needs --repo (or OPENCLAW_REPO_URL) when OPENCLAW_HOME is not cloned yet" >&2
      exit 1
    fi
    ensure_repo_clone_or_pull
  else
    git -C "${INSTALL_ROOT}" fetch origin "${BRANCH}" --depth 1 || true
    git -C "${INSTALL_ROOT}" checkout "${BRANCH}" || true
    git -C "${INSTALL_ROOT}" pull --ff-only origin "${BRANCH}" || true
  fi
  run_setup
  echo "[bootstrap] setup-only done (rules + npm ci + pip) → ${INSTALL_ROOT}"
  exit 0
fi

# --- full client mode ---
if [[ -z "${NGROK_URL}" ]]; then
  echo "Full client mode requires --ngrok-url https://your-tunnel" >&2
  echo "Or use --pull-only / --setup-only (see --help)" >&2
  exit 1
fi
if [[ -z "${REPO}" ]]; then
  echo "Set OPENCLAW_REPO_URL or pass --repo" >&2
  exit 1
fi

NGROK_URL="${NGROK_URL%/}"

ensure_repo_clone_or_pull
cd "${INSTALL_ROOT}"

if [[ "${NO_SETUP}" -eq 0 ]]; then
  run_setup
else
  run_generate_rule
fi

ENV_FILE="${INSTALL_ROOT}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[bootstrap] No .env — copy from .env.example; add PC_AGENT_SECRET for /voice." >&2
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
