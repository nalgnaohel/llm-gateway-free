#!/bin/sh
# Start the gateway and a client agent in the background, then wait for the
# agent to register. Logs go to ./.run/*.log, PIDs to ./.run/*.pid.
#
#   ./scripts/run.sh start | status | logs | stop
#   npm start | npm run status | npm run logs | npm stop
#
# POSIX sh on purpose: `sh scripts/run.sh` must work where /bin/sh is dash,
# which has no `set -o pipefail` and no arrays.
set -u
cd "$(dirname "$0")/.." || exit 1
RUN_DIR=".run"
mkdir -p "$RUN_DIR"

AIGW_PORT="${AIGW_PORT:-8787}"
AIGW_AGENT_TOKEN="${AIGW_AGENT_TOKEN:-dev-agent-token}"
AIGW_LOG_LEVEL="${AIGW_LOG_LEVEL:-info}"
export AIGW_PORT AIGW_AGENT_TOKEN AIGW_LOG_LEVEL
BASE="http://127.0.0.1:${AIGW_PORT}"

require_node() {
  command -v node >/dev/null 2>&1 || { echo "node not found on PATH (Node 22+ required)" >&2; exit 1; }
  major=$(node -p "process.versions.node.split('.')[0]")
  if [ "$major" -lt 22 ]; then
    echo "Node $major found, but this project needs Node 22+ (it runs .ts directly)." >&2
    exit 1
  fi
}

client_count() {
  curl -s "$BASE/health" 2>/dev/null | sed -n 's/.*"clients":\([0-9]*\).*/\1/p'
}

start() {
  require_node
  stop >/dev/null 2>&1

  AIGW_DATA_DIR="${AIGW_DATA_DIR:-$PWD/$RUN_DIR/data}" \
    nohup node packages/server/src/main.ts > "$RUN_DIR/server.log" 2>&1 &
  echo $! > "$RUN_DIR/server.pid"

  i=0
  while [ "$i" -lt 40 ]; do
    curl -sf "$BASE/health" >/dev/null 2>&1 && break
    i=$((i + 1))
    sleep 1
  done
  if ! curl -sf "$BASE/health" >/dev/null 2>&1; then
    echo "gateway failed to start:" >&2
    tail -20 "$RUN_DIR/server.log" >&2
    exit 1
  fi
  echo "gateway  up  $BASE"

  AIGW_SERVER_URL="ws://127.0.0.1:${AIGW_PORT}/agent" \
  AIGW_CLIENT_DATA_DIR="${AIGW_CLIENT_DATA_DIR:-$PWD/$RUN_DIR/client}" \
    nohup node packages/client/src/main.ts > "$RUN_DIR/client.log" 2>&1 &
  echo $! > "$RUN_DIR/client.pid"

  # Probing browser tabs and CLI binaries takes a few seconds on a cold start.
  i=0
  while [ "$i" -lt 30 ]; do
    n=$(client_count)
    [ -n "$n" ] && [ "$n" != "0" ] && break
    i=$((i + 1))
    sleep 1
  done
  n=$(client_count)
  if [ -z "$n" ] || [ "$n" = "0" ]; then
    echo "client agent did not register — last log lines:" >&2
    tail -20 "$RUN_DIR/client.log" >&2
    exit 1
  fi
  echo "agent    up"
  echo
  status
}

status() {
  curl -s "$BASE/api/clients" 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('gateway not reachable at $BASE'); sys.exit(0)
if not d.get('live'): print('no client agent connected'); sys.exit(0)
for c in d['live']:
    print('client %s (%s)' % (c['clientId'], c['platform']))
    for cap in c['capabilities']:
        print('  %s %-20s %s' % ('OK ' if cap['available'] else '-- ', cap['id'], cap.get('reason') or ''))
"
}

logs() { tail -n 40 -f "$RUN_DIR/server.log" "$RUN_DIR/client.log"; }

stop() {
  for p in client server; do
    if [ -f "$RUN_DIR/$p.pid" ]; then
      kill "$(cat "$RUN_DIR/$p.pid")" 2>/dev/null
      rm -f "$RUN_DIR/$p.pid"
    fi
  done
  echo "stopped"
}

case "${1:-start}" in
  start)  start ;;
  status) status ;;
  logs)   logs ;;
  stop)   stop ;;
  *)      echo "usage: $0 {start|status|logs|stop}" >&2; exit 1 ;;
esac
