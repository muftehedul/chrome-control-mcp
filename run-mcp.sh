#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Force visible browser windows for OpenCode desktop control.
export PLAYWRIGHT_HEADLESS="false"

# Prefer Google Chrome over snap Chromium to avoid ERR_ACCESS_DENIED
# seen in some Linux runtimes with chromium-browser.
if [[ -z "${PLAYWRIGHT_EXECUTABLE_PATH:-}" ]]; then
  if [[ -x "/usr/bin/google-chrome" ]]; then
    export PLAYWRIGHT_EXECUTABLE_PATH="/usr/bin/google-chrome"
  elif [[ -x "/usr/bin/google-chrome-stable" ]]; then
    export PLAYWRIGHT_EXECUTABLE_PATH="/usr/bin/google-chrome-stable"
  fi
fi

# Auto-attach to an existing Chrome debug session when available.
if [[ -z "${PLAYWRIGHT_CDP_URL:-}" ]]; then
  if curl -fsS "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; then
    export PLAYWRIGHT_CDP_URL="http://127.0.0.1:9222"
  fi
fi

exec /usr/bin/node "${SCRIPT_DIR}/build/index.js"
