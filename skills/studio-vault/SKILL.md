---
name: studio-vault
description: "Operate the optional Studio Vault data service: memory-mode self-test, PostgreSQL setup and migrations, token scopes (reader / writer / admin), the /api/v1 endpoint table, optimistic locking with ifVersion or If-Match, report and evidence upload, idempotent ingest, audit queries, backup / restore drills and import / cutover tooling. Use when calling the Vault REST API, issuing or rotating tokens, uploading a report bundle, or backing up and migrating the service. 触发词：Vault 服务 / 数据服务 / Vault token / token scope / 证据上传 / 报告上传 / 乐观锁 / 审计查询 / Vault 备份 / Vault 恢复 / 迁移脚本 / vault-selftest / 内存模式。"
---

# Studio Vault: the optional data service

Vault is a standalone zero-runtime-dependency Node.js service. It stores the
heavy material a game team produces - bug tickets, report packages with
screenshots and logs, test runs - as PostgreSQL metadata plus SHA-256
content-addressed objects behind a REST API under `/api/v1`. Studio reads it
and treats its Markdown files as a display cache; Vault never reads the game repo.

> **Command convention.** Vault commands below run in the `vault/` directory of
> a `<studio-vault>` checkout (or the deployed service); `studio` commands mean
> `studio` on PATH or `node packages/cli/bin/studio-cli.js` from the checkout.

## 1. Try it in memory mode (no database, about ten seconds)

```bash
cd <studio-vault>/vault
node scripts/vault-selftest.mjs --driver memory   # SUMMARY {"total":23,"pass":23,"fail":0}
node --test "test/*.test.mjs"                     # unit suites
./scripts/start-dev.sh                            # or .\scripts\start-dev.ps1 on Windows
```

The self-test starts the real HTTP service with the in-memory store and exercises
health, metrics, the authorisation matrix, optimistic locking, audit, ingest
idempotency and a backup/restore drill (`--json` and `--evidence-dir <dir>`
are available). The development server defaults to `127.0.0.1:3460`; memory
mode is for trials and CI, not for keeping data.

## 2. Production setup

Configuration is environment-based (`vault/.env.example`):

| Variable | Purpose |
|---|---|
| `VAULT_DB` | `memory` (development, non-durable) or `pg` (production). |
| `VAULT_PG_HOST` / `PORT` / `USER` / `PASSWORD` / `DB` | PostgreSQL connection (or `DATABASE_URL`). |
| `VAULT_DATA_DIR` / `VAULT_OBJECT_STORE` / `VAULT_BIND` / `VAULT_PORT` | Storage root; `fs` or `minio`; listen address (default `127.0.0.1:3460`). |
| `VAULT_MIGRATE_ON_START` / `VAULT_DEV_SEED` | Apply migrations on start; seed dev data (must be `0` in production). |
| `VAULT_LOG_LEVEL` | Structured JSON log level. |

```bash
export VAULT_DB=pg VAULT_PG_HOST=127.0.0.1 VAULT_PG_PORT=5432
export VAULT_PG_USER=vault VAULT_PG_PASSWORD='<password>' VAULT_PG_DB=vault
node scripts/vault-migrate.mjs --create-database      # database + migrations + partitions
node scripts/vault-token.mjs create --label dev --project <project> --role admin --ensure-project
node src/server.mjs                                    # or the Compose stack in deploy/
```

Migrations are append-only and checksummed: never edit an applied file. Monthly
partitions plus a DEFAULT partition are maintained by `vault-migrate partitions`.

## 3. Authentication and scope
- Tokens look like `vt_<id>_<secret>`, sent as `Authorization: Bearer ...` (or
  `X-Vault-Token`). Only `sha256(secret)` is stored; plaintext is printed once.
- Scope = projects plus one role: `reader` (reads/downloads), `writer`
  (writes), `admin` (tokens and projects).
- Project and author are derived from the token. A multi-project token must send
  `X-Vault-Project: <project>` or `?project=`; sending `author` / `updatedBy`
  is rejected with `403 author_forged` (reporter identity belongs in
  `payload.reporter`).
- Rotate by issuing a new token and revoking the old one (`vault-token.mjs
  revoke --id <tokenId>` or `DELETE /api/v1/tokens/:id` as admin). A token is a
  password: keep it in a file or environment variable, never in Git.

## 4. API surface

All routes are under `/api/v1`:

