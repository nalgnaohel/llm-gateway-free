#!/bin/sh
# Start the gateway and a local client agent in the foreground, side by side.
# Ctrl-C stops both. For background use see scripts/run.sh.
set -eu
cd "$(dirname "$0")/.." || exit 1

AIGW_AGENT_TOKEN="${AIGW_AGENT_TOKEN:-dev-agent-token}"
AIGW_PORT="${AIGW_PORT:-8787}"
AIGW_LOG_LEVEL="${AIGW_LOG_LEVEL:-info}"
export AIGW_AGENT_TOKEN AIGW_PORT AIGW_LOG_LEVEL

node packages/server/src/main.ts &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

sleep 2
AIGW_SERVER_URL="ws://127.0.0.1:${AIGW_PORT}/agent" exec node packages/client/src/main.ts
