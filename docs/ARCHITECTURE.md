# Architecture

This document describes how the two halves of the repository work and how they
fit together:

- **Studio** - the local, file-based toolchain in `packages/`: it turns the
  documents of a game project into a workflow, serves a local viewer and keeps a
  team shared repository in sync.
- **Vault** - the data service in `vault/`: PostgreSQL metadata, a
  content-addressed object store and a REST API for bug tickets, report
  packages and audit events.

Both are zero-runtime-dependency Node.js projects (Node.js standard library
only) and both are MIT licensed.

```
game repository (Studio workspace)                        team shared repo (Git)
+-------------------------------------------+            +---------------------+
| studio.config.json                        |            | docs/briefs/...     |
| docs/briefs/                              |  sync /    | (brief mirror)      |
| specs/<package>/<track>/                  |  commit /  +----------+----------+
| game/reports/bugs/                        |  watch /              ^
| game/src/data/ + game/src/schemas/        |  bootstrap            |
|                                           |                       |
| Studio CLI --+                            |            single-writer lock,
|              +-- viewer server :3456      |            journal, push retry
|              +-- doctor / kb / bug        |
+----------------------+--------------------+
                       | REST /api/v1, Bearer token
                       v
+-------------------------------------------+
| Vault service                             |
|  HTTP API - auth - audit - metrics        |
|  PostgreSQL (metadata, partitions)        |
|  object store (sha256, fs or MinIO)       |
+-------------------------------------------+
```

## 1. Studio

### 1.1 Package layers

| Package | Role | Notes |
|---|---|---|
| `@studio/shared` (`packages/shared`) | Zero-dependency primitives | JSON atomic IO, sha256, a `git` wrapper that never shells out, LFS pointer parsing, file-tree walking with junction/symlink detection, doctor level evaluation (`ok` / `degraded` / `fail`), argument parsing, error payloads. |
| `@studio/local` (`packages/studio`) | The local runtime | Config resolution, mirror engine, write-transaction lock, journal, copy-back (`commit`), bootstrap, doctor, knowledge base (`kb`), bug import, Vault snapshot sync, and the viewer server in `src/serve/`. |
| `@studio/cli` (`packages/cli`) | The entry point | `bin/studio-cli.js` forwards to `@studio/local`. If the package is not installed, it falls back to the vendored `packages/studio/src/index.js`, so a fresh clone runs without `npm install`. |

The services themselves stay small: the CLI layer only parses and dispatches,
`@studio/shared` only holds primitives, and all behaviour lives in
`@studio/local`.

### 1.2 Workspace layout and configuration

A Studio workspace is an ordinary Git repository (usually the game repository)
with a `studio.config.json` at its root. The config is validated by
`packages/shared/schema/studio.config.schema.json` and contains no secrets:

| Key | Meaning |
|---|---|
| `version` | Schema version (currently `1`). |
| `project.id` / `project.name` / `project.gameRepo` | Project identity. |
| `shared.repo` / `shared.branch` / `shared.remote` / `shared.root` | The team shared repository and where it is checked out (`STUDIO_SHARED_ROOT` overrides `shared.root`). |
| `shared.mirror` | Must be `docs/briefs`: the mirrored subset of the shared repo. |
| `shared.lfs` | LFS handling mode (`text` / `binary` / `all` / `none`). |
| `vault.url` / `vault.project` | Vault endpoint used by the doctor and the Vault write channel. |
| `studio.port` / `studio.worktreePortBase` | Viewer port (default `3456`) and per-worktree port allocation. |
| `kb.namespace` | Namespace for the local knowledge-base index. |

**Root discovery.** `loadConfig` first asks Git for the repository top level;
if the directory is not inside a Git repository it walks upwards looking for a
directory that contains both `studio.config.json` and `specs/`. This is why
`init` is dispatched *before* config loading - it has to work in a directory
that does not have a config yet.

**Machine-local state** never enters the repository. It lives under
`~/.studio/` (overridable with `STUDIO_HOME`):

| Path | Purpose |
|---|---|
| `~/.studio/workspace.json` | Local workspace registry (tokens are only credential references). |
| `~/.studio/locks/<project>.shared.lock` | Single-writer lock for shared-repo commits. |
| `~/.studio/journal/<project>/` | Pending write-backs captured before the mirror is rebuilt. |
| `~/.studio/cache/<project>/kb-shared.db` | Knowledge-base index (`node:sqlite`). |

### 1.3 Shared-repository mirror workflow

Briefs are authored in a team shared repository and mirrored into
`docs/briefs/` inside the game repository, where the viewer and the game
tooling read them.

