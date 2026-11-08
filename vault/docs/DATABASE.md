# Database and record design

This document is the single reference for the Vault data layer: storage model,
partitioning, lifecycle and retention, backup and restore, audit, id mapping,
object storage, search, capacity planning and the upgrade path.

Applies to Vault **0.1.2** (schema migrations `001`-`007`).

## 0. Design principles

1. **PostgreSQL is the single source of truth.** Metadata, state and indexes live
   in PostgreSQL; object bytes live in the object store addressed by SHA-256,
   and PostgreSQL only stores pointers and reference counts.
2. **Everything can be rebuilt.** Objects are deduplicated by SHA-256, the search
   index can be rebuilt from PostgreSQL plus the object store, and nothing lives
   only in the index.
3. **Append-only migrations.** `migrations/NNN_*.sql` files are added, never
   edited: `schema_migrations.checksum` drift is a hard error. Destructive
   changes use expand/contract.
4. **Soft delete first.** Deletion is a `deleted_at` marker; physical cleanup
   only happens through the retention script, which is dry-run by default and
   auditable.
5. **No credentials in the database or the repository.** Tokens are stored as
   `sha256(secret)`; database passwords and backup secrets live in the
   deployment environment or user-scoped credential files.

## 1. Data domains and storage layers

| Layer | Component | Contents | Rebuild / replay |
|---|---|---|---|
| Metadata / index | PostgreSQL 16+ | projects, tokens, bugs, reports, files, links, test runs, ingest jobs, audit events, migration ledger | Logical snapshots plus your file-level backups |
| Object bytes | Object store: filesystem today, MinIO target | screenshots, logs, attachments (SHA-256 addressed + refcount) | Re-importable from the source report archive |
| Full-text search | OpenSearch (incremental) | text chunks of report files (512 KB chunks) | Rebuildable from PostgreSQL + object store, can be dropped at any time |
| Local cache / tooling | Studio / operator machine | report package source, import intermediates | Never authoritative |

Data-domain ownership: bugs, report packages and test runs live **only** in
Vault; briefs and spec documents live in the shared repository / game
repository; the knowledge base is local to a Studio workspace.

## 2. Schema (migrations 001-007)

| Table | Purpose | Key columns | Partition / index |
|---|---|---|---|
| `schema_migrations` | Migration ledger | version(PK) / checksum / applied_at / execution_ms | PK(version) |
| `projects` | Project registry (the token-scope isolation key) | id(PK) / name / settings | PK(id) |
| `tokens` | API tokens | id(PK) / token_hash / projects(jsonb) / role / revoked_at | idx(token_hash) |
| `bugs` | Bug tickets | id(uuid) / project_id / legacy_id / status / severity / assignee / fingerprint / payload / version / deleted_at | **RANGE(created_at)**; PK(id, created_at); idx(project, created_at DESC) / (project, legacy_id) / (project, status) |
| `bug_legacy_index` | 8-digit legacy id <-> internal UUID | (project_id, legacy_id)(PK) / bug_id / bug_created_at | PK(project, legacy_id); idx(bug_id) |
| `reports` | Evidence artefact metadata | id(uuid) / project_id / kind / title / storage_tier / restore_status / payload / deleted_at | **RANGE(created_at)**; PK(id, created_at); idx(project, created_at DESC) |
| `report_files` | File manifest of a report | (report_id, path)(PK) / sha256 / size_bytes / role | PK; idx(sha256) |
| `report_links` | Bug <-> report N:N | (report_id, bug_id, role)(PK) | PK; idx(bug_id) |
| `blobs` | Object registry / reference counts | sha256(PK) / size_bytes / bucket / object_key / refcount / storage_tier | PK(sha256) |
| `test_runs` | Test execution records | id(uuid) / project_id / kind / status / summary / started_at / finished_at | **RANGE(started_at)**; PK(id, started_at); idx(project, started_at DESC) |
| `test_run_steps` | Step details | (run_id, step_id)(PK) / status / detail | PK |
| `ingest_jobs` | Ingest job state machine | id(uuid) / project_id / kind / source_path / content_sha256 / status / attempts / report_id | PK(id); **unique idempotency key** (project, source_path, content_sha256, kind); idx(status, created_at) |
| `audit_events` | Audit events (before/after) | event_id(uuid) / project_id / actor / action / entity / outcome / status_code / before / after / details / request_id | **RANGE(created_at)**; idx(project, created_at DESC) / (actor, created_at DESC) |
| `migration_runs` | Import run ledger | id(uuid)(PK) / project_id / kind / source / mode / status / counters / notes | PK(id); idx(project, started_at DESC) |
| `migration_items` | Run details (legacy <-> UUID <-> report) | (run_id, kind, entity_id)(PK) / source_path / content_sha256 / legacy_id / extra | PK; idx(project, source_path); idx(project, legacy_id) |

