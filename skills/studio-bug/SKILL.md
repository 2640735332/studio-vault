---
name: studio-bug
description: "File a game bug as a reviewable package under game/reports/bugs/<folder>/Readme.md with screenshots and logs, move it through the Studio bug state machine (新 / 修复中 / 已关闭 / 已关闭 · 非缺陷 / 已关闭 · 重复), report it directly to Vault over REST, and repair the offline pending queue with studio bug pending / import-local / check. Use when writing a bug report, triaging a defect, or investigating a report that never reached Vault. 触发词：提 bug / 上报 bug / 缺陷报告 / bug 证据 / 复现步骤 / 截图和日志 / bug 状态 / Vault 直报 / pending 队列 / import-local / bug check。"
---

# Studio bug: package, triage and report it

A **bug package** is a folder under `game/reports/bugs/` with a `Readme.md` and
its evidence files. The viewer lists and triages it; when Vault is configured
the same ticket is also a Vault row and the Markdown file becomes a display
cache. Files remain the review surface; Vault is the authority when enabled.

> **Command convention.** `studio <cmd>` means `studio` on PATH, or from the
> `studio-vault` checkout: `node packages/cli/bin/studio-cli.js <cmd>` (or
> `node <studio-vault>/packages/cli/bin/studio-cli.js <cmd>` from a game repo).
> Run commands inside `<game-repo>`, which holds `studio.config.json`, unless noted.

## 1. Create the package

```text
game/reports/bugs/bug-<YYYYMMDD>-<HHMMSS>-<in-game-id>/
  Readme.md
  screenshot-1.png
  log-<name>.jsonl
```

- The folder date comes from the report time; the viewer derives the list date
  from the `bug-<YYYYMMDD>...` prefix.
- `<in-game-id>` is the 8-digit id the game generates: it is the Vault
  `legacyId` and its idempotency key, so reuse it when retrying.
- Keep `Readme.md` (capital R) or `README.md`; one folder per report.

## 2. Readme.md fields

Plain `Key: value` lines; JSON values stay on one line so tools can parse them.

| Field | Content |
|---|---|
| `ID` / `标题` / `描述` | 8-digit in-game id (required for Vault), one-line title, what went wrong. |
| `复现时间` / `状态` | When it happened; state machine below. |
| `项目` / `来源` / `证据` | Written by the Vault snapshot sync: project id, source reference, evidence summary; optional in hand-written packages. |
| `类型` / `Tags` / `优先级` / `严重度` | `bug` or `bug转需求`; tags; `P0`-`P3`; `low`-`critical`. |
| `分支` / `提交` / `构建` / `环境` | Build context; JSON for `构建` and `环境`. |
| `复现步骤` / `复现` | JSON steps `[{"id":"1","text":"..."}]`; JSON `{"frequency":"always","attempts":3}`. |
| `世界状态` / `E2E上下文` | JSON snapshot for deterministic reproduction; JSON case context for automated runs. |
| `上报者` | JSON `{"id":"...","source":"manual|e2e|agent|api|import"}`; identity, not authentication. |
| `截图` / `日志` / `数据缺口` | Comma-separated evidence files; missing evidence list (`无` when empty). |
| `历史变更` | Timeline list; transitions append `- [timestamp] <status>: <note>`. |

Minimal example:

```text
ID: 88067018
标题: Clinic build menu does not follow the building anchor
描述: The clinic menu stays screen-centred after placement.
复现时间: 2026-05-12T17:30:00
状态: 新
优先级: P2
复现步骤: [{"id":"1","text":"Open the build menu"},{"id":"2","text":"Place the clinic"}]
历史变更:
- [2026-05-12T17:30:00] 创建 (ID: 88067018)
```

## 3. Evidence files

- Screenshots: `screenshot-1.png`, `screenshot-2.jpg` (also `jpeg`/`webp`),
  ordered by number and shown in the detail view.
- Logs: `log-*.jsonl` (one JSON object per line); every match is listed.
- Optional: `report.json` plus an engine log for end-to-end runs.
- List them in `截图:` / `日志:`; record missing evidence in `数据缺口:`.
- Never put tokens, passwords or personal data into report files or evidence.

## 4. Move it through triage

| Action | From | To | Extra input |
|---|---|---|---|
| `start_fix` | 新 | 修复中 | - |
| `mark_done` | 新 / 修复中 | 已关闭 | - |
| `close_false_red` | 新 / 修复中 | 已关闭 · 非缺陷 | `reason` required |
| `close_duplicate` | 新 / 修复中 | 已关闭 · 重复 | `masterId` required (6-8 digits) |
| `reopen` | any closed state | 新 | - |
| `interrupt` | 修复中 | 新 | - |

