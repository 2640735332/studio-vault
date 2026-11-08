# Quickstart

Three ways to get your hands on the project, from fastest to most complete:

1. [Memory-mode Vault selftest](#1-memory-mode-vault-selftest-no-postgresql) - no
   database, about ten seconds.
2. [Demo Studio workspace](#2-demo-studio-workspace) - the local viewer with an
   example brief, bug and data table.
3. [Real Vault with PostgreSQL](#3-real-vault-with-postgresql-and-compose) -
   the full service with the bundled Compose stack (or a local PostgreSQL).

All commands assume you start at the repository root unless stated otherwise.
Requirements: Node.js `>= 22.5`; Git for step 3's Compose stack and for the
shared-repository workflows; Docker + Compose (or a local PostgreSQL 16+) only
for step 3.

## 1. Memory-mode Vault selftest (no PostgreSQL)

The fastest way to verify that the Vault API works on your machine:

```bash
cd vault
node scripts/vault-selftest.mjs --driver memory
```

The selftest starts the real HTTP service with the in-memory store and runs 23
assertions against the live API: health and metrics, token scopes and the
negative authorisation matrix, optimistic-lock `409`, audit events, ingest
idempotency and a backup/restore drill. It needs no configuration and no
network. A successful run ends with:

```text
SUMMARY {"total":23,"pass":23,"fail":0}
```

Useful flags:

```bash
node scripts/vault-selftest.mjs --driver memory --json          # machine-readable output
node scripts/vault-selftest.mjs --driver memory --evidence-dir ./evidence --label memory
node scripts/vault-selftest.mjs --driver pg                     # needs VAULT_DB=pg + VAULT_PG_*
```

You can also run the unit suites directly:

```bash
# from the repository root
npm run vault:test
# or
node --test vault/test/*.test.mjs
```

## 2. Demo Studio workspace

Create a workspace, then start the viewer:

```bash
# from the repository root
node packages/cli/bin/studio-cli.js init --demo
node packages/cli/bin/studio-cli.js serve
```

`init --demo` writes `studio.config.json` and the directory skeleton into the
current directory and adds three demo files:

```text
studio.config.json
specs/
docs/briefs/<date>-demo-brief/BRIEF.md
game/reports/bugs/bug-<date>-000000-9001/Readme.md
game/src/data/buildings.json
```

`serve` starts the viewer on http://localhost:3456 (loopback only by
default). Open it and try:

- **Briefs** - the demo brief is listed; open it and use a status button. The
  `状态:` line in `docs/briefs/<date>-demo-brief/BRIEF.md` changes on disk.
- **Bugs** - open the demo bug report and move it from `新` (new) to
  `修复中` (in progress). `game/reports/bugs/<folder>/Readme.md` is updated in
  place.
- **Data** - browse `buildings.json` and edit a whitelisted field from the data
  page; the JSON file is rewritten.
- **Pulse** - the dashboard and search across every mode.

Stop the server with `Ctrl+C`. A second terminal can run the graded health
check without stopping the viewer:

```bash
node packages/cli/bin/studio-cli.js doctor --json
```

`doctor` reports `degraded`, not `fail`, when the optional pieces (shared
repository, Vault, LFS) are not configured. That is normal for a demo
workspace.

> `init` writes into the current directory. Run it in a scratch folder outside
> a Git checkout if you want a clean tree, or add the generated paths to your
> own `.gitignore`.

## 3. Real Vault with PostgreSQL and Compose

### 3.1 Start the stack

```bash
cd vault/deploy
cp .env.example .env        # set VAULT_PG_PASSWORD and VAULT_MINIO_PASSWORD
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:3460/api/v1/health
```

The stack contains PostgreSQL (metadata), MinIO (object storage), OpenSearch
(full-text index, rebuildable) and the Vault API container. The API applies
pending migrations on startup. Ports bind to loopback by default.

### 3.2 Create a project and a token

```bash
docker compose exec vault-api node scripts/vault-token.mjs create \
  --label dev --project demo-project --role admin --ensure-project
```

The plaintext token is printed exactly once - store it in a local file that is
not committed (for example under your user profile). Vault only keeps its
sha256.

### 3.3 Point Studio at Vault

Add the Vault URL and project to `studio.config.json`:

```json
{
  "vault": { "url": "http://127.0.0.1:3460", "project": "demo-project" }
}
```

The doctor now reports the Vault check as `ok` when the service is healthy.
To let viewer status transitions write the authoritative Vault state, start the
server with the write channel enabled and point it at the token file:

```bash
# PowerShell
$env:SPECVIEWER_VAULT_WRITE = "1"
$env:STUDIO_VAULT_WRITER_TOKEN_FILE = "$HOME/vault-writer-token.txt"
node packages/cli/bin/studio-cli.js serve

# bash
SPECVIEWER_VAULT_WRITE=1 STUDIO_VAULT_WRITER_TOKEN_FILE=~/vault-writer-token.txt \
  node packages/cli/bin/studio-cli.js serve
```

Without these variables the viewer stays purely local: transitions only touch
Markdown and Vault is treated as read-only.

### 3.4 Native PostgreSQL without Docker (optional)

If you already run PostgreSQL 16+:

```bash
cd vault
export VAULT_DB=pg
export VAULT_PG_HOST=127.0.0.1 VAULT_PG_PORT=5432
export VAULT_PG_USER=vault VAULT_PG_PASSWORD=change-me VAULT_PG_DB=vault

node scripts/vault-migrate.mjs --create-database
node scripts/vault-token.mjs create --label dev --project demo-project --role admin --ensure-project
node src/server.mjs
curl -s http://127.0.0.1:3460/api/v1/health
```

On Windows PowerShell set the variables with `$env:VAULT_DB = "pg"` and so on.
The server defaults to `127.0.0.1:3460`; set `VAULT_BIND` / `VAULT_PORT` to
change that.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `not_a_studio_repo` | Run the command inside a workspace root (the directory with `studio.config.json` and `specs/`), or pass `--cwd <dir>`. |
| Viewer port already in use | `studio serve --port 3461` (any free port). |
| `node_sqlite_unavailable` from `studio kb` | You are on Node.js below 22.5; upgrade Node.js. Nothing else depends on SQLite. |
| `studio doctor` says Vault `degraded` | Vault is not running or the token is missing. This is not a failure; start Vault and re-run. |
| `409 version_conflict` from Vault | Another writer changed the bug first. Retry the operation; the client refreshes the version automatically once. |
| Compose `.env` error about a missing password | Fill `VAULT_PG_PASSWORD` and `VAULT_MINIO_PASSWORD` in `vault/deploy/.env`. |

## 中文快速开始

三条路径，由快到全：

**1）内存模式 Vault 自检（不需要 PostgreSQL）**

```bash
cd vault
node scripts/vault-selftest.mjs --driver memory
# 成功时最后一行：SUMMARY {"total":23,"pass":23,"fail":0}
```

它会用内存存储启动真实的 HTTP 服务并跑 23 条断言：health/metrics、token scope
反向用例、乐观锁 409、审计事件、ingest 幂等、备份/恢复演练。无需配置、无需数据库、
无需网络。单测可直接跑 `npm run vault:test`（`vault/` 目录外）或
`node --test vault/test/*.test.mjs`。

**2）演示 Studio 工作区**

```bash
# 在仓库根目录
node packages/cli/bin/studio-cli.js init --demo
node packages/cli/bin/studio-cli.js serve
# 打开 http://localhost:3456
```

`init --demo` 会生成 `studio.config.json`、`specs/`、示例简报、示例 Bug
上报包和示例数据表。在 viewer 里切换简报 / Bug 状态，改动会直接写回 Markdown；
Data 视图可以编辑白名单字段；Pulse 视图提供全局搜索。`studio doctor --json`
在没有共享仓 / Vault 时返回 `degraded`，这是正常状态而不是失败。

**3）真实 Vault（PostgreSQL + Compose）**

```bash
cd vault/deploy
cp .env.example .env     # 填 VAULT_PG_PASSWORD / VAULT_MINIO_PASSWORD
docker compose up -d --build
curl -s http://127.0.0.1:3460/api/v1/health
docker compose exec vault-api node scripts/vault-token.mjs create \
  --label dev --project demo-project --role admin --ensure-project
```

把 `studio.config.json` 的 `vault.url` / `vault.project` 指向该服务；需要
viewer 状态流转写 Vault 权威时，启动 serve 前设置
`SPECVIEWER_VAULT_WRITE=1` 与 `STUDIO_VAULT_WRITER_TOKEN_FILE` 指向 token
文件。没有 PostgreSQL / Docker 时，也可以在本机装 PostgreSQL 16+，用
`scripts/vault-migrate.mjs --create-database` 建库、`scripts/vault-token.mjs`
建 token、`node src/server.mjs` 起服务。