### 2.1 Partitioning

- Partitioned parent tables: `bugs`, `reports`, `test_runs`,
  `audit_events`. All use **monthly RANGE partitions plus a DEFAULT
  partition**, so out-of-range rows are never lost.
- The partition key must be part of a unique constraint in PostgreSQL, which is
  why the primary keys are `(id, created_at)` / `(id, started_at)`. Lookups by
  id scan the partitions (fast at the current data volume).
- Monthly partitions are maintained by `node scripts/vault-migrate.mjs
  partitions`; the service also fills in recent months on startup. Old
  `audit_events` partitions can be dropped to trim audit history efficiently
  (the retention script does this automatically).
- For very large deployments, secondary partitioning by project (or hash
  partitioning) is the documented expansion path via expand/contract migrations.

## 3. Record lifecycle

```text
report package (game repo) --import--> ingest_jobs (pending -> running -> succeeded)
      |                                     |
      +-- file sha256 --> blobs(refcount++) --> object store (fs / MinIO)
      |
      bugs (get-or-create by legacy_id) <-- report_links --> reports (one per package) --> report_files (one per file)

lifecycle: hot (searchable, storage_tier='hot')
             --365d--> cold (archived, storage_tier='cold', still queryable)
             --730d--> deleted_at (soft delete) --retention--> physical purge (object GC)
```

| State | Trigger | Columns | Queryable |
|---|---|---|---|
| hot | default on ingest | `storage_tier='hot'`, `deleted_at=NULL` | yes |
| cold (archived) | retention `--apply` (reports older than 365 days) | `storage_tier='cold'` | yes (included by default) |
| soft-deleted | retention (reports older than 730 days and not linked to an open bug) or manual | `deleted_at=now()` | no by default (visible with `include_deleted`) |
| purged | object GC (`refcount<=0` and older than the grace period) | row and object removed | no |

**Open-bug exemption:** reports linked to a bug whose status is not one of
`closed`, `fixed`, `duplicate`, `wontfix`, `cannot_reproduce`,
`false_red` are never expired automatically.

## 4. Retention and archival

| Data | Default retention | Action | Script parameters |
|---|---|---|---|
| reports (evidence) | archive after 365 days / expire after 730 days | `storage_tier=cold` / `deleted_at` | `--report-archive-days / --report-retain-days` |
| audit_events | 180 days | drop old partitions, then delete remaining rows | `--audit-days` |
| ingest_jobs (succeeded/failed) | 90 days | delete job rows | `--ingest-days` |
| blobs garbage (`refcount<=0`) | 24-hour grace | delete object + row | `--blob-grace-hours / --max-blob-deletes` |

```bash
node scripts/vault-retention.mjs                                  # dry run, all projects
node scripts/vault-retention.mjs --project demo-project --report retention.json
node scripts/vault-retention.mjs --apply --project demo-project --report retention.apply.json
```

- The script outputs JSON: `candidates` (dry-run counts) and `actions`
  (actually archived/deleted counts after `--apply`); `--report` writes it
  to a file.
- **Execution order:** audit cleanup -> report archival -> report expiry ->
  ingest cleanup -> blob GC (GC last, so references are released first).
- Production rule: take a logical backup before `--apply`, and rehearse with
  a small threshold or an isolated project first.

## 5. Backup and restore

| Layer | Method | Frequency / retention | Location |
|---|---|---|---|
| PostgreSQL (logical) | `scripts/vault-backup.mjs`: per-table row counts + per-table SHA-256 manifest | daily (deploy example: 04:30 task) | configurable output directory (for example `<data-dir>/backup/vault-daily-*`) |
| PostgreSQL (native dump) | `pg_dump -Fc` when a native client is available | daily | your backup repository |
| Object bytes | file-level backup or filesystem snapshot of the object directory (MinIO: its own replication/ILM) | daily | your backup repository |
| Restore drill | `scripts/vault-restore-check.mjs`: temporary database -> migrate -> import -> per-table row counts + content hashes + sampling | monthly / at every RTO rehearsal | evidence directory outside the repository |

- Target **RPO <= 24 h / RTO <= 4 h**: a logical snapshot takes well under a
  minute, and recovery is the apply-migrations + import path.
- Restore steps: restore the logical snapshot (and the object directory) into a
  new location, run the restore check, then switch the service configuration.
  For a whole-database rollback, restore into a new database and repoint
  `VAULT_PG_DB` / the connection string instead of overwriting the live
  database.
- Do **not** back up the running PostgreSQL data directory with a file copy:
  it is not consistent while the server is running. Use the logical snapshot
  (or `pg_dump`) for database content.

## 6. Audit and compliance