Run it from the viewer **Bugs** view, or `POST /api/specviewer/transition` with
`{"kind":"bug","id":"<folder>","action":"start_fix"}`, or the viewer-local
`PATCH /api/bugs/<folder>` with `{"kind":"fixed"}` (kinds: `start_fix`,
`fixed`, `false_red`, `duplicate`, `reopen`). The transition rewrites `状态:`
and appends a `历史变更` line; close reasons are mandatory.

## 5. Report directly to Vault (authoritative path)

The API lives under `/api/v1` on `<vault-url>` (default
`http://127.0.0.1:3460`). Send `Authorization: Bearer vt_<id>_<secret>`;
project and author come from the token, so never send an author field.

```bash
# create the ticket (idempotent on legacyId: existing -> 200)
curl -s -X POST <vault-url>/api/v1/bugs -H "Authorization: Bearer $VAULT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"legacyId":"88067018","title":"Clinic menu does not follow","priority":"P2",
       "severity":"medium","payload":{"description":"...","steps":[{"id":"1","text":"..."}]}}'

# report container, then upload evidence (roles: readme/log/screenshot/attachment)
REPORT=$(curl -s -X POST <vault-url>/api/v1/reports -H "Authorization: Bearer $VAULT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"bug-package","title":"Clinic menu","payload":{"legacyId":"88067018"}}')
curl -s -X PUT "<vault-url>/api/v1/reports/<reportId>/files?path=Readme.md&role=readme" \
  -H "Authorization: Bearer $VAULT_TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @Readme.md
# link the report to the bug
curl -s -X POST <vault-url>/api/v1/links -H "Authorization: Bearer $VAULT_TOKEN" \
  -H "Content-Type: application/json" -d '{"reportId":"<reportId>","bugId":"<bugId>","role":"evidence"}'
```

Read back with `GET /api/v1/bugs/by-legacy/<legacyId>`; triage with
`PATCH /api/v1/bugs/<id>` and `If-Match: <version>` (stale -> `409
version_conflict` plus the current bug). Typical errors: `401 unauthorized`,
`403 insufficient_role` / `author_forged`, `413 payload_too_large`.

## 6. Offline queue and backfill

In-game reporters that cannot reach Vault write JSON entries to the local queue
`<game-user-data>/reports/vault_pending/*.json`. Inspect and repair it:

```bash
studio bug pending --user-dir <game-user-data> --json   # queued items; count=0 is good
studio bug import-local --source <game-repo> --dry-run  # which local packages Vault lacks
studio bug import-local --source <game-repo> --sync     # create missing bugs + upload evidence
studio bug check --source <game-repo> --user-dir <game-user-data>  # chain self-check
studio bug flush --dry-run                              # report the queue; the game worker drains it
```

`import-local` creates only bugs whose 8-digit id is absent in Vault (never
overwrites), then creates a report, uploads the Readme, the log and the listed
screenshots, and links it as evidence. It needs a writer token from
`STUDIO_VAULT_WRITER_TOKEN_FILE`, `VAULT_WRITER_TOKEN_FILE` or
`~/.studio/secrets/vault-writer-token.txt`, plus `VAULT_URL` off the default
port. `studio bug check` also verifies the game's reporter wiring and recent
local packages. `studio bug flush` exits `2` while the queue is non-empty and
never consumes the game's queue itself.

After the check passes, open **Bugs** in the viewer: the package, screenshots
and timeline must be visible, and one transition must append a history line to
`Readme.md`.
## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bug missing in the viewer | Folder not directly under `game/reports/bugs/`, or no `Readme.md` / `README.md`. |
| `import-local` reports `invalid` | The package `ID:` is not 8 digits; fix it before importing. |
| `vault_token_missing` | Put the writer token in the file named by `STUDIO_VAULT_WRITER_TOKEN_FILE`; never commit it. |
| `vault_lookup_failed` | Wrong `VAULT_URL` or the token scope does not cover the project. |
| Transition fails on close | `已关闭 · 非缺陷` needs `reason`; `已关闭 · 重复` needs `masterId`. |

## Related skills

- [studio-vault](../studio-vault/SKILL.md) - tokens, endpoints, reports, backup.
- [studio-workspace](../studio-workspace/SKILL.md) - workspace setup and the viewer.
- [studio-brief](../studio-brief/SKILL.md) - the design side of the workflow.
- [Skills index](../README.md) - installation and trigger phrases.
