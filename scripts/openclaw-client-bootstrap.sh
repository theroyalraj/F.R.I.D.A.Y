#!/usr/bin/env bash
# openclaw-client-bootstrap.sh — visual, interactive bootstrap: clone, Cursor rules, deps, ngrok client.
#
# Interactive (Gist):
#   curl -fsSL '.../raw/openclaw-client-bootstrap.sh' | bash -s -- --interactive
#
# Voice test after a good /voice/ping:
#   ON by default (set OPENCLAW_BOOTSTRAP_VOICE_CHECK=0 or --no-voice-check to skip).
#
# Requires: git, npm, curl, bash. Windows: Git Bash or WSL.
set -euo pipefail

REPO="${OPENCLAW_REPO_URL:-}"
BRANCH="${OPENCLAW_BRANCH:-main}"
NGROK_URL=""
CELEBRATION=1
VOICE_CHECK=1
INSTALL_ROOT="${OPENCLAW_HOME:-$HOME/openclaw}"
PULL_ONLY=0
SETUP_ONLY=0
NO_SETUP=0
INTERACTIVE=0
ORIG_ARGC=$#
WIZARD_RAN=0

# Colors when stderr is a TTY
if [[ -t 2 ]]; then
  R=$'\033[0;31m'
  G=$'\033[0;32m'
  Y=$'\033[0;33m'
  B=$'\033[0;34m'
  M=$'\033[0;35m'
  C=$'\033[0;36m'
  W=$'\033[1;97m'
  D=$'\033[2m'
  X=$'\033[0m'
  BD=$'\033[1m'
else
  R= G= Y= B= M= C= W= D= X= BD=
fi

