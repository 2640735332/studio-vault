# Studio Vault

**A zero-runtime-dependency data service for game project artefacts.**

Vault stores the heavy material a game team produces: bug tickets, report
packages with screenshots and logs, test runs, and the audit trail around them.
It combines:

- **PostgreSQL metadata and indexes** for projects, tokens, bugs, reports,
  files, links, ingest jobs, audit events and migrations;
- **SHA-256 content-addressed object storage** (filesystem or MinIO) with
  reference-counted deduplication;
- **A small REST API** (`/api/v1`) with token scopes, role checks, optimistic
  locking and audit events.

The service uses only the Node.js standard library - no `npm install` at
runtime. Vault is the backend companion of [Studio](../README.md).

English | [中文摘要](#中文摘要)

## 1. Layout

| Path | Contents |
|---|---|
| `src/` | HTTP app, auth, stores (memory / PostgreSQL), object storage, importer / reconcile. |
| `migrations/` | Append-only SQL migrations (checksummed in `schema_migrations`; partitioned tables). |
| `scripts/` | `vault-migrate`, `vault-token`, `vault-backup`, `vault-restore-check`, `vault-import`, `vault-reconcile`, `vault-dual-read`, `vault-status`, `vault-retention`, `vault-selftest`. |
| `test/` | `node:test` unit suites (migrations, auth, health, optimistic locking, reports, links, ingest, import/reconcile/rollback, backup). |
| `deploy/` | Docker Compose stack, Dockerfile-based API image, Linux systemd unit, optional Windows example scripts, cutover runbook. |
| `Dockerfile` | API image (no `npm install`). |
| `docs/DATABASE.md` | Schema, partitions, retention, backup/restore, audit, ID mapping, object storage, capacity. |
| `docs/API-DIRECT-REPORT.md` | Direct bug-report and evidence-upload API contract. |

## 2. Quick start without PostgreSQL

```bash
cd vault
node --test "test/*.test.mjs"                     # 33 unit tests
node scripts/vault-selftest.mjs --driver memory   # starts the service + 23 assertions
```

`--driver memory` runs the real HTTP service against the in-memory store and
exercises health, metrics, the authorisation matrix, optimistic locking, audit,
ingest idempotency and a backup/restore drill. No database and no network
access required.

To start a development server in memory mode:

```bash
# bash / zsh
./scripts/start-dev.sh
# PowerShell
./scripts/start-dev.ps1
```

## 3. Quick start with PostgreSQL

```bash
cd vault
export VAULT_DB=pg
export VAULT_PG_HOST=127.0.0.1 VAULT_PG_PORT=5432
export VAULT_PG_USER=vault VAULT_PG_PASSWORD=change-me VAULT_PG_DB=vault

node scripts/vault-migrate.mjs --create-database         # database + migrations + partitions
node scripts/vault-token.mjs create --label dev --project demo-project --role admin --ensure-project
node src/server.mjs                                       # default 127.0.0.1:3460
curl -s http://127.0.0.1:3460/api/v1/health
```

The plaintext token is printed exactly once; only its SHA-256 is stored. Keep it
outside the repository (a user-scoped file or credential store).

## 4. API

All routes are under `/api/v1`. A token looks like `vt_<id>_<secret>` and
is sent as `Authorization: Bearer ...`; scope = projects + role
(reader / writer / admin). The project and author are derived from the token -
a client-supplied author is rejected with `403 author_forged`.

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Public: version, api version, projects, usage, queue, storage, migrations (`?strict=1` turns degraded into 503). |
| GET | `/metrics` | Prometheus text: request counters, latency, uptime, queue and record counts. |
| GET | `/projects[/:project]` | Projects within the token scope; cross-project access is 403. |
| GET/POST/PATCH | `/bugs[/:id]`, `/bugs/by-legacy/:legacyId` | Bug tickets; project from token, author from token; `ifVersion` / `If-Match` optimistic locking returns 409 on mismatch; same `legacyId` POST is idempotent (200). Direct-report fields are documented in [`docs/API-DIRECT-REPORT.md`](docs/API-DIRECT-REPORT.md). |
| GET/POST | `/reports[/:id]` | Evidence artefact metadata plus the file sha256 manifest. |
| PUT | `/reports/:id/files?path=&role=` | Upload evidence (raw bytes); the server computes sha256/size and writes the object store + `report_files`. |
| GET | `/reports/:id/file?path=` | Download evidence (raw bytes; `X-Vault-Content-Sha256` response header). |
| GET/POST/DELETE | `/links` | Unique N:N `report_links(report, bug, role)`. |
| POST/GET | `/ingest[/:id]` | `ingest_jobs` with idempotency key `(project, source_path, content_sha256, kind)`. |
| GET | `/audit` | Audit list (project events + the caller's own events; filters and pagination). |
| GET | `/audit/summary` | Audit aggregate (`byAction` / `byOutcome` over the same filter set). |
| GET | `/audit/:eventId` | Single event (404 for cross-project events that are not the caller's). |
| GET | `/migrations/status` | Schema migration state (applied / pending / latest / versions). |
| GET | `/migrations/runs[/:id[/items]]` | Import-run list / detail (counters and kind summary) / items. |
| GET/POST/DELETE | `/tokens[/:id]` | Admin only: issue (plaintext returned once) / revoke. |

## 5. Database, object storage and backups

- **Migrations** are append-only. Each `migrations/NNN_*.sql` file is applied
  once and checksummed; editing an applied file is a hard error. Time-partitioned
  tables use monthly RANGE partitions plus a DEFAULT partition; `vault-migrate
  partitions` maintains them (startup also fills in the current months).
- **Object storage** is content-addressed by sha256 with reference-counted
  deduplication. The filesystem driver is the default; the MinIO driver uses the
  same key layout behind `VAULT_OBJECT_STORE=minio`. See
  [`docs/DATABASE.md`](docs/DATABASE.md) for the full design.
- **Backups**: `scripts/vault-backup.mjs` writes a logical snapshot (per-table
  row counts + sha256 manifests). Pair it with your own file-level backup or
  filesystem snapshots of the data directory, and rehearse recovery with
  `scripts/vault-restore-check.mjs` (temporary database, migrate, import,
  compare). The target is RPO of one day and RTO of a few hours.
- **Retention**: `scripts/vault-retention.mjs` archives and expires report
  data, trims audit/ingest rows and garbage-collects unreferenced blobs. It is a
  dry run by default; `--apply` performs the changes in a safe order.

## 6. Import and cutover

Importing an existing archive of report packages is an explicit operator
operation:

```bash
node scripts/vault-import.mjs --dry-run --report dry-run.json
node scripts/vault-import.mjs --report vault-import.json --mapping vault-id-map.json
node scripts/vault-reconcile.mjs --report vault-reconcile.json
node scripts/vault-dual-read.mjs --sample 10 --report vault-dual-read.json
node scripts/vault-import.mjs --rollback-run <runId> --purge-bugs
```

The full procedure, gates and rollback checklist are in
[`deploy/CUTOVER-RUNBOOK.md`](deploy/CUTOVER-RUNBOOK.md).

## 7. Deployment

| Shape | Entry point | Notes |
|---|---|---|
| Docker Compose (Linux / WSL2) | `deploy/docker-compose.yml` + `Dockerfile` | PostgreSQL + MinIO + OpenSearch + API; migrations run on startup. |
| Windows (optional example) | `deploy/windows/deploy-windows.ps1` | Bundled PostgreSQL service, scheduled tasks for the API and daily backups, firewall rule. See `deploy/README.md`. |
| Linux systemd | `deploy/linux/vault.service` | For hosts that already run Node.js and PostgreSQL; not needed with Compose. |

Compose quick start:

```bash
cd deploy
cp .env.example .env      # fill VAULT_PG_PASSWORD and VAULT_MINIO_PASSWORD
docker compose up -d --build
curl -s http://127.0.0.1:3460/api/v1/health
```

Ports bind to loopback by default. Vault is meant for a private network or a
TLS-terminating reverse proxy; do not expose the API directly to the internet.

## 8. Versioning and releases

- Current service version: see `vault/package.json`. The service follows semantic versioning;
  `/api/v1` only changes additively. A breaking change ships as a new API
  version and keeps the previous one for at least one release cycle.
- Release flow: update the docs if needed, run `node --test "test/*.test.mjs"`
  and the selftest, tag the release, push.
- Historical tags `vault-v0.1.0` / `vault-v0.1.1` are kept in the repository
  history.

## 9. Development conventions

See [`AGENTS.md`](AGENTS.md): zero dependencies, tests green before commit,
append-only migrations, no credentials in the repository, ASCII-only deployment
scripts where they run under Windows scheduled tasks.

## 中文摘要

Vault 是 Studio 的配套数据服务，负责存放游戏项目里的重资产（Bug 工单、上报包
与截图 / 日志证据、测试执行记录、审计事件），运行时零 npm 依赖。

- **结构**：`src/`（HTTP / 鉴权 / store / 对象存储 / 导入）、`migrations/`
  （追加式 SQL 迁移）、`scripts/`（迁移、token、备份、恢复演练、导入对账、
  保留策略、自检）、`test/`（node:test 单测）、`deploy/`（Compose、
  systemd、可选的 Windows 示例脚本）。
- **无 PostgreSQL 快速开始**：`cd vault` 后
  `node --test "test/*.test.mjs"`（33 个单测）与
  `node scripts/vault-selftest.mjs --driver memory`（23 条断言）。
- **真实 PostgreSQL**：设置 `VAULT_DB=pg` 与 `VAULT_PG_*`，跑
  `node scripts/vault-migrate.mjs --create-database`，用
  `node scripts/vault-token.mjs create` 签发 token（明文只打印一次，库里只存
  sha256），再 `node src/server.mjs`（默认 `127.0.0.1:3460`）。
- **部署**：推荐 `deploy/` 下的 Docker Compose；Windows 与 systemd 是可选部署
  示例。Vault 应运行在内网或 TLS 反向代理之后，不要直接暴露到公网。
- **数据层**：PostgreSQL 是唯一真源（分区表 + 追加式迁移），对象按 sha256 内容
  寻址并可去重；备份用逻辑快照 + 恢复演练，保留策略脚本默认 dry-run。

## Create-only report uploads

Report writers may send `If-None-Match: *` with a client UUID to prevent duplicate identities across
time partitions. Migration 008 is additive. Performance evidence uses existing report/files/link
APIs and completion receipts; see [database notes](docs/DATABASE.md#14-optional-create-only-report-identity-migration-008).
