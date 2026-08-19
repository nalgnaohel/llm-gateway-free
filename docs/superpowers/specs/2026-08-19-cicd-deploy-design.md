# CI/CD Deploy — Design

Date: 2026-08-19

## Goal

Deploy the **gateway server** of this monorepo (`tritueviet/llm-gateway-free`,
branch `main`) to `root@47.236.100.116` every time `main` is pushed, via a
GitHub Actions workflow. Credentials live only in GitHub secrets.

## Decisions (confirmed with user)

- **Deployment method:** systemd service on the server.
- **Scope:** gateway server only (`packages/server` + `packages/shared`).
  The client agent is not deployed — it stays on local machines by design.
- **Env config:** server-local `.env` at `/opt/llm-gateway/.env`, created from
  `.env.example` on first deploy and edited directly on the server. Env values
  never live in GitHub or the repo.
- **Secrets:** `SERVER_ACCOUNT` (root), `SERVER_IP` (47.236.100.116),
  `SERVER_PASS`. Used via `sshpass` with `StrictHostKeyChecking=no`.
- **Service user:** root (user's chosen account). A dedicated `aigw` user is a
  documented, optional hardening step.

## Components

### 1. `.github/workflows/deploy.yml`

Two jobs:

- **`test`** (ubuntu-latest, Node 22): `npm ci` → `npm run typecheck` →
  `npm test`. Deploy is blocked on its success.
- **`deploy`** (`needs: test`), triggers: push to `main` + `workflow_dispatch`:
  1. Tar the source (excludes `node_modules`, `.git`, `.run`, `.env`, `docs`,
     `tests`, `node_modules` everywhere).
  2. `scp` the tarball + `scripts/deploy-server.sh` to the server.
  3. On the server: move any existing `/opt/llm-gateway` to
     `/opt/llm-gateway.prev` (rollback), extract the tarball to
     `/opt/llm-gateway`, run the deploy script.
  4. Fail the job if the health check does not pass.

### 2. `scripts/deploy-server.sh` (idempotent, run as root on the server)

1. Ensure Node 22+ (install via NodeSource — apt or dnf, detected from the
   distro — if missing/too old).
2. `npm ci --omit=dev` inside `/opt/llm-gateway` (compiles `better-sqlite3`
   native binary for the server's platform).
3. If `/opt/llm-gateway/.env` does not exist, copy `.env.example` to it.
4. Write `/etc/systemd/system/llm-gateway.service`:
   - `WorkingDirectory=/opt/llm-gateway`
   - `EnvironmentFile=-/opt/llm-gateway/.env` (`-` = ignore if missing)
   - `ExecStart=/usr/bin/node packages/server/src/main.ts`
   - `Restart=always`, `RestartSec=5`
   - `WantedBy=multi-user.target`
5. `systemctl daemon-reload`, `enable`, `restart llm-gateway`.
6. Wait up to 30s for `GET /health` on port 8787; exit non-zero on timeout.

## Runtime notes

- The server runs `.ts` directly via Node 22 native type-stripping — no build
  step, no `dist/`.
- `AIGW_DATA_DIR` defaults to `~/.ai-gateway` (`/root/.ai-gateway` as root);
  may be overridden in the server-local `.env`.
- `AIGW_AGENT_TOKEN` and `AIGW_API_KEY` must be set in the server `.env` before
  exposing the gateway beyond localhost.

## Security

- Password-based SSH in CI; switching to an `SERVER_SSH_KEY` secret is a
  trivial follow-up.
- `.env` and credentials never enter the repo (`.gitignore` already covers
  `.env`).
- Running the service as a dedicated `aigw` user is a recommended hardening
  follow-up, out of scope here.