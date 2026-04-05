#!/usr/bin/env bash
# openclaw-client-bootstrap.sh — clone/pull OpenClaw, Cursor rules + deps, optional ngrok client attach.
#
# Interactive (recommended for Gist):
#   curl -fsSL '.../raw/openclaw-client-bootstrap.sh' | bash -s -- --interactive
# With no arguments from a real terminal, prompts start automatically.
#
# Modes:
#   --interactive|-i  Ask options on the terminal (uses /dev/tty when stdin is a pipe)
#   --pull-only       git clone or pull only
#   --setup-only      rules + npm ci + pip client deps
#   (default)         full client: ngrok + .env + celebration + start:client-stack
#   --no-setup        full client but skip npm ci and pip
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
INTERACTIVE=0
ORIG_ARGC=$#

expand_home() {
  case "${INSTALL_ROOT}" in
    "~"|"~"/*) INSTALL_ROOT="${INSTALL_ROOT/#\~/$HOME}" ;;
  esac
}

# Print prompt to stderr; read answer from terminal (works with curl | bash).
read_tty() {
  local prompt="$1"
  local default="${2:-}"
  local input=""
  local suffix=""
  [[ -n "${default}" ]] && suffix=" [${default}]"
  printf '%s%s: ' "${prompt}" "${suffix}" >&2
  if [[ -r /dev/tty ]]; then
    IFS= read -r input < /dev/tty || true
  else
    IFS= read -r input || true
  fi
  if [[ -z "${input}" && -n "${default}" ]]; then
    printf '%s\n' "${default}"
  else
    printf '%s\n' "${input}"
  fi
}

run_interactive_wizard() {
  echo "" >&2
  echo "======== OpenClaw bootstrap ========" >&2
  echo "" >&2
  echo "What do you want to do?" >&2
  echo "  1) Pull or clone the repo only (git)" >&2
  echo "  2) Setup project — Cursor company rule, npm ci, pip (client deps)" >&2
  echo "  3) Full remote client — link to home pc-agent (ngrok), update .env, optional celebration, start stack" >&2
  echo "" >&2
  local mode
  mode="$(read_tty "Enter 1, 2, or 3" "3")"
  case "${mode}" in
    1) PULL_ONLY=1 ;;
    2) SETUP_ONLY=1 ;;
    3) ;;
    *)
      echo "Invalid choice; use 1, 2, or 3." >&2
      exit 1
      ;;
  esac

  local home_in
  home_in="$(read_tty "OpenClaw install directory" "${INSTALL_ROOT}")"
  [[ -n "${home_in}" ]] && INSTALL_ROOT="${home_in}"
  expand_home

  local br_in
  br_in="$(read_tty "Git branch" "${BRANCH}")"
  [[ -n "${br_in}" ]] && BRANCH="${br_in}"

  local rp_in
  rp_in="$(read_tty "Git repository URL" "${REPO}")"
  [[ -n "${rp_in}" ]] && REPO="${rp_in}"

  if [[ "${PULL_ONLY}" -eq 0 && "${SETUP_ONLY}" -eq 0 ]]; then
    local ng_in
    ng_in="$(read_tty "Public pc-agent base URL (ngrok HTTPS, no trailing slash)" "${NGROK_URL}")"
    [[ -n "${ng_in}" ]] && NGROK_URL="${ng_in}"
    NGROK_URL="${NGROK_URL%/}"
    if [[ -z "${NGROK_URL}" ]]; then
      echo "Option 3 requires a public pc-agent HTTPS URL (ngrok)." >&2
      exit 1
    fi

    local skip_setup
    skip_setup="$(read_tty "Skip npm ci and pip — already ran setup? (y/N)" "n")"
    if [[ "${skip_setup}" =~ ^[yY] ]]; then
      NO_SETUP=1
    fi

    local cel_in
    cel_in="$(read_tty "Speak celebration on first successful link? (Y/n)" "y")"
    if [[ "${cel_in}" =~ ^[nN] ]]; then
      CELEBRATION=0
    fi
  fi

  if [[ "${PULL_ONLY}" -eq 1 && -z "${REPO}" ]]; then
    echo "Pull-only needs a Git repository URL." >&2
    exit 1
  fi
  if [[ "${SETUP_ONLY}" -eq 1 && ! -d "${INSTALL_ROOT}/.git" && -z "${REPO}" ]]; then
    echo "Setup needs a Git URL when the install directory is not already a clone." >&2
    exit 1
  fi

  echo "" >&2
  echo "Using:" >&2
  echo "  install dir: ${INSTALL_ROOT}" >&2
  echo "  branch:      ${BRANCH}" >&2
  if [[ -n "${REPO}" ]]; then
    echo "  repo:        ${REPO}" >&2
  fi
  if [[ "${PULL_ONLY}" -eq 0 && "${SETUP_ONLY}" -eq 0 ]]; then
    echo "  ngrok URL:   ${NGROK_URL}" >&2
    echo "  skip setup:  $([ "${NO_SETUP}" -eq 1 ] && echo yes || echo no)" >&2
    echo "  celebration: $([ "${CELEBRATION}" -eq 1 ] && echo yes || echo no)" >&2
  fi
  echo "" >&2
  local confirm
  confirm="$(read_tty "Continue? (Y/n)" "y")"
  if [[ "${confirm}" =~ ^[nN] ]]; then
    echo "Aborted." >&2
    exit 0
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ngrok-url|"--ngrok-url="*)
      if [[ "$1" == *=* ]]; then NGROK_URL="${1#*=}"; shift; else NGROK_URL="${2:-}"; shift 2 || shift; fi
      ;;
    --repo|"--repo="*)
      if [[ "$1" == *=* ]]; then REPO="${1#*=}"; shift; else REPO="${2:-}"; shift 2 || shift; fi
      ;;
    --branch|"--branch="*)
      if [[ "$1" == *=* ]]; then BRANCH="${1#*=}"; shift; else BRANCH="${2:-}"; shift 2 || shift; fi
      ;;
    --celebration-off) CELEBRATION=0; shift ;;
    --home=*)
      INSTALL_ROOT="${1#*=}"; shift ;;
    --home)
      INSTALL_ROOT="${2:-}"; shift 2 ;;
    --pull-only) PULL_ONLY=1; shift ;;
    --setup-only) SETUP_ONLY=1; shift ;;
    --no-setup) NO_SETUP=1; shift ;;
    --interactive|-i) INTERACTIVE=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage:
  curl -fsSL .../openclaw-client-bootstrap.sh | bash -s -- --interactive
  OPENCLAW_REPO_URL=https://github.com/you/openclaw.git  OPENCLAW_HOME=~/openclaw  $0 --pull-only
  $0 --ngrok-url https://host.ngrok-free.app --repo https://github.com/you/openclaw.git

Flags:
  -i, --interactive   Prompt for options (use with Gist + curl | bash)
  --repo URL          Git remote (or OPENCLAW_REPO_URL)
  --branch NAME       Default main
  --home PATH         Install dir (OPENCLAW_HOME), default ~/openclaw
  --ngrok-url HTTPS   Public pc-agent base (full client mode)
  --pull-only         Only git clone / pull
  --setup-only        Rule regen + npm ci + pip client requirements
  --no-setup          Full client: skip npm ci and pip
  --celebration-off   Skip first-connect TTS
  -h, --help          This text

Pipe from curl: add --interactive so questions read from your terminal.
EOF
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

expand_home

# Interactive: explicit flag, or no CLI args and a real terminal (not pipe-only).
if [[ "${INTERACTIVE}" -eq 1 ]]; then
  run_interactive_wizard
elif [[ "${ORIG_ARGC}" -eq 0 ]] && [[ -r /dev/tty ]] && [[ -t 0 ]] && [[ -t 2 ]]; then
  run_interactive_wizard
fi

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
  echo "Full client mode requires --ngrok-url https://your-tunnel or use --interactive" >&2
  echo "Or use --pull-only / --setup-only (see --help)" >&2
  exit 1
fi
if [[ -z "${REPO}" ]]; then
  echo "Set OPENCLAW_REPO_URL or pass --repo (or run --interactive)" >&2
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
