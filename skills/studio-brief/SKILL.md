---
name: studio-brief
description: "Write a game-feature brief as docs/briefs/<date>-<topic>/BRIEF.md and move it through the Studio brief state machine (草稿 / 可交 spec-engine / 实现中 / 已实现 / 已否决) in the viewer or via POST /api/specviewer/transition, then hand off to the spec process. Use when drafting a brief, fixing a missing or wrong 状态 line, reviewing a brief, or deciding what belongs in an ADR or lessons learned. 触发词：写简报 / BRIEF.md / 简报状态 / 推进简报 / 标记可交 / 开始实现 / 否决简报 / 简报模板 / ADR / lessons learned。"
---

# Studio brief: write, review and move it

A **brief** is a folder under `docs/briefs/` that contains a `BRIEF.md`: one
reviewable statement of a problem and a proposed solution. The folder name is
the brief id; the `状态:` line is the workflow state, so changes show in `git log`.

> **Command convention.** `studio <cmd>` means `studio` on PATH, or from the
> `studio-vault` checkout: `node packages/cli/bin/studio-cli.js <cmd>` (or
> `node <studio-vault>/packages/cli/bin/studio-cli.js <cmd>` from a game repo).
> Run commands inside `<game-repo>`, which holds `studio.config.json`, unless noted.

## 1. Create the folder and file

```text
docs/briefs/<YYYY-MM-DD>-<topic>/BRIEF.md
```

- Start with the local creation date `YYYY-MM-DD`; the viewer sorts and groups
  by it (an undated folder name is still listed but has no date).
- Use a short kebab-case `<topic>` (`2026-05-12-stamina-cost-rework`).
- One folder per brief. Rename only before review; never rename an accepted
  brief (link to it from new documents instead).
- The folder name is the `id` used by the viewer and the transition API.

`BRIEF.md` skeleton - keep the title and status lines, adapt the sections:

```markdown
# 简报：Stamina cost rework

日期: 2026-05-12
状态: **草稿**

## 1. 问题
What is broken today, for whom, and why now.

## 2. 目标
1. Observable outcome the team can verify after implementation.

## 3. 非目标 / 4. 约束
- Explicit exclusions, engine/platform/schedule/dependency limits.

## 5. 方案
Proposed approach and the main alternative(s) considered.

## 6. 验收标准
| ID | 标准 |
|----|------|
| AC-1 | Verifiable acceptance criterion. |

## 7. 待决问题 / 8. 参考
- Blocking questions; related briefs, specs, tickets or design docs.

## 9. 变更记录
| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1 | 2026-05-12 | 初稿 |
```

The first `# ` line is the displayed title (`# Brief: ...` also works). The
`状态:` line is required; a missing line displays as `草稿`, so write it explicitly.

## 2. The status line
Allowed values, exactly:

| Status | Meaning |
|---|---|
| `草稿` | Draft; still being written. |
| `可交 spec-engine` | Reviewed and ready to become a spec package / track. |
| `实现中` | Implementation started. |
| `已实现` | Shipped and verified. |
| `已否决` | Rejected; kept as a decision record. |

Keep the format `状态: <value>` or `状态: **<value>**`; bolding is preserved.
A transition rewrites that one line only; the rest of the file is untouched.

## 3. Move it through the state machine

| Action | From | To | When |
|---|---|---|---|
| `mark_ready` | 草稿 | 可交 spec-engine | Review passed; scope and criteria are clear. |
| `start_impl` | 可交 spec-engine | 实现中 | Implementation started. |
| `mark_done` | 实现中 | 已实现 | Shipped and verified. |
| `reject` | 草稿 / 可交 spec-engine / 实现中 | 已否决 | Decided not to do it; record why. |
| `send_back` | 可交 spec-engine | 草稿 | Review found gaps. |
| `undo` | 已实现 / 实现中 / 已否决 | one step back | Mistaken transition. |
| `interrupt` | 实现中 / 已实现 | unchanged | Record a pause without changing state. |

Two equivalent ways to run a transition:

1. **Viewer.** `studio serve`, open **Briefs**, select the brief and press the
   status button; the 状态 line is rewritten in place.
2. **HTTP.** With the viewer running, on the same machine:

```bash
curl -s -X POST http://127.0.0.1:3456/api/specviewer/transition \
  -H "Content-Type: application/json" \
  -d '{"kind":"brief","id":"2026-05-12-stamina-cost-rework","action":"mark_ready"}'
```

The response is `{ok, from, to, skipped, statusWritten}`; `skipped:true` means
already at the target state. Errors: `404 not_found` (missing folder or
`BRIEF.md`), `400 unknown_action` / `invalid_id`, `409 illegal_transition`.
The endpoint accepts `id`, `folder` or `itemId` as the brief id.

Write routes only accept loopback clients, so run transitions on the viewer
host. With `--readonly` every write is rejected with `403 read_only`.

## 4. Review checklist

Before `mark_ready`:

- [ ] Problem names who is affected and why it matters now.
- [ ] Goals are observable; non-goals and constraints are explicit.
- [ ] Acceptance criteria have stable IDs (`AC-1` ...) and are testable.
- [ ] Open questions are resolved or clearly non-blocking.
- [ ] No other accepted brief or spec changes silently; owners are named.

After `mark_done`, add a `变更记录` row with the release/commit that shipped it.

## 5. Hand-off to specs and the shared repo

Accepting a brief does not create spec documents: turn it into
`specs/<package>/<track>/` documents (task list, test plan, design) with the
team's spec process, linking back to the brief folder. Briefs are mirrored under
`docs/briefs/`; see [studio-shared-repo](../studio-shared-repo/SKILL.md) for `sync` / `commit`.

## 6. ADRs and lessons learned

Use the brief for the proposal and its review; use these for knowledge that
outlives the feature:

| Surface | Write when | Where |
|---|---|---|
| **ADR** | A cross-team or hard-to-reverse decision (data format, authority boundary, tooling contract) needs its own record. | Your team's ADR directory in the shared repository, one numbered file per decision; link it from the brief's `参考` section. |
| **Lessons learned** | After implementation, when the estimate, design or process was wrong in a reusable way. | Append to the brief's `变更记录`, or a team retro/lessons document; link it from the next brief. |

Do not rewrite an accepted brief to match what was built: add a changelog row
and a short "as implemented" note, so the review history stays intact. Rejected
briefs stay in the tree with `已否决` and a one-line reason.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Brief missing in the viewer | The folder is not directly under `docs/briefs/`, or has no `BRIEF.md`. |
| State shows `草稿` unexpectedly | No parseable `状态:` line, or the value is outside the five allowed strings. |
| `409 illegal_transition` | The action does not start from the current state; check the matrix or `undo` first. |
| `404 not_found` | The id is the folder name, not the title; check the path. |
| `403 read_only` | The viewer was started with `--readonly`. |

## Related skills

- [studio-workspace](../studio-workspace/SKILL.md) - workspace setup, doctor, viewer.
- [studio-shared-repo](../studio-shared-repo/SKILL.md) - sync briefs with the team repo.
- [studio-bug](../studio-bug/SKILL.md) - report defects against an implementation.
- [Skills index](../README.md) - installation and trigger phrases.
