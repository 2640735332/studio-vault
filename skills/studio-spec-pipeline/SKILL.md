---
name: studio-spec-pipeline
description: "Run the Studio spec pipeline: turn one accepted brief from docs/briefs/ into one delivered track under specs/<package>/<track>/ with eight documents, two independent review stations and explicit gates. Use when starting a track from a ready brief, deciding what to write before code, checking whether a track is complete enough to review or close, or handling a send-back. 触发词：spec 流水线 / 从简报建轨 / 建 track / 规格门禁 / 8/8 文档 / 追溯完整 / DoD / 两站审核 / 退回简报 / 可交 spec-engine / 交付轨 / 规格站。",
---

# Studio spec pipeline: from accepted brief to delivered track

The pipeline turns one accepted brief into one track directory with eight
reviewable documents, two independent review stations and explicit gates. It is
a process contract, not a tool: this repository ships the document contract
([studio-spec](../studio-spec/SKILL.md)) and the viewer, not a generator or a
validator.

> **Command convention.** `studio <cmd>` means `studio` on PATH, or from a
> `studio-vault` checkout: `node packages/cli/bin/studio-cli.js <cmd>`. Run it
> inside `<game-repo>`, the workspace that holds `studio.config.json`.

## 1. Entry gate

Start only when the brief is accepted. `docs/briefs/<date>-<topic>/BRIEF.md`
must carry `状态: **可交 spec-engine**` - set it with the viewer button or
`POST /api/specviewer/transition` with `{"kind":"brief","id":"<folder>","action":"mark_ready"}`
(mechanics in [studio-brief](../studio-brief/SKILL.md)). Starting from a draft
re-opens scope mid-implementation and erases the review trail: finish and review
the brief first.

## 2. The pipeline

| # | Step | Writes | Exit gate |
|---|---|---|---|
| 1 | Open the track | `INPUT.md` | Brief state is 可交 spec-engine; the source table names the brief path and any 8-digit report id. |
| 2 | Requirements | `PRD.md` | Every FR is independently verifiable; every brief AC is mapped; non-goals are listed. |
| 3 | Design | `TECH.md` | Every FR reaches a COMP; every COMP carries an ADR or a stated reason for none. |
| 4 | Plan | `TASK.md` | Every task links `FR-*` / `AC-*`; order and estimate are present. |
| 5 | Trace | `TRACE.md` | Forward and backward tables agree; no orphan FR or TC. |
| 6 | Test design | `TEST.md` | Every FR has a TC; the expected-to-fail list is written; unit vs E2E split is explicit. |
| 7 | Implement | code + `TASK.md` states | One RED test was demonstrated failing before the fix. |
| 8 | Verify | `TEST.md` execution records | Suite green; adjacent-system regression recorded with evidence. |
| 9 | Review | `REVIEW.md` | Verdict from a reviewer who is not the author, with date and scope. |
| 10 | Close | `BUG.md`, brief state | Debt and new defects logged; brief advanced to 实现中 then 已实现. |

## 3. Step notes

- **Open.** Track directory is `specs/<package>/track-<number>-<topic>/`. Take the
  next free number in the package; do not reuse a retired one. Record the
  classification decision in `INPUT.md` (new track vs. extension of an existing
  one, with rejected candidates and why). Requirements, ACs and open questions
  already fixed by the brief are frozen - reference them, do not re-derive them.
- **Requirements.** Number requirements `FR-01`, `FR-02`, ... in one list, each
  one a testable behaviour. Acceptance criteria `AC-01`, ... map to brief ACs; a
  brief AC with no home is a scope gap, not a formatting problem.
- **Design.** Describe the current state before the target state: an existing
  system that already does part of the job must be named and reused, not
  duplicated. Each `COMP-*` names the files it touches. Each decision that is
  hard to reverse becomes an `ADR-*`; a reversal is a new ADR that supersedes the
  old one, never an edit that hides the history.
- **Plan.** Split until a task fits one reviewable change. A task with no linked
  requirement is either missing scope or out of scope - resolve it before code.
- **Trace.** Build both directions: requirement -> design -> task -> test, and
  test -> requirement. The reverse table is what catches tests with no requirement.
- **Test design.** Write the failing test first and keep the RED record;
  "written after the fix" is not a RED. Split unit tests (for example GUT in Godot)
  from end-to-end runs - they prove different things and fail differently. Name
  known traps (flaky harness, silent parse errors, platform differences) in the
  plan so the next run avoids them.
- **Implement.** Keep `TASK.md` states current; a task moves to `Review` only when
  its tests exist and pass locally. Do not mix an unrelated fix into the track.
