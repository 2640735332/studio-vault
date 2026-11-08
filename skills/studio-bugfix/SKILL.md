---
name: studio-bugfix
description: "Run the fix pipeline for a defect in a Studio workspace: register it in the track BUG.md defect register (IEEE 1044 fields), triage severity and priority, reproduce and minimise, prove a RED test before the fix, regress the adjacent systems, and close with the right verdict (fixed / not a defect / duplicate) while the bug package and Vault stay in sync. Use when fixing a reported bug, turning a player report into a fix, handling a review finding or a regression, or deciding whether a report is a duplicate or not a defect. 触发词：修 bug / 缺陷修复 / 修复流水线 / BUG.md 登记 / 复现 / 最小化 / RED 测试 / 回归 / 已关闭 / 非缺陷 / 重复缺陷 / 重开 / 证据 / 乐观锁。",
---

# Studio bugfix: register, prove, fix, close

A defect has two surfaces, and they must agree: the **track register**
`specs/<package>/track-*/BUG.md` is the engineering record (IEEE 1044 - what
was broken, when, against which requirement), and the **bug package**
`game/reports/bugs/<folder>/Readme.md` is the report with its evidence
([studio-bug](../studio-bug/SKILL.md)). A report without a register row loses
the requirement link; a register row without a package has no evidence.

> **Path convention.** Paths are relative to `<game-repo>`, the workspace that
> holds `studio.config.json`. Run viewer transitions on the viewer host: write
> routes accept loopback clients only; `--readonly` rejects every write.

## 1. Register the defect in the track BUG.md

The register is a table under a heading containing `缺陷总览` (defect overview),
one row per defect, with a changelog below. Columns used in practice:

| Column | Content |
|---|---|
| `编号` | Internal `BUG-01`, ... for defects found during the track; a player report keeps its 8-digit id. |
| `简述` | One line: observable symptom, not a cause guess. |
| `状态` | `新建` -> `已修复` -> `已验证` -> `已关闭` (document state; review enforces it). |
| `严重度` / `优先级` | Impact (`严重` / `一般` / `轻微`) and order (`P0` - `P2`). |
| `来源` | `brief §n`, a review round, an end-to-end run, or the 8-digit player report. |
| `关联需求` | `FR-*` / `AC-*` from the track PRD; `-` only when the defect truly belongs to no requirement. |
| `发现日期` | `YYYY-MM-DD`. |

- Register the defect **before** the fix, otherwise the review has no baseline
  to verify against. Scope it to the track that owns the requirement.
- Only 8-digit ids are synchronised automatically. When a bug package with an
  8-digit `ID:` changes state, the viewer looks for a `track-*` `BUG.md` whose
  register has that id in the first cell and updates the row through the
  adopter repository `scripts/spec-track.js`. Missing script -> `trackRow:
  skipped_no_script`; no matching row -> `absent`. Internal `BUG-*` rows are
  updated by hand.

## 2. Keep the report package alongside

- Folder `game/reports/bugs/bug-<date>-<time>-<8-digit-id>/Readme.md`, evidence
  files next to it; one folder per report, one register row per defect.
- The 8-digit id is the Vault `legacyId` and the idempotency key: a retry must
  reuse it, never mint a second id for the same report.
- A duplicate is linked to its master, not filed as a second row.

## 3. Triage

| Question | Decide | Record |
|---|---|---|
| How bad is it? | `严重` = data loss, crash, blocked progress; `一般` = wrong behaviour with a workaround; `轻微` = cosmetic or local. | `严重度` |
| What order? | `P0` this track must not close with it open; `P1` this track; `P2` later or backlog. | `优先级` |
| Is it a duplicate? | Same root cause already registered or reported -> `close_duplicate` with the master id. | `已关闭 · 重复` |
| Is it a defect at all? | Works as designed -> `close_false_red` with the design reference as reason. | `已关闭 · 非缺陷` |

Severity measures impact, priority measures order; triage before reproducing.

## 4. Reproduce, then minimise

Take the environment from the report: build, branch, commit, platform, world
state, end-to-end context. Reproduce with as few steps as possible, and write
those minimal steps back into the package. If it does not reproduce: record the
attempts, ask for logs, leave the state at `新` - never close on "cannot
reproduce" alone. Freeze the inputs (a world-state or seed file) so the test is
deterministic for the next person.

## 5. Write the RED test before the fix

```bash
# run the new case alone; it must fail, for the right reason
<your test command> <new-case-name>
```

