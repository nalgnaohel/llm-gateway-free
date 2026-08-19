# CI/CD Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the gateway server to `root@47.236.100.116` on every push to `main` via a GitHub Actions workflow that runs tests, ships the source, and manages it under systemd.

**Architecture:** A GitHub Actions workflow runs `npm test` in a `test` job, then a `deploy` job runs a local push script (`scripts/deploy-push.sh`) that tars the source, `scp`s it to the server, and executes an idempotent server-side script (`scripts/deploy-server.sh`) that ensures Node 22, installs deps, writes a systemd unit, and health-checks the running gateway.

**Tech Stack:** GitHub Actions, POSIX `sh`, `sshpass`/`ssh`/`scp`, `tar`, Node 22, systemd.

## Global Constraints

- Node 22+ required on runner and server (runs `.ts` directly — no build step, no `dist/`).
- Target dir: `/opt/llm-gateway`. Systemd unit: `llm-gateway.service`.
- `EnvironmentFile=-/opt/llm-gateway/.env` (`-` prefix = ignore missing file).
- Service runs as root. `Restart=always`, `RestartSec=5`, `WantedBy=multi-user.target`.
- Health check: `GET http://127.0.0.1:8787/health` within 30s.
- Credentials come only from secrets `SERVER_ACCOUNT`, `SERVER_IP`, `SERVER_PASS`; SSH with `sshpass -e`, `StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`.
- `.env` never enters the repo. If missing on the server, copy from `.env.example` and let the operator edit it.
- Tarball excludes: `node_modules`, `.git`, `.run`, `.env`, `docs`, `tests`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`.
- Trigger: push to `main` + `workflow_dispatch`.
- Old deploy preserved as `/opt/llm-gateway.prev` for rollback.

---

### Task 0: Regenerate the stale `package-lock.json`

The committed `package-lock.json` is out of sync with `package.json`
(lockfile pins `vitest@2.1.9`; `package.json` requires `^4.1.11`), so
`npm ci` fails on a clean checkout. Both the CI `test` job (Task 3) and the
server-side install (Task 1) run `npm ci`, so the lockfile must be fixed
first.

**Files:**
- Modify: `package-lock.json` (regenerated)

- [ ] **Step 1: Regenerate the lockfile**

Run: `npm install`
Expected: exits 0; `git status` shows `package-lock.json` modified.

- [ ] **Step 2: Verify `npm ci` works from the regenerated lockfile**

Run: `npm ci`
Expected: exits 0, installs cleanly (this is exactly what CI and the server will run).

- [ ] **Step 3: Verify the test baseline still passes**

Run: `npm test`
Expected: `Tests 84 passed (84)`.

- [ ] **Step 4: Commit**

```bash
git add package-lock.json
git commit -m "fix: regenerate package-lock.json to match package.json"
```

---

### Task 1: Create `scripts/deploy-server.sh`

**Files:**
- Create: `scripts/deploy-server.sh`

**Interfaces:**
- Consumes: tarball extracted to `$APP_DIR` (default `/opt/llm-gateway`) containing `package.json`, `package-lock.json`, `.env.example`, `packages/`, `scripts/deploy-server.sh`.
- Produces: `/etc/systemd/system/llm-gateway.service` (enabled + running), `/opt/llm-gateway/.env` (if absent), `node_modules/` via `npm ci --omit=dev`. Supports `--check` mode (exit 0, no system changes) used for local verification.

- [ ] **Step 1: Write the script**

```sh
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
case "$#" in
  0) ;;
  1)
    if [ "$1" = "--check" ]; then
      CHECK=1
    else
      echo "usage: $0 [--check]" >&2
      exit 2
    fi
    ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 2
    ;;
esac

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
  if command -v node >/dev/null 2>&1; then
    major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
    if [ "$major" -ge 22 ]; then
      echo "node $(node -v) ok"
      return 0
    fi
  fi
  echo "node still missing or <22 after install — fix manually and re-run" >&2
  exit 1
}

