# Vault deployment

This directory contains the deployment artefacts for the Vault service. In the
monorepo, the backend lives in `vault/`; the API image build context is
`vault/` and the Compose stack is `vault/deploy/`.

| Shape | Use case | Entry point |
|---|---|---|
| Docker Compose | Production / WSL2 | `docker-compose.yml` + `../Dockerfile` |
| Windows scheduled tasks | Optional example for a Windows host | `windows/deploy-windows.ps1`, `windows/install.ps1` |
| Linux systemd | Host that already runs Node.js and PostgreSQL | `linux/vault.service` |

## 1. Compose (recommended)

```bash
cd vault/deploy
cp .env.example .env                  # set VAULT_PG_PASSWORD and VAULT_MINIO_PASSWORD
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:3460/api/v1/health
```

Components and ports (all bound to loopback by default; override with
`VAULT_PG_BIND`, `VAULT_MINIO_BIND`, `VAULT_OS_BIND`, `VAULT_BIND`):

| Service | Port | Volume | Notes |
|---|---|---|---|
| postgres | 5432 | `vault_pgdata` | Metadata and index truth; includes `pg_dump` for backups. |
| minio | 9000 / 9001 | `vault_minio` | SHA-256 content-addressed object store. |
| opensearch | 9200 | `vault_opensearch` | Full-text index (rebuildable). |
| vault-api | 3460 | `vault_api_data` | Built from `vault/`; applies pending migrations on startup. |

Notes:

- The API image has no `npm install` step: the service only uses the Node.js
  standard library.
- `VAULT_MIGRATE_ON_START=1` (the default in the Compose file) applies
  migrations and fills in recent monthly partitions when the API starts.
  Manual maintenance: `docker compose exec vault-api node scripts/vault-migrate.mjs partitions`.
- Create the first project and token:

  ```bash
  docker compose exec vault-api node scripts/vault-token.mjs create \
    --label ops --project demo-project --role admin --ensure-project
  ```

  The plaintext token is printed once. Store it in a user-scoped file or
  credential store; never commit it.
- Backups: `docker compose exec -T postgres pg_dump -U vault -Fc vault > backup.dump`,
  or run `node scripts/vault-backup.mjs --pg-dump` from a machine that can reach
  the database. Rehearse restores with `scripts/vault-restore-check.mjs`.

## 2. Windows scheduled tasks (optional example)

The `windows/` directory is a complete, idempotent example for hosting Vault on a
single Windows machine with a bundled portable PostgreSQL. It is optional - use
it as a template and adapt paths to your environment. All values below default
to a neutral home directory (`C:\vault` on Windows) and can be overridden.

### Scripts

| Script | Purpose |
|---|---|
| `install.ps1` | Simple install/refresh: copies the app, registers the `Vault` scheduled task. |
| `deploy-windows.ps1` | Full deploy: bundle layout, PostgreSQL service, API task, daily backup task, firewall rule, migrations, health wait, optional monitor registration. Idempotent. |
| `status.ps1` | Status snapshot: scheduled tasks, PostgreSQL service, ports, health, backup status. |
| `health.ps1` | Probe `GET /api/v1/health` (exit 0 on 200). |
| `verify-windows.ps1` | Full verification, writes `verify-status.json` (no secrets). |
| `diag-windows.ps1` | Diagnostics: logs, ports, backup status, optional backup run. |
| `restart-windows.ps1` | Restart-resilience check: API task cold start and PostgreSQL service restart timing. |
| `backup.ps1` | Logical snapshot (`vault-backup.mjs`) plus an optional external backup step; writes `backup-status.txt` (`OK`/`FAIL`). |
| `run.bat` / `run-db.bat` | Foreground launchers used by the scheduled task / for troubleshooting. |
| `uninstall.ps1` | Removes the scheduled tasks; data is preserved. |
| `vault.env.example` | Environment template for the Windows deployment. |

### Deploy

```powershell
# elevated PowerShell, from the repository root
powershell -NoProfile -ExecutionPolicy Bypass -File vault\deploy\windows\deploy-windows.ps1 ^
  -Source <repo-root> -DbSource <path-to-portable-postgres-binaries>
```

Parameters: `-VaultHome` (default `C:\vault`), `-Source` (repository
root; the script resolves the backend under `<repo>\vault`), `-DbSource`
(PostgreSQL `bin/lib/share` directory), `-Port` (default `3460`),
`-DbPort` (default `5433`), `-NodeExe`, `-SkipMonitor`.

