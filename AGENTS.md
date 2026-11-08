# AGENTS.md - studio-vault repository conventions

This repository contains Studio (a brief/bug workflow toolkit for game teams) and Vault (a
zero-dependency Node data service). Any AI or automation session working here must follow the
rules below.

## 1. Repository layout

- `packages/shared` - `@studio/shared`: shared zero-dependency primitives (config schema, JSON IO,
  fs tree, git, LFS pointers, doctor tiers).
- `packages/studio` - `@studio/local`: local runtime (mirror sync/watch/commit, bootstrap, doctor,
  workspace and CLI glue).
- `packages/cli` - `@studio/cli`: CLI entry point, delegates argument parsing to `@studio/local`.
- `vault/` - `@studio/vault`: data service (PostgreSQL metadata/index, object storage, audit and
  token scopes); deployable on its own.
- `scripts/` - repository-level gate scripts such as `verify-packages.mjs`.
- This repository does not contain game assets or engine code, and `packages/**` must not
  depend on any external game-repository path.

## 2. Zero-dependency rule (hard)

- `packages/**` and `vault/**` may only use the Node standard library (`node:*`). Do not add
  third-party runtime dependencies and do not inline vendored code.
- Dev-only tooling must never become a runtime import.
- Node >= 22.5 is required (the knowledge-base index uses `node:sqlite`).

## 3. Secrets never enter the repository

- No tokens, passwords, private keys or connection strings in any tracked file, commit, test
  fixture or artifact.
- `.env` files are gitignored; commit only `.env.example` templates with placeholder values.
- Publishing/private installs use a user-level `~/.npmrc` or environment variables; never put
  a registry token in a repository file.

## 4. Tests must be green before hand-off

- `npm run vault:test` (or `cd vault && node --test`) must pass when you touch `vault/**`.
- `node packages/cli/bin/studio-cli.js --version` must work after CLI-facing changes.
- Schema changes additionally run `npm run vault:migrate:dry-run`.
- Run `npm run verify:packages` after changing package manifests.

## 5. Release and versioning

- Package changes: bump the `@studio/*` versions together and tag `vX.Y.Z`.
- Vault has an independent version and tag: `vault-vX.Y.Z`.
- Same version is never published twice (registries are immutable).
- Bump versions only in a release commit; feature work does not change versions.
- A bad release stays recoverable: deprecate it, pin the previous version, or fall back to the
  vendored launcher; document the rollback in the release notes.

## 6. Commit discipline

- Stage explicit paths (`git commit --only <paths>`); never sweep unrelated files in with
  `git add -A`.
- Use Conventional Commits (`feat`/`fix`/`docs`/`chore`...).

## 7. Deployment (Vault)

- Deployment assets live under `vault/deploy/**`; the Compose stack builds from `vault/`
  (`cd vault/deploy && docker compose up -d --build`).
- The scripts under `vault/deploy/windows/` are optional Windows examples: host names and paths
  are parameters or documented placeholders, so adapt them to your own host.
- Runtime credentials stay in the host environment or `vault/.env` (gitignored), never in the repo.
- Vault-specific conventions (append-only migrations, API compatibility, selftest) live in
  `vault/AGENTS.md`.

## 8. Documentation

- Update `README.md` and the relevant package README when behavior, protocol or layout changes;
  update this file when the conventions themselves change.
- Keep docs free of private infrastructure details (internal hostnames, IP addresses, local disk
  paths); use placeholders instead.