1. `studio bootstrap` clones `shared.remote` into `shared.root`, pulls text
   LFS objects, materialises the mirror and installs the hooks path.
2. `studio sync` rebuilds the mirror from the shared checkout. Content that
   has not been written back yet is saved to the journal before the mirror is
   replaced. Junctions are rejected - the mirror must be real copies so that
   tooling cannot accidentally write through it.
3. `studio commit` runs inside the write-transaction lock: it copies mirror
   changes back, creates a single commit in the shared repo and pushes with
   retries. `studio watch` does the same on a poll interval, and the
   pre-commit hook is the second line of defence.
4. `studio mirror-switch` is the planned path for changing the mirror strategy
   (dry-run by default; `--execute` to apply).
5. `studio status` reports the mirror diff, pending write-backs and journal
   state without modifying anything.

### 1.4 CLI dispatch and output contract

`packages/studio/src/index.js` owns the command registry. Each command module
exports `name`, `summary`, `usage` and `run()`. The dispatcher:

- parses global boolean/value flags (`--json`, `--cwd`, `--out`,
  `--force`, `--dry-run`, ...),
- loads the workspace config unless the command sets `needsConfig = false`
  (only `init` does),
- prints either a human-readable summary or the JSON report with `--json`,
- returns a process exit code (`0` success, `2` usage/config errors,
  `1` failures). `degraded` doctor results still exit `0`.

### 1.5 Viewer server and data flow

`studio serve` spawns `packages/studio/src/serve/server.js` in the workspace
root. The server is a single zero-dependency Node `http` process:

- **Startup self-healing.** It creates `specs/`, `docs/briefs/`,
  `game/reports/bugs/` and `game/src/data/` if they are missing, then starts
  a filesystem watcher on the data directory. A fresh workspace therefore
  never fails just because a directory has not been created yet.
- **Network surface.** It binds `127.0.0.1` by default. `--bind <addr>` or
  `SPECVIEWER_BIND` changes the interface; `--allow-lan` /
  `SPECVIEWER_ALLOW_LAN=1` makes the intent explicit. `--readonly` /
  `SPECVIEWER_READONLY=1` rejects every write endpoint.
- **Read endpoints** (all local files): `/api/briefs`, `/api/bugs`,
  `/api/packages`, `/api/domains`, `/api/data`, `/api/ui-kit`,
  `/api/pulse`, `/api/changes`, `/api/diff`.
- **Write endpoints:** `PATCH /api/data/<stem>/<id>` edits whitelisted JSON
  data-table entries; `POST /api/specviewer/transition` performs a status
  transition; `POST /api/sync` asks the server to refresh the local bug
  snapshot from Vault (rate-limited unless `force` is set).
- **Views.** The browser app (`templates/viewer/`) has eight modes:
  `pulse` (dashboard / search), `briefs`, `specs` (package and track
  documents), `domains`, `bugs` (list and detail with evidence and
  verification data), `performance` (evidence bundles, run comparison and
  trends), `data` (JSON data tables with a schema-aware editor) and `uikit`
  (the UI control inventory).

Data flow is one-way at the viewer level: the server reads the workspace,
the browser renders, and writes go back through the explicit endpoints above.

### 1.6 Status transitions

The transition engine (`src/serve/transition.js`) implements a small,
explicit state machine for both item types.

**Brief** (`docs/briefs/<folder>/BRIEF.md`) statuses:
`草稿` (draft) -> `可交 spec-engine` (ready) -> `实现中` (in progress) ->
`已实现` (done), with `已否决` (rejected) as a terminal branch. Actions:
`mark_ready`, `start_impl`, `mark_done`, `reject`, `send_back`,
`undo`, `interrupt`. A brief transition is self-contained: it rewrites the
`状态:` line of the Markdown file and keeps the rest of the document intact.

**Bug** (`game/reports/bugs/<folder>/Readme.md`) statuses: `新` (new) ->
`修复中` (in progress) -> `已关闭` (fixed), with `已关闭 · 非缺陷`
(false red) and `已关闭 · 重复` (duplicate) as close reasons. Actions:
`start_fix`, `mark_done`, `close_false_red`, `close_duplicate`,
`reopen`, `interrupt`. A bug transition has two write targets:

1. **Vault first** when the Vault write channel is enabled
   (`SPECVIEWER_VAULT_WRITE=1` plus a writer token file). The server resolves the
   legacy 8-digit id, PATCHes the Vault bug with an `If-Match` version, and
   refreshes once on a `409` before giving up.
2. **The local `Readme.md`**, which acts as a display cache. If Vault writing
   fails, the transition fails explicitly instead of silently drifting.

