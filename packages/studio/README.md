# @studio/local

The Studio local runtime: command implementations, the shared-repository mirror
engine, write transaction lock and journal, bootstrap, doctor, knowledge base,
bug report chain and the viewer server.

Zero npm runtime dependencies (Node.js standard library only).

## Zero-command boundary

- A source checkout runs directly:
  `node packages/cli/bin/studio-cli.js <command>`.
- When the package is installed (npm or a workspace link), the same code is
  available as the `studio` / `studio-cli` executables; `@studio/cli` falls
  back to the vendored copy when the package is not installed.
- Vault is an independent service. This package only probes its health from
  `studio doctor` and talks to its REST API when the optional write channel is
  enabled - it never embeds Vault.

## Commands

| Command | Purpose |
|---|---|
| `init` | Scaffold a workspace (`studio.config.json` + directory skeleton; `--demo` adds example content). |
| `sync` | Materialise / verify the `docs/briefs` mirror from the shared repo (no junctions; journal first). |
| `commit` | Write mirror changes back to the shared repo through the write lock (single writer + push retry). |
| `watch` | Poll the mirror and write changes back automatically. |
| `status` | One-shot read-only state: config, shared repo, mirror diff, pending write-backs, journal, hooks. |
| `doctor` | Graded checks (shared / mirror / LFS / budget / kb / vault / assets); `degraded` is not a failure. |
| `bootstrap` | Clone the shared repo, pull text LFS, materialise the mirror, install hooks, verify. |
| `mirror-switch` | Planned mirror-strategy switch (dry run by default; `--execute` to apply). |
| `workspace` | Local workspace registry (`~/.studio/workspace.json`; tokens only as credential refs). |
| `project` | Local project registry and identification. |
| `serve` | Start the local viewer server (default http://127.0.0.1:3456). |
| `bug` | Offline report queue (`pending`) / `import-local` backfill / `check`. |
| `kb` | Shared-text knowledge-base index built with `node:sqlite`. |

## Viewer

`src/serve/server.js` serves the browser app in
`templates/viewer/`: dashboard (pulse), briefs, spec packages, domains, bug
reports and data tables. It binds to loopback by default and heals missing
workspace directories on startup. Status transitions are written back to
Markdown by `src/serve/transition.js`.

## Performance evidence

`studio perf` imports existing frame captures, verifies Vault uploads/downloads and exposes a
read-only performance workspace. See [protocol and operations](templates/performance/README.md).
# Workspace archive commands

For fresh game clones that still contain a legacy tracked brief mirror, `studio sync --missing-only`
adds missing canonical shared documents while preserving all existing content. It skips LFS
placeholders, reports `lfs_pending`, and does not claim full synchronization. Edit new briefs
in the shared repository; reconcile legacy mirror differences before ordinary `studio sync`.

Use `studio archive upload --source <selection.json>`, `archive search --query <path fragment>`
and `archive download --id <UUID> --out <new-directory>` for permanent, indexed Vault archives.
See the repository's `docs/ARCHIVES.md` for selection format, credentials and restoration.

