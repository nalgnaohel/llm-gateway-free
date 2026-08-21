#!/bin/sh
# Bootstrap for macOS/Linux employee machines: ensure Node 22+ (no sudo/apt -
# this must work as a normal, non-root user on a company laptop), then hand
# off to install-agent.mjs for everything else.
#
#   AIGW_REPO_URL=<internal git remote> ./scripts/install-agent.sh
#   AIGW_REPO_URL=<internal git remote> ./scripts/install-agent.sh --check
#
# See docs/CLIENT_ROLLOUT.md.
set -eu

require_node() {
  if command -v node >/dev/null 2>&1; then
    major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
    if [ "$major" -ge 22 ]; then
      echo "node $(node -v) ok"
      return 0
    fi
  fi

  echo "node missing or <22 - installing (no sudo)" >&2

  if command -v brew >/dev/null 2>&1; then
    brew install node@22
    return 0
  fi

  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
  else
    echo "installing nvm..." >&2
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
  fi
  nvm install 22
  nvm use 22
}

require_node
command -v node >/dev/null 2>&1 || { echo "node still missing after install - install Node 22+ manually and re-run" >&2; exit 1; }

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
exec node "$SCRIPT_DIR/install-agent.mjs" "$@"
