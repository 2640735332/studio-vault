---
name: studio-shared-repo
description: "Configure and operate the optional team shared Git repository behind a Studio workspace: shared.repo / shared.remote / shared.root, studio bootstrap, studio sync (materialise the docs/briefs mirror), studio commit and studio watch (single-writer lock, journal, push retry), LFS text mode, and conflict or rollback recovery. Use when briefs must be shared between machines or teams, when the mirror and the shared repo disagree, or when a write-back fails. 触发词：共享仓 / 团队共享仓库 / 同步简报 / studio sync / studio commit / studio watch / studio bootstrap / 写回冲突 / journal 恢复 / LFS text 模式。"
---

# Studio shared repo: mirror, sync and write back

A team can keep briefs in a separate **shared repository** and let Studio
materialise the `docs/briefs` subset into every game repository. All movement
is explicit and Git-visible:

```text
<shared-repo>  docs/briefs/...   --sync/materialize-->  <game-repo>/docs/briefs
                                <--commit/watch--------
```

Writes go through one machine-wide lock and a journal, so two watchers cannot
corrupt the mirror. If a step is not configured the workspace simply stays in
single-machine mode.

> **Command convention.** `studio <cmd>` means `studio` on PATH, or from the
> `studio-vault` checkout: `node packages/cli/bin/studio-cli.js <cmd>` (or
> `node <studio-vault>/packages/cli/bin/studio-cli.js <cmd>` from a game repo).
> Run commands inside `<game-repo>`, which holds `studio.config.json`, unless noted.

## 1. Configure the shared repository

In `studio.config.json`:

| Key | Meaning |
|---|---|
| `shared.repo` | Directory name of the checkout under the workspace root (default `<project>-shared`). |
| `shared.remote` | Git URL of the shared repository. Empty or missing means single-machine mode. |
| `shared.branch` | Branch to clone, pull and push; default `main`. |
| `shared.root` | Optional explicit checkout path; supports the `\${WORKSPACE_ROOT}` placeholder. |
| `shared.mirror` | Must be `docs/briefs`. |
| `shared.lfs` | `text` (default), `binary`, `all` or `none`. |

The checkout path resolves as: `STUDIO_SHARED_ROOT` environment variable, then
`shared.root`, then `<workspace-root>/<shared.repo>`. The workspace root is the
parent of the game repository unless `STUDIO_WORKSPACE_ROOT` overrides it.
Machine-local state lives under `~/.studio/` (`STUDIO_HOME`): the lock
`locks/<project>.shared.lock`, the journal `journal/<project>/` and the mirror
hash cache `cache/<project>/mirror-index.json`.

## 2. First-time setup: bootstrap

```bash
studio bootstrap --dry-run   # show the plan: clone / LFS / materialise / hooks
studio bootstrap             # clone, pull text LFS, materialise, install hooks
studio bootstrap --update    # existing checkout: pull --rebase first
studio bootstrap --force     # replace mirror content that differs
```

`bootstrap` performs, in order: clone `shared.remote` (branch `shared.branch`)
into `shared.root` if missing; copy the game repo's Git identity to the shared
checkout so the first commit works; pull text-like LFS objects
(`git-lfs >= 3.4` required); materialise `docs/briefs` as real files (junctions
are rejected); set the game repo's `core.hooksPath` to `.githooks`; and verify
that mirror and shared-tree file counts match. Without `shared.remote` the
shared steps are reported as `degraded` and the local workspace still works.

## 3. The daily loop

| Command | What it does |
|---|---|
| `studio status` | Read-only snapshot: config paths, shared checkout, mirror diff, pending write-backs, journal count, hooks path. Add `--json` to script it. |
| `studio sync` | Rebuild `docs/briefs` from the shared checkout. Refuses while the mirror has unwritten changes (journal first, then `--force` discards); `--dry-run` only reports; `--no-seed` skips reusing matching LFS content. |
| `studio commit` | Write mirror changes back: copy mirror -> shared checkout, single commit, push with retry. `--dry-run` previews without writing; `--no-push` commits locally; `--message <m>` sets the commit subject; `--wait <ms>` waits for the lock; `--allow-delete` permits pushing deletions. |
| `studio watch` | Poll and write back automatically. `--interval <ms>` (default 1000) polls, `--debounce <ms>` (default 800) coalesces edits, `--once` handles one batch and exits, `--no-push` keeps commits local. |

