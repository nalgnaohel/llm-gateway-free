#!/bin/sh
# Push the gateway source to the server and run the server-side deploy.
# Runs from the repo root (GitHub Actions runner or locally).
#
#   SERVER_ACCOUNT=root SERVER_IP=x.y.z.w SERVER_SSH_KEY="$(cat deploy_key)" \
#     SERVER_HOST_KEY="ssh-ed25519 AAAA..." ./scripts/deploy-push.sh
#
# SERVER_SSH_KEY is the deploy keypair's private key (see docs/DEPLOY_KEY.md
# for how it was provisioned); SERVER_HOST_KEY pins the server's host key
# (the "keytype base64key" fields from `ssh-keyscan -t ed25519 <ip>`, no
# hostname) so a compromised DNS/network path can't MITM the deploy - it is
# NOT a secret, but it must be exact or the deploy will refuse to connect.
set -eu

ACCOUNT="${SERVER_ACCOUNT:?SERVER_ACCOUNT is required}"
IP="${SERVER_IP:?SERVER_IP is required}"
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
  SSH_KEY="${SERVER_SSH_KEY:?SERVER_SSH_KEY is required (deploy keypair private key)}"
  HOST_KEY="${SERVER_HOST_KEY:?SERVER_HOST_KEY is required (pinned server host key - run: ssh-keyscan -t ed25519 <ip>)}"

  KEY_FILE="$(mktemp)"
  KNOWN_HOSTS_FILE="$(mktemp)"
  trap 'rm -f "$KEY_FILE" "$KNOWN_HOSTS_FILE"' EXIT
  printf '%s\n' "$SSH_KEY" >"$KEY_FILE"
  chmod 600 "$KEY_FILE"
  printf '%s %s\n' "$IP" "$HOST_KEY" >"$KNOWN_HOSTS_FILE"

  SSH="ssh -i $KEY_FILE -o UserKnownHostsFile=$KNOWN_HOSTS_FILE -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20"
  SCP="scp -i $KEY_FILE -o UserKnownHostsFile=$KNOWN_HOSTS_FILE -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20"
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