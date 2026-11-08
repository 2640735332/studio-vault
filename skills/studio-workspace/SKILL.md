---
name: studio-workspace
description: "Set up, inspect and run a Studio workspace in a game repository: studio init [--demo], studio.config.json, the graded studio doctor and studio serve with its six-view viewer. Use when asked to initialize Studio, fix not_a_studio_repo, explain doctor output, choose a viewer port, or start the local viewer. 触发词：初始化 Studio 工作区 / 搭工作区 / 装 Studio / 起 viewer / 打开本地看板 / doctor 体检 / doctor 报错 / 工作区初始化。"
---

# Studio workspace: set up and run

Studio is a file-based workflow toolkit for game teams. A **workspace** is an
ordinary Git repository with a `studio.config.json` at its root; Studio reads
the files in it, serves a local viewer and never needs a database.

> **Command convention.** `studio <cmd>` means `studio` on PATH, or from the
> `studio-vault` checkout: `node packages/cli/bin/studio-cli.js <cmd>` (or
> `node <studio-vault>/packages/cli/bin/studio-cli.js <cmd>` from a game repo).
> Run commands inside `<game-repo>`, which holds `studio.config.json`, unless noted.

Use this skill when setting Studio up in a new or existing game repository,
when `studio doctor` output needs interpreting, or when the viewer will not
start. Vault does not have to run first.

## Prerequisites

- Node.js `>= 22.5` (`node --version`); otherwise the Node standard library
  only, so there is no `npm install` and no build step.
- Git only for the shared-repository workflow (`sync` / `commit` / `watch` /
  `bootstrap`). `init`, `doctor` and `serve` need no Git, database or network.

## 1. Create the workspace

```bash
cd <game-repo>          # run at the Git top level, not in a nested folder
studio init             # studio.config.json + empty directory skeleton
studio init --demo      # same, plus one demo brief, bug package and data table
studio init --force     # rewrite an existing studio.config.json and demo files
studio init --cwd <dir> # scaffold another directory explicitly
```

`init` is idempotent: a second run reports `created 0 / kept N` and leaves
existing files alone; `--force` overwrites the config and demo files. Running
it in a subdirectory of a Git repository prints a warning, because later
commands resolve the repository root (and the config) from the Git top level.

| What `init` writes | Purpose |
|---|---|
| `studio.config.json` | Workspace configuration (schema version 1, no secrets). |
| `specs/` | Spec packages, tracks and design domains. |
| `docs/briefs/` | Briefs in `<date>-<topic>/BRIEF.md` form; the mirrored subset. |
| `game/reports/bugs/` | Bug packages: `<folder>/Readme.md` plus evidence. |
| `game/src/data/` | JSON data tables browsed and edited in the viewer. |

`--demo` also creates a demo brief, a demo bug package and
`game/src/data/buildings.json`; delete them when real content exists.

## 2. Configure the workspace

Edit `studio.config.json`. It is committed with the game repo and must never
contain a token or a password.

| Key | Meaning |
|---|---|
| `version` | Schema version; currently `1`. |
| `project.id` / `project.name` | Project identity; reports and Vault use `id`. |
| `project.gameRepo` | Game repository root; usually `"."`. |
| `shared.repo` | Shared-repository directory name under the workspace root. |
| `shared.remote` | Git URL of the shared repository; empty means single-machine mode. |
| `shared.branch` | Shared-repository branch; default `main`. |
| `shared.root` | Optional explicit checkout path; supports the `\${WORKSPACE_ROOT}` placeholder and is overridden by `STUDIO_SHARED_ROOT`. |
| `shared.mirror` | Must be `docs/briefs`. |
| `shared.lfs` | LFS handling: `text` (default) / `binary` / `all` / `none`. |
| `vault.url` / `vault.project` | Optional Vault endpoint and project; the viewer works without it. |
| `studio.port` | Viewer port; default `3456`. |
| `studio.worktreePortBase` | Base port for per-worktree viewer instances; default `3457`. |
| `kb.namespace` | Namespace of the local knowledge-base index. |

Machine-local state never enters the repository: `~/.studio/` (`STUDIO_HOME`
overrides it) holds locks, the write-back journal, the kb cache and the registry.

## 3. Check the environment with the graded doctor