| Field | Meaning |
|---|---|
| `event_id` | UUID; `GET /api/v1/audit/:eventId` fetches one event. |
| `project_id` | Nullable (events without project context, e.g. authentication failures). |
| `actor` | **Derived from the token** (`token:<label>`) or `anonymous`; client forgery is rejected. |
| `action` | See the event catalog below. |
| `entity/entity_id` | bug / report / token / project / ingest_job ... |
| `outcome/status_code` | `ok` / `conflict` (409) / `denied` (401/403) |
| `before/after` | JSON snapshots of the change (sensitive fields excluded). |
| `details` | Additional context (legacy conflict, created flag, ...). |
| `request_id/remote_addr` | Request tracing. |

Event catalog: `auth.denied`, `auth.forged_author_rejected`,
`project.create`, `bug.create`, `bug.update`, `report.create`,
`report.link`, `report.unlink`, `ingest.create`, `token.create`,
`token.revoke`.

Queries (all require a token; project events plus the caller's own events are
visible):

```bash
GET /api/v1/audit?limit=50&offset=0&action=bug.update&actor=token:dev-a&outcome=conflict&since=2026-10-01T00:00:00Z
GET /api/v1/audit/summary?since=2026-10-01T00:00:00Z
GET /api/v1/audit/<eventId>
```

Retention defaults to 180 days (the retention script cleans it). Compliance
exports can read the rows through SQL or the API; `before/after` are jsonb.

## 7. IDs and mapping

| ID | Shape | Authority | Use |
|---|---|---|---|
| In-game bug id | 8 digits (`\d{8}`) | game-side identity (may repeat across worktrees) | `bugs.legacy_id`; looked up by `(project, legacy_id)` |
| Internal UUID | `bugs.id` / `reports.id` / `migration_runs.id` | Vault identity | Primary keys, audit, rollback, API |
| Composite key | `(project_id, legacy_id)` | Migration deduplication rule | `bug_legacy_index` keeps the **first** mapping; a repeated 8-digit id returns `legacyConflict` |
| Object key | SHA-256 (content addressed) | Byte identity | `blobs.sha256` + `object_key=<sha2>/<sha4>/<sha>` |

- **Import run ledger:** `migration_runs` (run status + counters) and
  `migration_items` (source_path / content_sha256 / legacy_id / entity_id /
  extra) support per-run rollback (`vault-import --rollback-run`) and the
  legacy <-> UUID mapping export (`--mapping`).
- Duplicate packages across worktrees: one report row per package, bugs
  deduplicated by legacy id, and `report_links` expresses the N:N relation
  (one bug can have evidence from several packages) without double writing.

## 8. Object storage (filesystem -> MinIO)

| Driver | Status | Layout | Configuration |
|---|---|---|---|
| fs | default and production-ready | `VAULT_DATA_DIR/objects/<sha[0:2]>/<sha[2:4]>/<sha>` | `VAULT_OBJECT_STORE=fs` |
| minio (S3-compatible) | implemented (SigV4, zero dependency); deploy-time integration | same key layout: `<bucket>/<sha2>/<sha4>/<sha>` | `VAULT_OBJECT_STORE=minio` + `VAULT_MINIO_ENDPOINT/BUCKET/USER/PASSWORD[/REGION]` |

- `blobs` records `bucket` (`vault-fs` for the filesystem driver,
  `VAULT_MINIO_BUCKET` for MinIO) and `object_key` in the same SHA layout, so
  switching the backend does not change database semantics.
- Reference counting: each imported file increments `refcount`; run
  rollback / report expiry decrements it; an object is removed only when the
  count reaches zero and the grace period has passed.
- MinIO migration steps (plan a deployment window): start MinIO and create the
  bucket -> set `VAULT_OBJECT_STORE=minio` and the MinIO variables -> rebuild
  the objects from the filesystem data (content addressing makes this a
  straight copy; `blobs.bucket` can be updated in bulk) -> verify read-back
  SHA-256 values.
- Cold tier: MinIO lifecycle rules move objects older than 365 days to a cold
  bucket while keeping `storage_tier='cold'` metadata; with the filesystem
  driver the cold tier relies on your backup/archival system.

## 9. Search (OpenSearch, rebuildable)

- Index `vault-reports-v1` (filtered by project; fields: report_id, bug_id,
  legacy_id, kind, path, chunk_index, text, sha256, created_at).
- Chunking: text files larger than 512 KB are split into 512 KB chunks with
  64 KB overlap; each chunk records the source file sha256 and offset, and a hit
  resolves the original through `report_files`.
- Rebuild: read `report_files` + object bytes from PostgreSQL, chunk, bulk-index.
  The index can be dropped and rebuilt without affecting PostgreSQL truth.