expand_home() {
  case "${INSTALL_ROOT}" in
    "~"|"~"/*) INSTALL_ROOT="${INSTALL_ROOT/#\~/$HOME}" ;;
  esac
}

ui_rule() { printf '%b\n' "${D}══════════════════════════════════════════════════════════════════${X}" >&2; }
ui_title() { ui_rule; printf '%b %s %b\n' "${BD}${C}" "$1" "${X}" >&2; ui_rule; }
ui_ok() { printf '%b  %s %s\n' "${G}" "${BD} OK ${X}" "${G}$1${X}" >&2; }
ui_fail() { printf '%b  %s %s\n' "${R}" "${BD} !! ${X}" "${R}$1${X}" >&2; }
ui_info() { printf '%b  >> %s\n' "${B}" "$1${X}" >&2; }
ui_step() { printf '\n%b  Step %s of %s:%b %s\n' "${M}" "$1" "$2" "${X}" "${BD}$3${X}" >&2; }

read_tty() {
  local prompt="$1"
  local default="${2:-}"
  local input=""
  local suffix=""
  [[ -n "${default}" ]] && suffix=" ${D}[${default}]${X}"
  printf '%b%s%s:%b ' "${Y}" "${prompt}" "${suffix}" "${X}" >&2
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

# Returns 0 if /voice/ping returns 2xx.
verify_voice_ping() {
  local base="${1%/}"
  curl -fsS -o /dev/null \
    --connect-timeout 15 \
    --max-time 25 \
    -H "ngrok-skip-browser-warning: true" \
    -H "Accept: application/json" \
    "${base}/voice/ping"
}

# Spoken feedback (background). Uses repo-root friday-speak when possible.
run_spoken_line() {
  local root="$1"
  local msg="$2"
  if [[ -f "${root}/skill-gateway/scripts/friday-speak.py" ]] && command -v python3 >/dev/null 2>&1; then
    ( cd "${root}" && FRIDAY_TTS_PRIORITY=1 FRIDAY_TTS_BYPASS_CURSOR_DEFER=true python3 skill-gateway/scripts/friday-speak.py "${msg}" ) &
  elif [[ -f "${root}/skill-gateway/scripts/friday-speak.py" ]] && command -v python >/dev/null 2>&1; then
    ( cd "${root}" && FRIDAY_TTS_PRIORITY=1 FRIDAY_TTS_BYPASS_CURSOR_DEFER=true python skill-gateway/scripts/friday-speak.py "${msg}" ) &
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    local VOICE="${FRIDAY_MACOS_SAY_VOICE:-Samantha}"
    ( say -v "${VOICE}" "${msg}" ) &
  fi
}

run_interactive_wizard() {
  ui_title "OpenClaw — client bootstrap (interactive)"
  printf '%b\n\n' "${W}Pick what you need. Numbers are enough; press Enter for defaults.${X}" >&2
  echo "  ${G}1${X}  ${BD}Pull${X}     — git clone or pull only" >&2
  echo "  ${G}2${X}  ${BD}Setup${X}    — Cursor company rule + npm ci + pip (client stack)" >&2
  echo "  ${G}3${X}  ${BD}Full${X}     — remote client: ngrok URL, .env, optional ${C}voice test${X}, start stack" >&2
  echo "" >&2
  local mode
  mode="$(read_tty "Your choice (1 / 2 / 3)" "3")"
  case "${mode}" in
    1) PULL_ONLY=1 ;;
    2) SETUP_ONLY=1 ;;
    3) ;;
    *)
      ui_fail "Need 1, 2, or 3."
      exit 1
      ;;
  esac

  ui_step 1 5 "Where to install OpenClaw"
  local home_in
  home_in="$(read_tty "Directory (OPENCLAW_HOME)" "${INSTALL_ROOT}")"
  [[ -n "${home_in}" ]] && INSTALL_ROOT="${home_in}"
  expand_home
  ui_info "Using path: ${INSTALL_ROOT}"

  ui_step 2 5 "Git branch"
  local br_in
  br_in="$(read_tty "Branch name" "${BRANCH}")"
  [[ -n "${br_in}" ]] && BRANCH="${br_in}"

  ui_step 3 5 "Git repository"
  local rp_in
  rp_in="$(read_tty "Repository URL" "${REPO}")"
  [[ -n "${rp_in}" ]] && REPO="${rp_in}"

  if [[ "${PULL_ONLY}" -eq 0 && "${SETUP_ONLY}" -eq 0 ]]; then
    ui_step 4 5 "Public pc-agent URL (ngrok / HTTPS)"
    local ng_in
    ng_in="$(read_tty "Base URL — no trailing slash" "${NGROK_URL}")"
    [[ -n "${ng_in}" ]] && NGROK_URL="${ng_in}"
    NGROK_URL="${NGROK_URL%/}"
    if [[ -z "${NGROK_URL}" ]]; then
      ui_fail "Full client needs a non-empty HTTPS base URL."
      exit 1
    fi
    printf '\n%b  Checking %s/voice/ping …%b\n' "${C}" "${NGROK_URL}" "${X}" >&2
    if verify_voice_ping "${NGROK_URL}"; then
      ui_ok "Reachable — tunnel and pc-agent look good from here."
    else
      ui_fail "Could not GET voice/ping — fix ngrok or pc-agent, then re-run."
      exit 1
    fi

    local skip_setup
    skip_setup="$(read_tty "Skip npm ci + pip (already set up)? (y/N)" "n")"
    if [[ "${skip_setup}" =~ ^[yY] ]]; then
      NO_SETUP=1
    fi

    local cel_in
    cel_in="$(read_tty "Extra celebration line on first link (30 min cool-down)? (Y/n)" "y")"
    if [[ "${cel_in}" =~ ^[nN] ]]; then
      CELEBRATION=0
    fi

    local vc_in
    vc_in="$(read_tty "After install, ${BD}speak one line${X} to test speakers? (Y/n)" "y")"
    if [[ "${vc_in}" =~ ^[nN] ]]; then
      VOICE_CHECK=0
    else
      VOICE_CHECK=1
    fi
  fi

  if [[ "${PULL_ONLY}" -eq 1 && -z "${REPO}" ]]; then
    ui_fail "Pull-only needs a Git repository URL."
    exit 1
  fi
  if [[ "${SETUP_ONLY}" -eq 1 && ! -d "${INSTALL_ROOT}/.git" && -z "${REPO}" ]]; then
    ui_fail "Setup on a fresh folder needs a Git URL to clone."
    exit 1
  fi

  ui_step 5 5 "Summary — confirm"
  ui_rule
  printf '  %-16s %b%s%b\n' "Install dir" "${W}" "${INSTALL_ROOT}" "${X}" >&2
  printf '  %-16s %b%s%b\n' "Branch" "${W}" "${BRANCH}" "${X}" >&2
  [[ -n "${REPO}" ]] && printf '  %-16s %b%s%b\n' "Repo" "${W}" "${REPO}" "${X}" >&2
  if [[ "${PULL_ONLY}" -eq 0 && "${SETUP_ONLY}" -eq 0 ]]; then
    printf '  %-16s %b%s%b\n' "pc-agent URL" "${W}" "${NGROK_URL}" "${X}" >&2
    printf '  %-16s %s\n' "Skip npm/pip" "$([ "${NO_SETUP}" -eq 1 ] && echo yes || echo no)" >&2
    printf '  %-16s %s\n' "Celebration" "$([ "${CELEBRATION}" -eq 1 ] && echo yes || echo no)" >&2
    printf '  %-16s %s\n' "Voice test" "$([ "${VOICE_CHECK}" -eq 1 ] && echo yes || echo no)" >&2
  fi
  ui_rule
  local confirm
  confirm="$(read_tty "Proceed? (Y/n)" "y")"
  if [[ "${confirm}" =~ ^[nN] ]]; then
    ui_info "Aborted."
    exit 0
  fi
  WIZARD_RAN=1
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
    --no-voice-check) VOICE_CHECK=0; shift ;;
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

Flags:
  -i, --interactive     Menus + live ngrok check + optional voice test
  --ngrok-url HTTPS     Public pc-agent base
  --repo URL            Git remote (or OPENCLAW_REPO_URL)
  --branch NAME         default main
  --home PATH           OPENCLAW_HOME (default ~/openclaw)
  --pull-only / --setup-only / --no-setup
  --celebration-off     Skip timed celebration line
  --no-voice-check      Skip spoken installation test after ping

Env:
  OPENCLAW_BOOTSTRAP_VOICE_CHECK=0   Skip voice test (non-interactive default follows flag above)
EOF
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

expand_home

if [[ "${INTERACTIVE}" -eq 1 ]]; then
  run_interactive_wizard
elif [[ "${ORIG_ARGC}" -eq 0 ]] && [[ -r /dev/tty ]] && [[ -t 0 ]] && [[ -t 2 ]]; then
  run_interactive_wizard
fi

# Env can force voice check off; interactive wizard choices win when wizard ran.
if [[ "${WIZARD_RAN}" -eq 0 ]]; then
  case "$(echo "${OPENCLAW_BOOTSTRAP_VOICE_CHECK:-1}" | tr '[:upper:]' '[:lower:]')" in
    0|false|no|off) VOICE_CHECK=0 ;;
  esac
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
  [[ "${NO_SETUP}" -eq 1 ]] && return 0
  cd "${INSTALL_ROOT}"
  printf '\n%b  [ setup ] Cursor rules (openclaw_company.py)…%b\n' "${C}" "${X}" >&2
  run_generate_rule
  ui_ok ".cursor/rules/openclaw-company.mdc refreshed"
  printf '%b  [ setup ] npm ci …%b\n' "${C}" "${X}" >&2
  npm ci
  ui_ok "Node workspaces installed"
  printf '%b  [ setup ] pip client requirements …%b\n' "${C}" "${X}" >&2
  pip_install_client
  ui_ok "Python client deps installed"
}

# --- pull-only ---
if [[ "${PULL_ONLY}" -eq 1 ]]; then
  ui_title "Mode: pull / clone only"
  if [[ -z "${REPO}" ]]; then
    ui_fail "Need --repo or OPENCLAW_REPO_URL"
    exit 1
  fi
  ensure_repo_clone_or_pull
  ui_ok "Repository ready at ${INSTALL_ROOT}"
  exit 0
fi

# --- setup-only ---
if [[ "${SETUP_ONLY}" -eq 1 ]]; then
  ui_title "Mode: setup (rules + npm + pip)"
  if [[ ! -d "${INSTALL_ROOT}/.git" ]]; then
    if [[ -z "${REPO}" ]]; then
      ui_fail "Need Git URL to clone into ${INSTALL_ROOT}"
      exit 1
    fi
    ensure_repo_clone_or_pull
  else
    git -C "${INSTALL_ROOT}" fetch origin "${BRANCH}" --depth 1 || true
    git -C "${INSTALL_ROOT}" checkout "${BRANCH}" || true
    git -C "${INSTALL_ROOT}" pull --ff-only origin "${BRANCH}" || true
  fi
  run_setup
  ui_ok "Setup finished → ${INSTALL_ROOT}"
  exit 0
fi

# --- full client ---
if [[ -z "${NGROK_URL}" ]]; then
  ui_fail "Full client needs --ngrok-url or --interactive"
  exit 1
fi
if [[ -z "${REPO}" ]]; then
  ui_fail "Need OPENCLAW_REPO_URL or --repo"
  exit 1
fi

NGROK_URL="${NGROK_URL%/}"

ui_title "Mode: full remote client"
if [[ "${WIZARD_RAN}" -eq 0 ]]; then
  printf '%b\n' "${C}  Checking ${NGROK_URL}/voice/ping …${X}" >&2
  if ! verify_voice_ping "${NGROK_URL}"; then
    ui_fail "Cannot reach pc-agent — fix --ngrok-url or tunnel."
    exit 1
  fi
  ui_ok "Tunnel / credentials look good from here."
fi

ui_step 1 5 "Sync Git repository"
ensure_repo_clone_or_pull
ui_ok "Repo at ${INSTALL_ROOT}"

cd "${INSTALL_ROOT}"

if [[ "${NO_SETUP}" -eq 0 ]]; then
  run_setup
else
  ui_info "Skipping npm ci + pip (--no-setup)"
  ui_step 1 1 "Regenerate Cursor rules only"
  run_generate_rule
  ui_ok "Rules refreshed"
fi

ENV_FILE="${INSTALL_ROOT}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  ui_fail "No .env — copy .env.example and set PC_AGENT_SECRET (and match home server)."
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

ui_step 4 5 "Write client .env (PC_AGENT_URL, mode)"
upsert_env "OPENCLAW_START_MODE" "client"
upsert_env "PC_AGENT_URL" "${NGROK_URL}"
upsert_env "FRIDAY_PC_AGENT_URL" "${NGROK_URL}"
upsert_env "FRIDAY_EMAIL_WATCH" "false"
ui_ok "Client keys updated in .env"

STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
mkdir -p "${STATE_DIR}"
CELEB_FILE="${STATE_DIR}/last-connect-celebration"
now="$(date +%s)"
last="0"
[[ -f "${CELEB_FILE}" ]] && last="$(cat "${CELEB_FILE}" || echo 0)"
delta="$((now - last))"

ui_step 5 5 "Verify tunnel + optional speech"
printf '%b\n' "${C}  GET ${NGROK_URL}/voice/ping ${X}" >&2
if ! verify_voice_ping "${NGROK_URL}"; then
  ui_fail "voice/ping failed — check tunnel, pc-agent, and network."
  exit 1
fi
ui_ok "Endpoint healthy — creds / tunnel look correct."

voice_note="OpenClaw installation check passed. This is your spoken voice test. If you heard this, your client speakers are working. You are linked to the home stack."
celebrate_note="OpenClaw client linked. You are on the home stack."

spoken_this_run=0
if [[ "${VOICE_CHECK}" -eq 1 ]]; then
  printf '%b\n' "${W}  Playing ${BD}one${X}${W} test line via friday-speak (or macOS say)…${X}" >&2
  run_spoken_line "${INSTALL_ROOT}" "${voice_note}"
  spoken_this_run=1
  echo "${now}" > "${CELEB_FILE}"
  ui_ok "Voice test triggered (check your speakers / Bluetooth)."
fi

if [[ "${CELEBRATION}" -eq 1 ]] && [[ "${spoken_this_run}" -eq 0 ]] && { [[ ! -f "${CELEB_FILE}" ]] || [[ "${delta}" -ge 1800 ]]; }; then
  run_spoken_line "${INSTALL_ROOT}" "${celebrate_note}"
  echo "${now}" > "${CELEB_FILE}"
fi

LOG="${STATE_DIR}/openclaw-client.log"
PIDF="${STATE_DIR}/openclaw-client.pid"
printf '\n%b  Starting client stack in background…%b\n' "${M}" "${X}" >&2
nohup npm run start:client-stack >> "${LOG}" 2>&1 &
echo $! > "${PIDF}"
ui_ok "client stack PID $(cat "${PIDF}") — log: ${LOG}"

ui_rule
printf '%b  All set. Open this folder in Cursor for rules under .cursor/rules %b\n' "${G}${BD}" "${X}" >&2
ui_rule