Typical flow: `studio bootstrap` once, `studio watch` in a terminal while you
edit, `studio commit` before a hand-off, `studio status` when something looks
off. Every command accepts `--json` and `--cwd <dir>`.

## 4. LFS text mode

Brief repositories usually store text documents as LFS objects so histories
stay small. `text` mode pulls LFS objects for text-like extensions
(`*.md`, `*.html`, `*.json`, `*.yml`, `*.svg`, ...) and leaves binary LFS
objects as pointers until they are needed. Points to remember:

- `git-lfs >= 3.4` is required for the LFS steps; without it the doctor reports
  `lfs` as `degraded`.
- `studio sync --lfs text` (default) pulls text objects; `--lfs none` skips the
  pull when the network is unavailable.
- A text file that is still an LFS pointer in the mirror is real breakage:
  `studio bootstrap` and `studio doctor` both report it, and the file must not
  be edited until the object is pulled.
- `shared.lfs` declares the intended policy; keep it consistent across the
  team so machines do not fight over content.

## 5. Write safety and locking

- **Single writer.** `studio commit` runs inside `~/.studio/locks/<project>.shared.lock`;
  a second process waits (`--wait`) or fails instead of writing concurrently.
- **Journal.** Before `sync` replaces mirror content that was never written back,
  and before a failed `commit` or push gives up, the affected files are copied to
  `~/.studio/journal/<project>/<journal-id>/data/<rel>` with a `journal.json`
  record. Nothing is silently discarded.
- **Push retry.** `commit` pushes up to three times; between attempts it runs
  `pull --rebase`. A rebase conflict aborts the rebase, keeps the local commit
  and returns `push_conflict` with the conflicting paths.
- **Deletions.** Deleting a brief from the mirror does not delete it from the
  shared repository unless `commit --allow-delete` is passed. This protects
  against accidental mass deletion.
- **Second line.** `bootstrap` points the game repo's `core.hooksPath` at
  `.githooks`; a team pre-commit hook there is the second line of defence (the
  hook file itself lives in the game repository).

## 6. Conflicts and recovery

| Code / symptom | Meaning and fix |
|---|---|
| `shared_repo_not_ready` | Checkout missing, not a Git repo, no HEAD, or no `docs/briefs`: run `studio bootstrap` (or fix `shared.remote` / `shared.root`). |
| `mirror_is_link` | `docs/briefs` is a junction/symlink; replace it with a real directory and rerun `sync`. |
| `mirror_has_unwritten` | Mirror edits are not committed: run `studio commit`, or `studio sync --force` to journal and discard them. |
| `deletions_pending` | The mirror is missing files that still exist in the shared repo: confirm and rerun `commit --allow-delete`, or `sync` to restore them. |
| `git_identity_missing` | The shared checkout has no `user.name`/`user.email`: set them (bootstrap copies them from the game repo when available). |
| `push_conflict` | Another machine pushed first. The local commit is preserved: resolve in `<shared-repo>` (`git pull --rebase`), then rerun `studio commit`. |
| `push_failed` | Network or credentials. The local commit exists; fix access and rerun `studio commit` (it retries the push). |

Journal recovery: `studio status --json` shows the journal count; inspect
`~/.studio/journal/<project>/<id>/journal.json` and copy the files you want to
keep from `data/` back into `docs/briefs/`, then `studio commit`. Journal
directories are machine-local, so archive or delete them only after the content
is back in Git.

## 7. Verify the wiring

```bash
studio bootstrap --dry-run
studio status --json          # expect shared.ok=true and unwritten=0 after a commit
studio doctor --require shared,mirror,lfs
```

`doctor` treats `shared` / `mirror` as `degraded` in single-machine mode; with
a remote configured they must be `ok`. `--require` turns a degraded named
check into a failure, which is how CI gates the shared setup.

## Related skills

- [studio-workspace](../studio-workspace/SKILL.md) - workspace setup and `doctor`.
- [studio-brief](../studio-brief/SKILL.md) - the briefs this workflow moves.
- [studio-vault](../studio-vault/SKILL.md) - the optional data service.
- [Skills index](../README.md) - installation and trigger phrases.
