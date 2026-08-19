#!/bin/sh
# Server-side deploy for the llm-gateway. Run as root on the target server.
#   /opt/llm-gateway/scripts/deploy-server.sh [--check]
#
# Idempotent. --check verifies prerequisites and prints the would-be systemd
# unit without touching the system.
set -u

APP_DIR="${APP_DIR:-/opt/llm-gateway}"
SERVICE_NAME="llm-gateway"
PORT="${AIGW_PORT:-8787}"

CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; fi
[ $# -gt 1 ] && { echo "usage: $0 [--check]" >&2; exit 2; }

require_node() {
  if command -v node >/dev/null 2>&1; then
    major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
    if [ "$major" -ge 22 ]; then
      echo "node $(node -v) ok"
      return 0
    fi
  fi
  echo "node missing or <22 — installing NodeSource" >&2
  if [ "$CHECK" = 1 ]; then echo "  (skipped in --check)"; return 0; fi
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  else
    echo "unsupported distro: install Node 22+ manually" >&2
    exit 1
  fi
}

install_deps() {
  cd "$APP_DIR" || exit 1
  echo "npm ci --omit=dev ..."
  npm ci --omit=dev
}

ensure_env() {
  if [ ! -f "$APP_DIR/.env" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    echo "created $APP_DIR/.env from .env.example — EDIT IT (AIGW_AGENT_TOKEN, AIGW_API_KEY)"
  else
    echo "$APP_DIR/.env exists, leaving as-is"
  fi
}

write_unit() {
  NODE_BIN=$(command -v node)
  {
    echo "[Unit]"
    echo "Description=LLM Gateway Server"
    echo "After=network.target"
    echo ""
    echo "[Service]"
    echo "Type=simple"
    echo "WorkingDirectory=$APP_DIR"
    echo "EnvironmentFile=-$APP_DIR/.env"
    echo "ExecStart=$NODE_BIN packages/server/src/main.ts"
    echo "Restart=always"
    echo "RestartSec=5"
    echo ""
    echo "[Install]"
    echo "WantedBy=multi-user.target"
  } > "$SERVICE_NAME.service"
  if [ "$CHECK" = 1 ]; then
    echo "--- would install $SERVICE_NAME.service ($NODE_BIN): ---"
    cat "$SERVICE_NAME.service"
    return 0
  fi
  install -m 644 "$SERVICE_NAME.service" "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
}

health_check() {
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo "gateway up at :$PORT"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "gateway failed health check after 30s" >&2
  systemctl status "$SERVICE_NAME" --no-pager | tail -20 >&2
  return 1
}

require_node
[ "$CHECK" = 1 ] || install_deps
ensure_env
write_unit
[ "$CHECK" = 1 ] && { echo "check mode ok"; exit 0; }
health_check