Optionally the engine also updates a `BUG.md` overview row in
`specs/<package>/<track>/BUG.md`. That step is best-effort: when the target
repository does not provide the helper script, the transition still succeeds
and reports `trackRow: skipped_no_script`.

The response contract is `{ ok, from, to, skipped?, statusWritten, trackRow, vault }`.

### 1.7 Doctor

`studio doctor` evaluates named checks and returns a graded report:

| Check | What it looks at |
|---|---|
| `shared` | Shared repo configuration and checkout. |
| `mirror` | Mirror exists, is not a junction, and matches the shared checkout. |
| `lfs` | LFS availability and remaining text pointers in the mirror. |
| `budget` | Shared-repo pack size budget. |
| `kb` | Knowledge-base index state (and whether `node:sqlite` is available). |
| `vault` | Vault health probe; unreachable or missing credentials are `degraded`, never `fail`. |
| `assets` (optional) | Asset manifest checks. |

`ok` and `degraded` both exit `0`; only `fail` exits non-zero. This is
deliberate: a single-machine workspace without a shared repository or a running
Vault is a valid setup.

### 1.8 Knowledge base

`studio kb` builds a local full-text index of shared text into
`~/.studio/cache/<project>/kb-shared.db` using Node's built-in
`node:sqlite`. Because that module only exists on Node.js 22.5 and newer,
the command degrades to a clear `node_sqlite_unavailable` error on older
runtimes instead of crashing the process. Everything else in Studio does not
require SQLite.

## 2. Vault

Vault is a standalone HTTP service. It is deployed separately from the game
repository and is the only writer of bug and report data.

### 2.1 Process and configuration

`vault/src/server.mjs` starts an HTTP server (default
`127.0.0.1:3460`, change with `VAULT_BIND` / `VAULT_PORT`). Configuration is
environment-based (see `vault/.env.example`):

| Variable | Purpose |
|---|---|
| `VAULT_DB` | `memory` (development / selftest, non-durable) or `pg` (production). |
| `VAULT_PG_HOST/PORT/USER/PASSWORD/DB` (or `DATABASE_URL`) | PostgreSQL connection. |
| `VAULT_DATA_DIR` | Root for object storage and backup manifests. |
| `VAULT_OBJECT_STORE` | `fs` (default) or `minio`. |
| `VAULT_MIGRATE_ON_START` | Apply pending migrations on startup (default on). |
| `VAULT_DEV_SEED` | Seed development projects/tokens (must be `0` in production). |
| `VAULT_LOG_LEVEL` | Structured JSON logging level. |

### 2.2 HTTP API surface

All routes live under `/api/v1`. Full request/response details for the
reporting flow are in
[vault/docs/API-DIRECT-REPORT.md](../vault/docs/API-DIRECT-REPORT.md).

| Area | Routes |
|---|---|
| Health / ops | `GET /health`, `GET /metrics` |
| Projects | `GET /projects`, `GET /projects/:project`, `POST /projects` |
| Bugs | `GET/POST /bugs`, `GET /bugs/by-legacy/:legacyId`, `GET/PATCH /bugs/:id` |
| Reports | `GET/POST /reports`, `GET /reports/:id`, `PUT /reports/:id/files`, `GET /reports/:id/file` |
| Links | `GET/POST/DELETE /links` |
| Ingest | `POST /ingest`, `GET /ingest/:id` |
| Audit | `GET /audit`, `GET /audit/summary`, `GET /audit/:eventId` |
| Migrations | `GET /migrations/status`, `GET /migrations/runs[/:id[/items]]` |
| Tokens | `GET/POST/DELETE /tokens[/:id]` (admin only) |

### 2.3 Authentication and authorisation

- Tokens look like `vt_<id>_<secret>` and are sent as
  `Authorization: Bearer ...` (or `X-Vault-Token`). The database stores only
  `sha256(secret)`; the plaintext is returned once, at creation.
- A token carries a **scope**: a list of projects, plus a role
  (`reader`, `writer`, `admin`). Reads need `reader`, writes need
  `writer`, and token/project administration needs `admin`. Cross-project
  access is rejected with `403` and written to the audit trail.
- The **project and author are derived from the token**, never from the client.
  Supplying an author in the body, header or query string is rejected with
  `403 author_forged` and audited; reporters are identified in
  `payload.reporter` instead.
- All write paths use optimistic locking: a `PATCH` sends `If-Match: <version>`
  (or `ifVersion`) and receives `409 version_conflict` on mismatch, with the
  current bug in `error.current`.

### 2.4 Metadata model and migrations