```bash
studio doctor                            # human-readable summary
studio doctor --json                     # machine-readable report (script it)
studio doctor --require shared,kb        # CI gate: named degraded checks fail
studio doctor --assets --write-manifest  # also check asset refs, record a baseline
```

Grading: `ok` exits 0, `degraded` exits 0 (an optional capability is missing but
the workspace works), `fail` exits non-zero. `--require` names degraded checks
that must be treated as failures.

| Check | Looks at |
|---|---|
| `shared` | `shared.remote` and the shared checkout. |
| `mirror` | `docs/briefs` exists, is a real directory (no junctions), matches the shared tree. |
| `lfs` | `git-lfs >= 3.4` and no unresolved text LFS pointers in the mirror. |
| `budget` | Shared-repository pack size (50 MiB warning threshold). |
| `kb` | Local knowledge-base index state (needs `node:sqlite`). |
| `vault` | `GET <vault-url>/api/v1/health`; unreachable is `degraded`, never `fail`. |
| `assets` | Relative image references in mirrored Markdown/HTML resolve. |

The first run after `init` is normally `degraded` and exits 0: a fresh workspace
has no shared repository, no knowledge base and no running Vault yet. That is
single-machine mode, not an error.

## 4. Start the viewer

```bash
studio serve                      # http://127.0.0.1:3456
studio serve --port 3461          # any free port
studio serve --allow-lan          # LAN read-only browsing; writes stay loopback-only
studio serve --readonly           # reject every write endpoint
```

Open the printed URL and press `Ctrl+C` to stop. On startup the server creates
missing `specs/`, `docs/briefs/`, `game/reports/bugs/` and `game/src/data/`,
so a fresh workspace cannot crash it. It binds `127.0.0.1` by default (`--bind`
changes that; `--allow-lan` makes LAN exposure explicit); writes
(`POST /api/specviewer/transition`, data edits, `POST /api/sync`) are loopback-only.

Six views render from the files on disk:

| View | Reads | Purpose |
|---|---|---|
| **Pulse** | specs, briefs, git history | dashboard and cross-mode search. |
| **Briefs** | `docs/briefs/*/BRIEF.md` | review briefs by state, run transitions. |
| **Specs** | `specs/<package>/<track>/` | packages, tracks and task lists. |
| **Domains** | `specs/**/CURRENT.md` | living design documents. |
| **Bugs** | `game/reports/bugs/*/Readme.md` | triage bugs and open evidence. |
| **Data** | `game/src/data/*.json` | browse and edit data tables. |

## 5. First-run checklist

```bash
studio init --demo        # 1. scaffold a scratch workspace
studio doctor --json      # 2. expect ok=true, overall=degraded, exit 0
studio serve --port 3461  # 3. open http://127.0.0.1:3461
```

Then open **Briefs** and **Bugs** and run one status transition; the Markdown
file changes on disk, proving viewer, scanner and write-back in one round trip.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `not_a_studio_repo` | Run inside the workspace root, or pass `--cwd <dir>`; the root is the Git top level holding `studio.config.json`. |
| `init` warns about a subdirectory | The config was written below the Git root; move it to the root (or `init --cwd <root> --force`). |
| Port already in use | `studio serve --port 3461` (any free port). |
| Page is empty but the server runs | The workspace has no `docs/briefs/` or `game/reports/bugs/` content yet; the scanner lists existing files only. |
| `node_sqlite_unavailable` from `studio kb` | Node.js is older than 22.5; upgrade Node. Nothing else needs SQLite. |
| Doctor reports Vault `degraded` | Normal when Vault is not running; start it or ignore it for local work. |
| Doctor reports `fail` for `shared` / `mirror` | A remote is configured but the checkout is missing or broken: run `studio bootstrap`, or clear `shared.remote` for single-machine mode. |

## Related skills

- [studio-brief](../studio-brief/SKILL.md) - write briefs and move them through review.
- [studio-shared-repo](../studio-shared-repo/SKILL.md) - sync with the team shared repo.
- [studio-bug](../studio-bug/SKILL.md) - file and triage bug packages.
- [studio-vault](../studio-vault/SKILL.md) - the optional Vault data service.
- [Skills index](../README.md) - installation and trigger phrases.