install_deps() {
  cd "$APP_DIR" || exit 1
  echo "npm ci --omit=dev ..."
  npm ci --omit=dev || { echo "npm ci failed — aborting before service restart" >&2; exit 1; }
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
  if [ "$CHECK" = 1 ]; then
    echo "--- would install $SERVICE_NAME.service ($NODE_BIN): ---"
    cat <<EOF
[Unit]
Description=LLM Gateway Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
ExecStart=$NODE_BIN packages/server/src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    return 0
  fi
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
```

- [ ] **Step 2: Syntax-check the script**

Run: `sh -n scripts/deploy-server.sh`
Expected: exit 0, no output.

- [ ] **Step 3: Verify `--check` mode in a temp dir**

Run:
```bash
rm -rf /tmp/aigw-check && mkdir -p /tmp/aigw-check/scripts /tmp/aigw-check/packages/server/src
cp .env.example /tmp/aigw-check/
cp scripts/deploy-server.sh /tmp/aigw-check/scripts/
echo 'export default {};' > /tmp/aigw-check/packages/server/src/main.ts
APP_DIR=/tmp/aigw-check sh /tmp/aigw-check/scripts/deploy-server.sh --check
```
Expected: prints current node version (ok), `check mode ok`, exit 0, and shows the would-be unit with `ExecStart=...node packages/server/src/main.ts`. Also verify `.env` was created:
Run: `ls -la /tmp/aigw-check/.env`
Expected: `.env` present (copy of `.env.example`).

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy-server.sh
git commit -m "feat: add server-side systemd deploy script"
```

---

### Task 2: Create `scripts/deploy-push.sh`

**Files:**
- Create: `scripts/deploy-push.sh`

**Interfaces:**
- Consumes: env vars `SERVER_ACCOUNT`, `SERVER_IP`, `SERVER_PASS`; repo root as CWD; `scripts/deploy-server.sh` from the repo.
- Produces: tarball at `/tmp/llm-gateway-src.tar.gz`; extracted tree at `/opt/llm-gateway` on the server (old tree moved to `/opt/llm-gateway.prev`); `deploy-server.sh` run on the server. `DRY_RUN=1` prints commands without executing.

- [ ] **Step 1: Write the script**

```sh
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
  SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
  SCP="sshpass -e scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
fi

tar czf "$TARBALL" \
  --exclude='node_modules' \
  --exclude='.git' \
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
  sh $APP_DIR/scripts/deploy-server.sh
"
```

- [ ] **Step 2: Syntax-check and dry-run**

Run: `sh -n scripts/deploy-push.sh`
Expected: exit 0, no output.

Run: `DRY_RUN=1 SERVER_ACCOUNT=root SERVER_IP=127.0.0.1 SERVER_PASS=x ./scripts/deploy-push.sh`
Expected: prints the tar command result, then `[dry-run] scp ...` and `[dry-run] ssh ...` lines (no real connection). Verify the tarball was created:
Run: `tar tzf /tmp/llm-gateway-src.tar.gz | head -20`
Expected: top-level entries from the repo (e.g. `./package.json`, `./packages/server/...`), and no `node_modules/`, `.git/`, `tests/`, or `.env`.

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy-push.sh
git commit -m "feat: add ssh deploy push script"
```

---

### Task 3: Create `.github/workflows/deploy.yml`

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `scripts/deploy-push.sh`; GitHub secrets `SERVER_ACCOUNT`, `SERVER_IP`, `SERVER_PASS`.
- Produces: `test` job (typecheck + tests) and `deploy` job that runs on `main` after `test`.

- [ ] **Step 1: Write the workflow**

```yaml
name: Deploy Gateway Server

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - name: Install sshpass
        run: sudo apt-get update && sudo apt-get install -y sshpass
      - name: Deploy gateway to server
        env:
          SERVER_ACCOUNT: ${{ secrets.SERVER_ACCOUNT }}
          SERVER_IP: ${{ secrets.SERVER_IP }}
          SERVER_PASS: ${{ secrets.SERVER_PASS }}
        run: sh ./scripts/deploy-push.sh
```

- [ ] **Step 2: Validate the YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml')); print('yaml ok')"`
Expected: prints `yaml ok`.

If `actionlint` is available, run it too:
Run: `actionlint .github/workflows/deploy.yml`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add deploy workflow for gateway server"
```

---

### Task 4: End-to-end verification against the real server

**Files:** none (uses `scripts/deploy-push.sh` + `scripts/deploy-server.sh`).

**Interfaces:**
- Consumes: the real credentials (secrets/values), live server `47.236.100.116`.
- Produces: gateway running on the server at `http://47.236.100.116:8787/health`.

> This deploys to the production server. It is the definitive verification; run it only after Tasks 1–3 are committed.

- [ ] **Step 1: Run the deploy with real credentials**

Run (from repo root, with the real password exported into the shell — never written to a file):
```bash
SERVER_ACCOUNT=root SERVER_IP=47.236.100.116 SERVER_PASS='<real-password>' sh ./scripts/deploy-push.sh
```
Expected: sshpass uploads the tarball, server moves any old `/opt/llm-gateway` to `.prev`, extracts, runs `deploy-server.sh`, and prints `gateway up at :8787`.

- [ ] **Step 2: Confirm health + service over SSH**

Run:
```bash
sshpass -p '<real-password>' ssh -o StrictHostKeyChecking=no root@47.236.100.116 'systemctl is-active llm-gateway && curl -sf http://127.0.0.1:8787/health && curl -sf http://127.0.0.1:8787/v1/models | head -c 200'
```
Expected: `active`, a JSON health body, and a JSON models body — proving the gateway is up and serving.

- [ ] **Step 3: Confirm `.env` was created for operator editing**

Run:
```bash
sshpass -p '<real-password>' ssh -o StrictHostKeyChecking=no root@47.236.100.116 'ls -la /opt/llm-gateway/.env'
```
Expected: `.env` exists. Note: operator must set `AIGW_AGENT_TOKEN` (and `AIGW_API_KEY` if exposing beyond localhost) in that file, then `systemctl restart llm-gateway`.

- [ ] **Step 4: Push to GitHub and confirm the workflow runs**

Run: `git push origin main`
Then watch https://github.com/tritueviet/llm-gateway-free/actions — expected: `test` passes and `deploy` completes green.

- [ ] **Step 5: Manual trigger check**

In the Actions tab, click **Run workflow** (workflow_dispatch). Expected: both jobs run green again.