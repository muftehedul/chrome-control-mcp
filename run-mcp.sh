#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Force visible browser windows for OpenCode desktop control.
export PLAYWRIGHT_HEADLESS="false"

# Auto-attach to an existing Chrome debug session when available.
if [[ -z "${PLAYWRIGHT_CDP_URL:-}" ]]; then
  if curl -fsS "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; then
    export PLAYWRIGHT_CDP_URL="http://127.0.0.1:9222"
  fi
fi

exec /usr/bin/node "${SCRIPT_DIR}/build/index.js"