- **Three access channels, one query service:** REST (implemented,
  `/api/v1/*`), a CLI (planned) and an MCP server (planned) share the same
  query service and permission model (token-scope 403 semantics).
- Transitional fallback: filter by `report_files` path/metadata in PostgreSQL
  until full-text search is wired up; report text lives mostly in objects.

## 10. Capacity and growth

Sizing formula used for planning:

```text
total storage ~= raw data x 4.2
  (raw 1 + index 0.2 + replicas 2 + backup 1; cold tier counted separately)

minimum hardware: 8 cores / 32 GB RAM / 2 TB data disk + 2 TB backup disk
capacity alert threshold: 80%
```

| Item | Sizing note |
|---|---|
| Raw archive | Sum of the report packages (average package size x package count). |
| Deduplicated objects | Content addressing removes duplicate screenshots/logs across worktrees; expect a few percent saving on real archives. |
| Total footprint | Raw x 4.2 for the estimate above. |
| Monthly growth | packages per month x average package size; multiply by 4.2 for the total footprint. |
| Disk lifetime | data disk capacity / monthly growth (apply the 80% threshold). |

Monitor usage through `GET /api/v1/health` (projects/bugs/reports/testRuns/blobs/
bytes) and `GET /metrics`; the retention script reports archived/deleted
counts. Alert at 80% of disk capacity.

## 11. Deployment upgrade path

1. **Compose:** pull the new code and run `docker compose up -d --build`. The API
   applies pending migrations on startup; keep a database backup before a
   version jump that includes new migrations.
2. **Windows example:** deploy the new application tree next to the existing
   one, stop the API task, point it at the new tree, start it and verify
   `GET /api/v1/health`. The deployment script is idempotent and keeps the
   existing PostgreSQL cluster and environment file.
3. **systemd:** replace `/opt/vault/app` with the new tree, keep
   `/etc/vault/vault.env`, then `sudo systemctl restart vault`.
4. After any upgrade: check `GET /api/v1/migrations/status` (pending = 0),
   run the deployment verification (health, tasks, backup) and keep the output.

## 12. Operations command reference

```bash
node scripts/vault-migrate.mjs --status|--create-database|partitions
node scripts/vault-token.mjs create|list|revoke|verify
node scripts/vault-backup.mjs --out <dir> --label daily
node scripts/vault-restore-check.mjs --snapshot <snapshot.json> --target pg --sample 10
node scripts/vault-retention.mjs [--apply] [--project p] [--report <file>]
node scripts/vault-import.mjs --dry-run|--report|--rollback-run <id> --purge-bugs
node scripts/vault-reconcile.mjs --report <file>
node scripts/vault-dual-read.mjs --sample 10 --report <file>
node scripts/vault-status.mjs --project <p> --report <file>
```

## 13. Change log

- 0.1.2: audit queries/aggregate/by-id, migration-run queries, retention script
  (dry-run/apply), MinIO S3 driver (SigV4), priority migration.
- 0.1.1: PostgreSQL and in-memory stores, content-addressed object store, token
  scopes, optimistic locking, backup and restore checks.
- 0.1.0: schema `001`-`006` (partitioning, idempotency keys, audit, migration
  ledger), filesystem object storage, initial operational scripts.

## 14. Optional create-only report identity (migration 008)

POST /api/v1/reports with a supplied UUID and If-None-Match: * claims that UUID once across
report time partitions. A collision is 409; existing clients without the header keep their API.
The report_identity_index primary key is claimed in the same transaction as report creation.
The memory store enforces the same create-only contract. IDs already present in older reports
are also rejected, including after a logical restore that rebuilds the identity index lazily.
Do not remove the append-only migration on rollback; disable consumers before rolling back code.

Performance evidence reuses reports, report_files, content-addressed blobs and report_links.
performance-run stores an immutable manifest; files must match its declared SHA and byte length.
performance-receipt records a completed manifest hash only after independent byte verification.
Missing receipts mean partial, not PASS. performance-comparison links trusted external analysis;
clients cannot elevate imported observations into approved baselines.

Health adds capabilities.reportCreateOnly and capabilities.performanceArtifactIntegrity. New
performance clients require both. Deploy/migrate the producer first, then the clients. PostgreSQL
migration/concurrency must be tested on an isolated database before production rollout; memory
acceptance tests are not proof of a completed PostgreSQL deployment.
# Permanent workspace archives

Reports with kind `workspace-archive` hold manifest-indexed source material and recovery data.
Automatic report expiration excludes them, including unsealed uploads; administrators must
explicitly review abandoned uploads. They may receive cold-tier metadata without losing files.
Filesystem objects can live on a separate capacity disk using `VAULT_OBJECTS_DIR`; PostgreSQL
metadata and content-addressed files must both be included in the backup/recovery plan.

