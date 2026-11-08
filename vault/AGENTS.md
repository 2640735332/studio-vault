# AGENTS.md - Vault service conventions

## Scope and boundaries

- `vault/` is the server side of the Studio toolkit: a data service that keeps PostgreSQL as the
  metadata/index source of truth and stores report objects on the filesystem or MinIO. It contains
  no game runtime code and no game assets.
- The runtime is zero-dependency: Node standard library only (`node:*`); tests use `node:test`.
  Adding a dependency requires a justification in the change description (the default is no).
- Node >= 22.5 is required.

## Layout and write surfaces

- Service code -> `src/`; SQL migrations -> `migrations/`; ops/import CLIs -> `scripts/`; tests -> `test/`.
- Deployment assets -> `deploy/` (compose / systemd / Windows / cutover runbook / monitoring);
  the root `Dockerfile` builds the API image only.
- Docs: `README.md` (users), `docs/DATABASE.md` (data model / lifecycle / retention),
  `deploy/README.md` (deployment), `AGENTS.md` (this file).

## Must be green before committing

```bash
node --check src/server.mjs
node --test "test/*.test.mjs"
node scripts/vault-selftest.mjs --driver memory   # when touching API/authz/import/backup
```

## Database change discipline (hard)

- Migrations are append-only: only add `migrations/NNN_*.sql`; never edit an applied migration
  (`schema_migrations.checksum` drift is a hard error).
- Destructive changes use expand/contract (add -> dual write/backfill -> remove) and document the
  rollback path in `docs/DATABASE.md`.
- Changes to partitioned tables (bugs/reports/test_runs/audit_events) must update the
  partition/retention sections of `docs/DATABASE.md`.
- Every schema change must be covered by tests; the in-memory and PostgreSQL stores keep the same
  interface.

## API compatibility

- `/api/v1` is frozen: additive fields and optional parameters only. Removing or changing behavior
  requires `/api/v2` plus one release cycle of N-1 client compatibility.
- Authentication and audit cannot be bypassed: the project is derived from the token, the author is
  derived from the token, a client-supplied author is rejected, and an unauthorized (403) access
  writes an `audit_events` row.

## Security

- Tokens, passwords and private keys never enter the repository: `.env` is gitignored and only
  `.env.example` templates with placeholders are committed.
- Deployment credentials stay on the host (ACL-restricted env file, backup password file,
  monitoring admin file) and are never written into repository files.

## Commits and releases

- Conventional Commits (`feat`/`fix`/`docs`/`chore`...); commit each completed change.
- Release: semver tag `vX.Y.Z`; before tagging, tests are green and `deploy/` plus
  `docs/DATABASE.md` are in sync.

## Deployment script conventions

- Windows scripts executed by the Task Scheduler must be ASCII-only (PowerShell 5.1 may silently
  refuse non-ASCII scripts).
- After changing `deploy/windows/*` or `deploy/docker-compose.yml`, update the paths and commands
  in `deploy/README.md`.