| Area | Routes |
|---|---|
| Health / ops | `GET /health`, `GET /metrics`, `GET /migrations/status`, `GET /migrations/runs[/:id[/items]]` |
| Bugs | `GET/POST /bugs`, `GET /bugs/by-legacy/:legacyId`, `GET/PATCH /bugs/:id` |
| Reports | `GET/POST /reports`, `GET /reports/:id`, `PUT /reports/:id/files`, `GET /reports/:id/file` |
| Links | `GET/POST/DELETE /links` |
| Ingest | `POST /ingest`, `GET /ingest/:id` |
| Audit | `GET /audit`, `GET /audit/summary`, `GET /audit/:eventId` |
| Tokens | `GET/POST/DELETE /tokens[/:id]` (admin only) |

`GET /health` reports version, migration state, usage and storage;
`?strict=1` turns a degraded health result into `503`.

## 5. Optimistic locking

Every write path is version-checked: send `If-Match: <version>` (or
`ifVersion` in the body). A mismatch returns `409 version_conflict` with the
current record in `error.current`; re-read, merge, retry once. On bugs,
`PATCH` shallow-merges `payload`, so fields can be reported first and
verification evidence added later; a `null` value deletes a key.

## 6. Reports and evidence

```text
POST /reports                 -> report metadata; keep report.id
PUT  /reports/:id/files?path=&role=readme|log|screenshot|attachment
                              -> raw bytes; sha256/size computed server-side
GET  /reports/:id/file?path=  -> raw file plus X-Vault-Content-Sha256 header
POST /links                   -> {"reportId","bugId","role":"evidence"}
```

Storage is content-addressed: uploading the same screenshot or log twice keeps
one object and bumps the reference count. Limits: one file up to
`VAULT_MAX_UPLOAD_BYTES` (default 64 MB), JSON body up to
`VAULT_MAX_BODY_BYTES` (default 4 MB); over the limit is `413
payload_too_large`. A bug package needs its Readme, logs and screenshots.

## 7. Ingest idempotency
`POST /ingest` is keyed by `(project, source_path, content_sha256, kind)`: the
same package ingested twice is deduplicated. Track a run with `GET /ingest/:id`.

## 8. Audit

Every write, rejected forgery and authorisation failure appends an
`audit_events` row (actor from token, action, entity, outcome, status code,
before/after, request id). Query with `GET /audit?action=&entity=&entity_id=`,
aggregate with `GET /audit/summary`, fetch one with `GET /audit/:eventId`.
Cross-project events are `404` for a token outside the project.

## 9. Migrations, backup, restore and retention

```bash
node scripts/vault-migrate.mjs            # apply pending migrations
node scripts/vault-migrate.mjs partitions # create/verify monthly partitions
node scripts/vault-backup.mjs             # logical snapshot + per-table sha256 manifests
node scripts/vault-restore-check.mjs      # temporary database: migrate, import, compare
node scripts/vault-retention.mjs          # dry run; --apply performs it in a safe order
```

Pair the logical backup with a filesystem snapshot of `VAULT_DATA_DIR` and
rehearse the restore drill. For a large report archive, import explicitly:
`vault-import.mjs --dry-run`, then `--report <file> --mapping <file>`; compare
with `vault-reconcile.mjs` and `vault-dual-read.mjs`; roll back with
`--rollback-run <runId>`. Gates and rollback checklist: the cutover runbook.

## 10. Studio integration

`studio doctor` probes `<vault-url>/api/v1/health` and reports `vault` as
`degraded` (never `fail`) when the service is absent. To make viewer
transitions write the authoritative record, start the viewer with
`SPECVIEWER_VAULT_WRITE=1` and `STUDIO_VAULT_WRITER_TOKEN_FILE`; otherwise
transitions only touch the Markdown cache. See [studio-bug](../studio-bug/SKILL.md).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401 unauthorized` | Missing/malformed/revoked token; re-issue and update the token file. |
| `403 insufficient_role` | Use a `writer` token for writes, `admin` for tokens/projects. |
| `403 project_forbidden` / `no_project_scope` | Token does not cover that project; send `X-Vault-Project` or issue a scoped token. |
| `409 version_conflict` | Stale `If-Match`; re-read `error.current`, merge, retry. |
| Health `503` with `strict=1` | Pending migrations or degraded storage; check `/health`, `/migrations/status` and the data directory. |

## Related skills

- [studio-bug](../studio-bug/SKILL.md) - who reports bugs and uploads evidence.
- [studio-workspace](../studio-workspace/SKILL.md) - where Vault sits in a workspace.
- [Skills index](../README.md) - installation and trigger phrases.
