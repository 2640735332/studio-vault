# Contributing

Thanks for your interest in Studio & Vault. This document covers the
development setup, the rules that keep the project maintainable, and the pull
request process.

中文要点见文末（[中文摘要](#中文摘要)）。

## Getting started

```bash
git clone <your-fork-or-clone-url> studio-vault
cd studio-vault

# Optional: link the workspace packages. No external package is downloaded.
npm install

# Sanity checks (no build step, no external services required)
npm test
npm run verify:packages
```

A fresh clone already runs the CLI through the vendored packages
(`node packages/cli/bin/studio-cli.js --help`), so `npm install` is only
needed for the npm workspace scripts and the published-package checks.

### Requirements

| Requirement | Notes |
|---|---|
| Node.js `>= 22.5` | CI tests on Node 22 and 24. `node:sqlite` (used by `studio kb`) needs 22.5+. |
| Git | For the shared-repository workflows and normal development. |
| Docker + Compose | Only for the Vault stack (`vault/deploy/docker-compose.yml`). |
| PostgreSQL 16+ | Only for Vault integration work without Docker. |

## The zero-dependency rule

**Runtime dependencies stay at zero.** Both the Studio packages and Vault use
only the Node.js standard library. This is a hard rule, not a preference:

- Do not add entries to `dependencies` or `peerDependencies` in any package.
- Development tooling (tests, checks, scripts) must also run on the Node
  standard library; `node:test` is the test framework.
- If a feature seems to need a library, discuss it in an issue first. The
  answer is usually a small standard-library implementation or a "no".
- Do not add a build step. Source in the repository is what runs.

`vault/deploy` and `vault/Dockerfile` are packaging, not runtime
dependencies, and are exempt from the npm rule (they use Docker images).

## Repository layout and where to make changes

| Area | Path | Notes |
|---|---|---|
| Studio primitives | `packages/shared/src/` | Keep generic and dependency-free. |
| Studio runtime | `packages/studio/src/` | Commands in `commands/`, viewer server in `serve/`. |
| Viewer front end | `packages/studio/templates/viewer/` | Plain JavaScript, no bundler. |
| CLI entry | `packages/cli/` | Thin dispatcher; keep it thin. |
| Vault service | `vault/src/` | HTTP app, auth, stores, object storage. |
| Vault migrations | `vault/migrations/` | **Append-only.** Never edit an applied migration. |
| Vault tests | `vault/test/` | `node:test` suites. |
| Documentation | `README.md`, `docs/`, `vault/docs/` | English is the primary language; keep bilingual entry points in sync. |

## Tests

```bash
# Aggregated Studio + Vault suites
npm test

# Vault unit suites only (PostgreSQL not required)
npm run vault:test

# Studio tests only
node --test "packages/studio/test/**/*.test.js"

# Vault end-to-end selftest in memory mode
cd vault && node scripts/vault-selftest.mjs --driver memory

# Verify the three npm packages can be packed, extracted and imported
npm run verify:packages
```

Guidelines:

- Every bug fix and feature needs a test that would fail without the change.
- Tests must be hermetic: temporary directories, random high ports, no network
  and no dependency on a running Vault or PostgreSQL. Use `node:test`,
  `node:assert`, `node:child_process` and `fs.mkdtemp`.
- Do not weaken an existing assertion to make CI green. Fix the cause.
- Watch mode is available: `node --test --watch <files>`.

## Coding style

- ES modules, `node:` imports, two-space indentation.
- Match the surrounding code. There is no formatter or linter to install; keep
  diffs focused and readable.
- User-visible errors should be explicit: return an error code and a helpful
  message rather than swallowing failures. Optional integrations (Vault, LFS,
  shared repo) degrade to `degraded`, they do not fail the whole command.
- The viewer front end stays framework-free: plain DOM and ES modules.
- Vault API changes under `/api/v1` must be additive. Breaking changes need
  a new API version and a migration plan.

## Database migrations

- Add a new file `vault/migrations/NNN_description.sql`. Never modify an
  existing one: the runner checksums applied migrations and will hard-fail on
  drift.
- Make migrations idempotent where the runner allows it, and prefer
  expand/contract for destructive changes.
- New time-partitioned tables need a DEFAULT partition and a monthly partition
  strategy; the migration tooling creates partitions.
- Add or update a test in `vault/test/` for schema changes.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(studio): add studio init --demo
fix(vault): reject forged author on PATCH
docs: explain the Vault write channel
test(studio): cover transition matrix
chore: bump repository version
```

- One logical change per commit; keep unrelated refactors in separate commits.
- Reference the issue in the body when there is one (`Refs: #123`).
- Never commit credentials, tokens, `.env` files, dumps or evidence archives.
  Machine-local state belongs under `~/.studio/` or a path outside the repo.
- Update [CHANGELOG.md](CHANGELOG.md) for user-visible changes when preparing a
  release.

## Pull requests

1. Fork the repository and create a topic branch (`feat/...`, `fix/...`).
2. Keep the PR focused. If you touch both Studio and Vault, explain why.
3. Make sure CI is green: `npm test`, `npm run verify:packages` and the
   Vault selftest.
4. Describe the change, the user-visible effect and how you tested it. Screenshots
   or a short screen recording help for viewer changes (before/after).
5. Return to review comments with additional commits; the maintainers squash on
   merge.
6. By submitting a pull request you confirm that you wrote the change (or have
   the right to submit it) and agree to license it under the project's MIT
   license. No separate CLA is required.

## Security

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md) instead.

## Chinese summary (中文摘要)

- 开发环境：Node.js `>= 22.5`（CI 覆盖 22 / 24）；clone 后可直接
  `node packages/cli/bin/studio-cli.js`，`npm install` 只做 workspace 链接。
- 零依赖红线：运行时不得引入任何 npm 依赖，测试与脚本也只用 Node 标准库
  （`node:test` / `node:assert`）；不引入构建步骤。
- 测试：`npm test` 跑 Studio + Vault 聚合套件；`npm run vault:test` 只跑
  Vault 单测；`npm run verify:packages` 校验三个包可打包 / 解包 / import；
  `cd vault && node scripts/vault-selftest.mjs --driver memory` 跑端到端自检。
  测试必须自带临时目录、随机端口、不依赖网络与外部服务。
- 迁移：`vault/migrations/` 只增不改（checksum 漂移会硬错），破坏性变更走
  expand/contract。
- 提交：Conventional Commits；一次提交一件事；凭据 / `.env` / 证据包一律不入库；
  用户可见变更更新 CHANGELOG。
- PR：topic 分支、CI 全绿、写清改动与验证方式（viewer 改动附前后截图）；
  合并时 squash。贡献按 MIT 许可 inbound=outbound，无需签 CLA。
