#!/bin/sh
# Push the gateway source to the server and run the server-side deploy.
# Runs from the repo root (GitHub Actions runner or locally).
#
#   SERVER_ACCOUNT=root SERVER_IP=x.y.z.w SERVER_PASS=... ./scripts/deploy-push.sh
set -eu

ACCOUNT="${SERVER_ACCOUNT:?SERVER_ACCOUNT is required}"
IP="${SERVER_IP:?SERVER_IP is required}"
PASS="${SERVER_PASS:?SERVER_PASS is required}"
HOST="${ACCOUNT}@${IP}"
APP_DIR="/opt/llm-gateway"
TARBALL="/tmp/llm-gateway-src.tar.gz"
DRY_RUN="${DRY_RUN:-0}"

run() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

if [ "$DRY_RUN" = 1 ]; then
  SSH="ssh"
  SCP="scp"
else
  command -v sshpass >/dev/null 2>&1 || { echo "sshpass not installed" >&2; exit 1; }
  export SSHPASS="$PASS"
  SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20"
  SCP="sshpass -e scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20"
fi

tar czf "$TARBALL" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.worktrees' \
  --exclude='.superpowers' \
  --exclude='.run' \
  --exclude='.env' \
  --exclude='docs' \
  --exclude='tests' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite-wal' \
  --exclude='*.sqlite-shm' \
  .

run $SCP "$TARBALL" "$HOST:/tmp/"

run $SSH "$HOST" "
  set -e
  if [ -d $APP_DIR ]; then rm -rf ${APP_DIR}.prev; mv $APP_DIR ${APP_DIR}.prev; fi
  mkdir -p $APP_DIR
  tar xzf /tmp/llm-gateway-src.tar.gz -C $APP_DIR
  [ -f ${APP_DIR}.prev/.env ] && cp ${APP_DIR}.prev/.env $APP_DIR/.env || true
  sh $APP_DIR/scripts/deploy-server.sh
"