The PostgreSQL schema (migrations `001`-`007`) is the single source of
truth for metadata: projects, tokens, bugs, bug legacy-id index, reports and
their files, links, blobs, test runs, ingest jobs, audit events and the
migration run ledger. `vault/docs/DATABASE.md` documents every table,
partitioning strategy, lifecycle and retention defaults.

Two rules matter architecturally:

- **Migrations are append-only.** Each `migrations/NNN_*.sql` file is applied
  once and checksummed in `schema_migrations`. Modifying an applied
  migration is a hard error; changes are new files (expand / contract).
- **Time-partitioned tables use monthly RANGE partitions plus a DEFAULT
  partition.** The partition key is part of the primary key
  (`(id, created_at)`), and monthly partitions are created by the migration
  tooling and on service start.

### 2.5 Object storage

Report files are stored by the SHA-256 of their contents:

- `report_files` records each file's path, hash, size and role;
  `blobs` records each hash once with a reference count.
- The filesystem driver writes `<data-dir>/objects/<sha[0:2]>/<sha[2:4]>/<sha>`;
  the MinIO driver uses the same key layout in a bucket.
- Deduplication is a consequence of content addressing: uploading the same
  screenshot or log twice stores it once and bumps the reference count.
  Retention removes objects only when the count reaches zero after a grace
  period.

### 2.6 Audit and observability

Every write, every rejected forgery and every authorisation failure appends an
`audit_events` row (actor derived from the token, action, entity, outcome,
status code, before/after snapshots, request id). `GET /audit` and
`GET /audit/summary` expose it inside the caller's project scope.
`GET /metrics` returns Prometheus text for request counts, latency, uptime
and queue sizes, and `GET /health` reports version, migration state, usage and
storage state.

### 2.7 Operational scripts

`vault/scripts/` contains the operator tooling. All scripts use the same
environment variables as the server:

| Script | Purpose |
|---|---|
| `vault-migrate.mjs` | Create the database, apply migrations, manage partitions. |
| `vault-token.mjs` | Create / list / revoke tokens, ensure the project exists. |
| `vault-status.mjs` | Project and migration status snapshot. |
| `vault-backup.mjs` | Logical snapshot with per-table row counts and sha256 manifests. |
| `vault-restore-check.mjs` | Restore drill: temporary database, migrate, import, compare. |
| `vault-retention.mjs` | Archive / expire reports, trim audit and ingest rows, garbage-collect blobs (dry-run by default). |
| `vault-import.mjs` | Import an archive of report packages; idempotent, resumable, roll-backable per run. |
| `vault-reconcile.mjs` | Compare source counts, database counts and migration items. |
| `vault-dual-read.mjs` | Sample packages and compare local files with Vault content hashes. |
| `vault-selftest.mjs` | Start the service and run the end-to-end acceptance matrix (memory or pg driver). |

## 3. How Studio and Vault connect

**Authority.** Vault is the authoritative writer for bug tickets and report
packages. Studio reads Vault through the REST API and treats the Markdown files
in the game repository as a readable, reviewable projection. The import tools
make the one-way flow explicit: packages are imported *into* Vault, never
exported from Vault back into the game repository.

**Snapshot refresh.** The viewer's `POST /api/sync` (and the bug import chain)
run the Vault sync module, which reads `/api/v1/bugs`, links and reports and
rewrites the local `Readme.md` snapshots (description, evidence, logs,
timeline, status mapped back to the canonical Markdown status). The status file
`game/reports/vault-sync.json` records the last sync.

**Status changes.** When Vault writing is enabled, a viewer status transition
PATCHes Vault first and then updates the local cache, so a later snapshot
refresh cannot revert the change. Without the write channel (the default for a
local workspace) transitions only touch Markdown, and `studio doctor` reports
Vault as `degraded` rather than failing.

**Offline behaviour.** Neither Studio nor the viewer requires Vault. A missing
Vault connection degrades the doctor check and skips the authoritative write
path; the file-based workflow keeps working. Vault itself never reads the game
repository, so it can be deployed, upgraded and backed up independently.

## 4. Design constraints

- **Zero runtime dependencies.** No npm packages at runtime; `npm install` only
  links workspaces. The test suites use `node:test`.
- **Files are the interface.** Briefs, bugs, specs and data live as plain files
  in the repository; Git is the history and the review mechanism.
- **Single writer.** Shared-repo writes go through one lock and one journal so
  that concurrent watchers cannot corrupt the mirror.
- **Explicit data movement.** Vault ingestion and cutover are operator commands,
  not background magic.
- **Fail loudly, degrade softly.** Configuration and data errors are explicit
  (usage errors exit `2`, failures exit `1`); optional dependencies such as
  Vault, LFS or the knowledge base degrade instead of blocking the workflow.