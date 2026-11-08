# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Studio packages and the Vault service are versioned independently.

## [0.1.18] - 2026-11-08

First public release. The sections below describe the open-sourcing pass;
earlier internal releases are summarised in the sections that follow.

### Added

- `studio init [--demo] [--force]`: scaffold a Studio workspace
  (`studio.config.json` plus `specs/`, `docs/briefs/`,
  `game/reports/bugs/`, `game/src/data`) and optionally generate a demo
  brief, bug report and data table so that a fresh clone can reach a working
  viewer in two commands.
- The viewer server now creates missing workspace directories at startup
  (`specs/`, `docs/briefs/`, `game/reports/bugs/`,
  `game/src/data`) instead of failing on a fresh workspace.
- Public project documentation: `README.md` / `README.zh-CN.md`,
  `docs/ARCHITECTURE.md`, `docs/QUICKSTART.md`, `CONTRIBUTING.md`,
  `CHANGELOG.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, GitHub issue
  and pull-request templates, and a continuous-integration workflow.
- `studio kb` reports a clear `node_sqlite_unavailable` error on Node.js
  versions without `node:sqlite` instead of crashing.

### Changed

- The repository is licensed under the MIT license, and package metadata is
  prepared for public distribution: MIT license field, repository/homepage/bugs
  URLs, description and keywords, and `engines.node >= 22.5` for every
  package.
- `serve` binds to loopback by default; `--bind`, `--allow-lan` and
  `--readonly` make the network and write surface explicit.
- The deployment documentation and configuration templates were rewritten for
  public use: neutral placeholders instead of a specific internal host, and
  generic Windows / Linux examples.

### Removed

- The optional image-generation integration (viewer mode, HTTP routes and
  static assets).
- The internal session-bridge and message-delivery surface from the viewer and
  the server; status transitions for briefs and bugs are fully local
  (`src/serve/transition.js`) and do not depend on an external session
  service.
- Internal monitoring and backup specifics from the documentation; generic,
  optional examples remain.

### Fixed

- Brief and bug status transitions no longer depend on scripts from a private
  game repository: brief statuses are written directly to `BRIEF.md`, and
  the optional `BUG.md` overview sync is best-effort
  (`trackRow: skipped_no_script`).
- Viewer pages no longer revert a status after a Vault snapshot refresh: the
  authoritative Vault write happens before the local `Readme.md` cache is
  updated.
- Both CLI launchers allow pending HTTP and output handles to drain before exit, avoiding Windows libuv shutdown assertions in CI.

## [0.1.16] - 2026-11-01

### Changed

- `studio bug import-local` maps the complete Readme field set
  (description, build, environment, world state, reproduction rate, reporter,
  readme fields) and handles multi-line values.

## [0.1.15] - 2026-11-01

### Added

- Historical, legacy bug packages are annotated with `dataGaps` so that
  missing fields are visible in the viewer instead of being silently absent.

## [0.1.14] - 2026-11-01

### Added

- `studio bug pending|status|import-local|check`: the offline report queue
  can be inspected, backfilled into Vault idempotently and self-checked.

## [0.1.13] - 2026-11-01

### Added

- Authoritative status writes from Studio to Vault, `POST /api/sync` to
  refresh the local snapshot on demand, and automatic viewer refresh after a
  status change.

## [0.1.12] - 2026-11-01

### Added

- Bug list severity / data-gap / source badges, a richer bug detail panel
  (verification and data-gap sections), and a severity default when syncing
  snapshots.

## [0.1.11] - 2026-11-01

### Fixed

- The Vault snapshot sync computes `dataGaps` for legacy bug packages.

## [0.1.10] - 2026-11-01

### Added

- The viewer renders direct-report fields (build, branch, commit, environment,
  reproduction steps, world state, reporter, case context, data gaps).
- Vault maps the direct-report field set onto bug records and payloads.

## [0.1.9] - 2026-11-01

### Changed

- Bug list and detail layout rework, including card styling for the UI-kit
  pages.

## [0.1.8] - 2026-11-01

### Fixed

- Bug scanning accepts compact report folder names
  (`bug-<YYYYMMDDHHMMSS>-<id>`) in addition to the date/month layout.

## [0.1.7] - 2026-11-01

### Added

- The viewer degrades gracefully when the internal session bridge cannot be
  reached.
- The Vault snapshot sync enriches bug `Readme.md` files with description,
  evidence, logs and timeline.

### Changed

- Sidebar layout adjustments.

## Vault releases

### [0.1.2] - 2026-11-01

#### Added

- Direct-report bug fields: `branch`, `commitSha`, `worktree`,
  `sourceTrack`, `priority`, `reporter` and the structured
  `payload` extension fields.
- Evidence upload and download endpoints
  (`PUT/GET /api/v1/reports/:id/files`) with sha256 content addressing.
- Audit queries (`/audit`, `/audit/summary`, `/audit/:eventId`),
  migration run queries and the `priority` migration.
- Idempotent bug creation by `legacyId` (`200` with the existing bug when
  the id already exists).

#### Fixed

- Importer parser fixes and triage field handling.

### [vault-v0.1.1] - 2026-11-01

#### Added

- PostgreSQL and in-memory stores, the content-addressed object store,
  token-scoped authorisation, optimistic locking, audit trail, backup and
  restore-check tooling.

### [vault-v0.1.0] - 2026-11-01

#### Added

- First standalone Vault release: `/api/v1` service, schema migrations
  `001`-`006` (partitioned tables, idempotency keys, audit and migration
  ledger), filesystem object storage and the initial operational scripts.

## Earlier history

The `@studio/*` packages before `0.1.7` were developed inside a private
game repository: the mirror engine, write-transaction lock, bootstrap, doctor,
workspace and project registries, and the viewer server were extracted and
stabilised there. This repository is the public, MIT-licensed home of that
toolchain.