The failure must name the broken behaviour (`expected 0, got 1`), not a broken
setup. Keep the RED output as evidence and record the case in the `TEST.md`
matrix. Put the test at the lowest level that proves the behaviour; add an
end-to-end case only when the user path cannot be covered otherwise.

## 6. Fix

Make the smallest change that turns the RED test green; resist drive-by
refactoring in the same commit. If the fix reveals that the spec was wrong,
amend `PRD.md` / `TECH.md` with a changelog row - never let code and spec drift
silently. If behaviour other teams depend on changes, say so in `REVIEW.md`.

## 7. Regress

- Re-run the new case, the track suite, and the named adjacent systems the change
  can reach; record the command, environment and result, not just "green".
- Re-run the original reproduction steps from the package and note the result.
- Add the case to the domain `TESTS.md` and its end-to-end folder when the domain
  owns the behaviour, so the next track inherits the protection.

## 8. Review and close

A reviewer who is not the author checks the RED record, the regression evidence
and the requirement link; the verdict goes into `REVIEW.md`. Only then does the
register row move to `已验证` and the package to a closed state:

| Outcome | Action | Package state | Register row |
|---|---|---|---|
| Fixed and verified | `mark_done` (or `PATCH /api/bugs/<folder>` with `kind:"fixed"`) | `已关闭` | `已关闭` |
| Works as designed | `close_false_red` with `reason` | `已关闭 · 非缺陷` | `已关闭` |
| Duplicate | `close_duplicate` with `masterId` | `已关闭 · 重复` | `已关闭` |
| Returned later | `reopen` | `新` | `新建` |

`start_fix` moves `新` -> `修复中`; `interrupt` moves `修复中` back to `新`. A
transition rewrites the `状态:` line and appends a `历史变更` entry; close
reasons are mandatory. Reopening keeps the history - never edit it away.

## 9. Vault as the authority, with optimistic locking

When the viewer writes Vault (`SPECVIEWER_VAULT_WRITE=1` plus a writer token
file), Vault is authoritative and `Readme.md` is a display cache. Writes are
`PATCH /api/v1/bugs/<id>` with `If-Match: <version>`; a stale version returns
`409 version_conflict` with the current row - re-read, re-verify, retry, never
force. A failed Vault write fails the transition explicitly instead of drifting;
do not hand-edit the Markdown to fake a state the service rejected.

## 10. Evidence

- Reproduction steps, environment (build, branch, commit, platform), logs,
  screenshot or recording, expected vs actual, and the RED output.
- List evidence files in the package `Readme.md`; missing evidence goes into
  `数据缺口` instead of being ignored.
- Never put tokens, passwords or personal data into a package or its evidence.

## 11. Blocking and escalation

| Blocker | Escalate to | While waiting |
|---|---|---|
| Missing asset or upstream dependency | The owning team, with the defect id | Leave `新建` / `Blocked`, note the dependency; do not fake a fix. |
| Design ambiguity | The brief owner or spec reviewer | Keep the defect open and amend the spec first. |
| Environment-only failure | Platform or release owner, with the exact build | Record the environment; do not close as non-reproducible. |

A `P0` open blocks closing the track ([studio-spec-pipeline](../studio-spec-pipeline/SKILL.md)
Definition of done). Escalate after one failed repair round, not after five.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Register row not updated | The id is not 8 digits, the row is not under `缺陷总览`, or the repo has no `scripts/spec-track.js` (`skipped_no_script`). |
| Transition rejected `409 illegal_transition` | Wrong starting state - check the matrix or use `undo` first. |
| `409 version_conflict` from Vault | Someone else wrote first: re-read the bug, reconcile, retry with the new version. |
| Close rejected | `已关闭 · 非缺陷` needs `reason`; `已关闭 · 重复` needs `masterId`. |
| Test green but bug persists | The test asserts the fix, not the bug: rewrite it against the reproduction steps first. |

## Related skills

- [studio-bug](../studio-bug/SKILL.md) - write the report package, Vault direct report, offline queue.
- [studio-spec](../studio-spec/SKILL.md) - the `BUG.md` register contract and the other track documents.
- [studio-vault](../studio-vault/SKILL.md) - tokens, scopes and the REST endpoints used above.
- [studio-spec-pipeline](../studio-spec-pipeline/SKILL.md) - where the defect flow fits in a track.
- [Skills index](../README.md) - installation and trigger phrases.