- **Verify.** Record command, environment and result, not just "green". Re-run the
  adjacent systems the change touches and record them as regression evidence.
- **Review.** Findings get stable ids (`RV-01`, ...) and each one is either fixed
  with a reference or rejected with a reason. Re-review after a fix round.
- **Close.** `BUG.md` gets the defects found during the run and any debt carried
  from the start; then advance the brief. A track is not closed while a `P0` is open.

## 4. Gates

**4.1 Documentation gate - 8/8.**

```bash
ls specs/<package>/<track>/*.md        # must list INPUT PRD TECH TASK TRACE REVIEW TEST BUG
```

A new package also needs `SPEC.md`, `ARCH.md` and `GLOSSARY.md`; a changed domain
needs its registry entry and trio updated ([studio-spec](../studio-spec/SKILL.md)).

**4.2 Traceability gate.**

- Every `FR-*` in `PRD.md` appears in `TRACE.md` forward table and has at least one `TC-*`.
- Every `COMP-*` in `TECH.md` is referenced by some `FR-*`; no orphan component.
- Every `TASK-*` in `TASK.md` appears in `TRACE.md`; no orphan task.
- Every `TC-*` in `TEST.md` appears in the backward table and points at a real requirement.
- Every `AC-*` is covered by at least one `TC-*`; gaps are listed explicitly, not dropped.

**4.3 Definition of done.**

- [ ] Eight track documents present and reviewed.
- [ ] RED record and green execution record both in `TEST.md`.
- [ ] Adjacent-system regression evidence recorded.
- [ ] Independent reviewer verdict recorded in `REVIEW.md`.
- [ ] `BUG.md` holds baseline debt and every defect found during the run.
- [ ] Domain registry and trio updated if the delivered behaviour belongs to a domain.
- [ ] Brief changelog updated and brief advanced to 已实现 (or 已否决 with a reason).

## 5. Two review stations

| Station | Reviewer | Checks | Verdict goes to |
|---|---|---|---|
| Documents | Someone other than the author, before code | Completeness, standard outlines, traceability, test plan, scope against the brief | `REVIEW.md` review log |
| Implementation | Someone other than the author, after code | Behaviour against FR/AC, RED-then-green, regression, evidence quality | `REVIEW.md` review log |

The author always self-checks first and records the self-check table in
`REVIEW.md`; the station review is a second, independent pass. A review recorded
by the author alone does not count. For multi-station runs see
[studio-orchestration](../studio-orchestration/SKILL.md).

## 6. Change control and send-back

| Situation | Do | Do not |
|---|---|---|
| Brief scope is wrong | `send_back` the brief to 草稿, fix it, re-review, then re-enter | Invent requirements in the PRD |
| Requirement changed after design | Amend `PRD.md` + changelog, then re-derive TECH / TRACE / TASK | Edit `TECH.md` alone and claim the PRD always said so |
| Implementation deviated | Record the deviation in `REVIEW.md` / `TECH.md` changelog and re-run trace | Rewrite the PRD to match the code silently |
| New defect found | Add a `BUG.md` row and follow [studio-bugfix](../studio-bugfix/SKILL.md) | Fold an unrelated fix into the track |
| Track superseded | Keep the documents, mark status and superseding track in `REVIEW.md` | Delete the track directory |

Document history is append-only: version and changelog rows stay, even when the
decision was wrong. The next reader needs the reasoning, not a tidy file.

## 7. Relation to Studio, and what is not shipped

- Briefs come from `docs/briefs/` and are mirrored to the shared repository;
  sync and write-back are covered by [studio-shared-repo](../studio-shared-repo/SKILL.md).
- Track documents are read by the viewer **Specs** page (`/api/packages`); domains
  by **Domains** (`/api/domains`). Green counts mean the files exist.
- This repository ships no spec validator, generator or linter, and no `track`
  subcommand. Real teams usually own scripts for doc lint, id cross-checks and
  numbering; the gates above describe what such a script must report. Until then
  the checks are the shell commands in section 4, run by the reviewer.

## Related skills

- [studio-spec](../studio-spec/SKILL.md) - what each document must contain.
- [studio-brief](../studio-brief/SKILL.md) - produce the accepted brief this pipeline consumes.
- [studio-bugfix](../studio-bugfix/SKILL.md) - defect flow that feeds `BUG.md`.
- [studio-orchestration](../studio-orchestration/SKILL.md) - multi-station execution of this pipeline.
- [Skills index](../README.md) - installation and trigger phrases.