The script produces:

```text
<VaultHome>\app        application tree (no node_modules)
<VaultHome>\db         PostgreSQL binaries
<VaultHome>\data       PostgreSQL data dir + object storage + logical backups
<VaultHome>\log        logs
<VaultHome>\vault.env  environment file (keep ACL-restricted)
VaultPG                 Windows service (NetworkService, automatic)
Vault                   scheduled task (AtStartup, SYSTEM, restart on failure)
VaultBackup             scheduled task (daily, SYSTEM, runs backup.ps1)
```

and waits for `GET /api/v1/health` to return 200. `deploy-status.json` records
each step.

### Operate

```powershell
powershell -File vault\deploy\windows\status.ps1
powershell -File vault\deploy\windows\verify-windows.ps1
powershell -File vault\deploy\windows\diag-windows.ps1
powershell -File vault\deploy\windows\restart-windows.ps1
powershell -File vault\deploy\windows\backup.ps1
```

Notes and gotchas:

- PostgreSQL must not run as the SYSTEM account. The deploy script registers the
  database as the `VaultPG` service under `NT AUTHORITY\NetworkService` and
  grants the data/log directories the required ACLs.
- Scripts executed by the Windows Task Scheduler are ASCII-only on purpose;
  non-ASCII text can make a task silently do nothing.
- The portable PostgreSQL bundle may not include `psql` / `pg_dump`. The
  backup path is the logical snapshot produced by `vault-backup.mjs`; add a
  native client if you need `pg_dump`.
- Set `VAULT_BIND=0.0.0.0` in `vault.env` only if remote clients must reach
  the API, and restrict the firewall rule accordingly.

## 3. Linux systemd (optional)

```bash
sudo cp vault/deploy/linux/vault.service /etc/systemd/system/vault.service
sudo systemctl daemon-reload
sudo systemctl enable --now vault
```

The unit expects the application under `/opt/vault/app` and an environment
file at `/etc/vault/vault.env`; adjust both if you deploy elsewhere. Compose
users do not need this unit.

## 4. Environment contract

| Variable | Default | Notes |
|---|---|---|
| `VAULT_BIND` / `VAULT_PORT` | `127.0.0.1` / `3460` | Listen address and port. |
| `VAULT_DB` | `memory` | `pg` for production; `memory` for local development (non-durable, `health` reports degraded). |
| `VAULT_PG_HOST/PORT/USER/PASSWORD/DB` or `DATABASE_URL` | - | PostgreSQL connection. |
| `VAULT_DATA_DIR` | `~/.studio/vault/data` | Object storage and backup manifest root. |
| `VAULT_OBJECT_STORE` | `fs` | `fs` or `minio`. |
| `VAULT_MINIO_ENDPOINT/BUCKET/USER/PASSWORD` | - | MinIO driver configuration. |
| `VAULT_OPENSEARCH_URL` | - | Full-text index endpoint (accepted; wiring is incremental). |
| `VAULT_MIGRATE_ON_START` | `1` | Apply migrations on startup. |
| `VAULT_DEV_SEED` | `0` (`pg`) / `1` (`memory`) | Development project/token seed - **must be** `0` in production. |
| `VAULT_LOG_LEVEL` | `info` | Structured JSON logging level. |

## 5. Optional monitoring

`monitor/` contains two optional helper scripts - `monitor-add-vault.js` and
`monitor-verify-vault.js` - that create and verify an HTTP monitor for
`GET /api/v1/health` against a self-hosted uptime-monitoring service. They are not required for a Vault deployment and are never run
automatically; each script documents its environment variables in its header.
The Windows deploy script can skip the monitor step with `-SkipMonitor`.

## 6. Deployment acceptance checklist

1. After a host reboot, `GET /api/v1/health` returns 200 within 90 seconds.
2. The `Vault` task is registered (AtStartup, SYSTEM, restart on failure) and
   the `VaultPG` service is running.
3. The daily backup task succeeded today and a logical snapshot exists.
4. A restore drill has been run against the latest snapshot.
5. `studio doctor` reports the `vault` check as `ok` (or `degraded` when
   no token is configured on the Studio side - `degraded` is not a failure).
6. Rollback plan: stop the tasks, restore the previous app tree, start the
   tasks, verify health again; restore the database from the latest snapshot if
   needed.
