---
name: studio-orchestration
description: "Optional multi-station orchestration for large Studio runs: split a track across independent stations (builder, document reviewer, coder, code reviewer, end-to-end verifier), pass explicit handoff packets, isolate write scopes, bound repair rounds and escalate on repeated failure. Use when one run spans several documents and code surfaces, when a single context cannot hold the whole track, or when you need a repeatable runbook that any agent tool or team can follow. 触发词：多站编排 / 站角色 / 流水线编排 / 交接契约 / DAG / 并行 / 写域隔离 / 修复轮 / 升级 / captain / 大 run / 跨面。",
---

# Studio orchestration: stations, handoffs, escalation

An optional layer on top of [studio-spec-pipeline](../studio-spec-pipeline/SKILL.md).
It defines roles, work packets and gates in tool-neutral terms: the same runbook
applies to separate agent sessions, to delegated subagents, to a scripted
pipeline, or to one person switching hats. Nothing here replaces the document
contract - it only says who may write what, in which order, and how a failure
comes back.

> **Path convention.** `<game-repo>` is the workspace holding
> `studio.config.json`; `<package>` and `<track>` are the directories under
> `specs/` described in [studio-spec](../studio-spec/SKILL.md).

## 1. When to use it, and when not

Use it when: one track spans several documents and code surfaces and a single
context would have to hold all of it; the work must be repeatable by different
agents or people; review independence matters, so the author and the reviewer
must be different runs.

Skip it when: the change is small and one or two documents are enough (the plain
pipeline is faster); the environment cannot start a separate station or pass a
packet; or the packet overhead is larger than the work. The pipeline is the
default; orchestration is an escalation, not a ceremony.

## 2. Stations

| # | Station | Consumes | Produces | Gate before the next station |
|---|---|---|---|---|
| 1 | builder (spec) | Accepted brief + its frozen decisions | `INPUT.md` `PRD.md` `TECH.md` `TASK.md`, draft `TRACE.md` `TEST.md` | Documentation gate passes. |
| 2 | document reviewer | All eight documents + the brief | `REVIEW.md` entry: verdict, numbered findings (`RV-01`, ...) | Pass, or send-back to 1. |
| 3 | coder | Reviewed documents + write scope | Code, `TASK.md` states, `TEST.md` execution rows, RED record | RED demonstrated, suite green locally. |
| 4 | code reviewer | Diff + the documents it claims to satisfy | `REVIEW.md` entry: verdict, findings (`CR-01`, ...) | Pass, or repair round to 3. |
| 5 | e2e verifier | Running build + `TEST.md` end-to-end cases | Execution records and evidence | Verified, or repair round to 3. |

Station numbers are a convention, not a requirement: keep the roles, drop the
numbering when a run needs a different split.

## 3. The handoff packet

Every station receives and returns the same fields. Write the packet down before
starting the station; a station may read only what the packet lists.

```text
station:      <number and name>
track:        specs/<package>/<track>/
input docs:   <exact paths this station may read; everything else is out of scope>
acceptance:   <the FR-* / AC-* ids and gate conditions this station must satisfy>
write scope:  <paths this station may modify; must not overlap a live station>
output:       <paths it must create or update>
evidence:     <commands run, results, artifacts>
verdict:      pass | repair | escalated
```

Rules that keep packets useful: one claim per line, each with evidence; the
station reports findings it cannot fix instead of editing another station's
documents; a repair verdict lists the finding ids it closes.

## 4. DAG template

```text
          brief (可交 spec-engine)
                    |
             [1 builder]        docs: INPUT PRD TECH TASK TRACE TEST
                    |
             [2 doc-reviewer] --send-back--> [1]
                    | pass
             [3 coder]   <---------------------+
                    |                          | repair round (max 2)
             [4 code-reviewer] --findings--> [3]
                    | pass
             [5 e2e verifier] --fail--> repair round --> [3]
                    | pass
              close track, advance brief
```

The main chain is serial. Two branches leave it: the **document-review branch**
(station 2 loops back to 1, or carries non-blocking observations forward to 4)
and the **end-to-end branch** (station 5 loops to 3). The end-to-end cases can
be prepared while station 3 implements - authoring cases reads `TEST.md`, not
the diff - but execution waits for a build that contains the fix.

## 5. Parallelism and write isolation

- One live writer per path set. List each station's write scope before starting
  stations in parallel; overlapping scopes are a blocker, not a scheduling detail.
- Single writer per shared document. `REVIEW.md` is appended by stations 2, 4 and
  5: either serialise the appends in station order, or give each station its own
  section and forbid cross-editing.
- Different track directories are safe to edit in parallel. Two stations editing
  the same domain `CURRENT.md` or `_index.yml` are not: the domain is a shared SSOT.
- Never run shared-repository write commands (`studio sync`, `studio commit`)
  from two stations at once; the single-writer lock and journal exist for a
  reason ([studio-shared-repo](../studio-shared-repo/SKILL.md)).
- Merge gate: a repair is merged only after the reviewer that raised the finding
  re-checks it. A station never merges its own repair.

## 6. Repair rounds and escalation

- A repair round is bounded: at most two per finding, then escalate.
- Each round names the finding ids it closes (`RV-03`, `CR-01`), what changed,
  and the evidence that the behaviour now matches the acceptance criterion.
- Escalate when: the same finding fails twice; the decision is outside the
  station's authority; acceptance criteria contradict each other; the environment
  (build, emulator, service) is unavailable.
- Escalation packet: track, station, finding ids, evidence, what was tried, the
  decision needed, and whose call it is. Escalating is a normal outcome, not a
  failure - silently dropping a finding is the failure.
- Never "fix" by weakening the acceptance criterion. Changing the criterion is a
  spec decision for the brief or spec owner, recorded with a changelog row.

## 7. Captain: run ownership and report

One station owns the run: splits the stations, assigns write scopes, tracks
verdicts, and does not edit the same files as a live station. Keep a run log
(station, packet, verdict, findings, next) and close with:

```text
Run:            <track> (<package>)
Brief:          <path> state at start -> end
Docs:           N/8; trace gaps: <list or none>
Implementation: <commit or change range>; RED record: <path>; regression: <systems>
Findings:       RV-xx closed/rejected; CR-xx; repair rounds used
Status:         delivered | blocked (reason) | escalated (to whom)
Follow-ups:     <residual risk, deferred debt, next track>
```

## 8. Degraded path: one agent, one session

- Run the stations sequentially, but keep the separation explicit: write the
  handoff packet, finish the station, then start the next one from the packet and
  the input documents - not from what you remember writing.
- A review pass must re-read the documents from disk after they are frozen, and
  apply the reviewer checks, not the author checks.
- If genuine independence is impossible, say so in `REVIEW.md` ("self-review
  only"). A declared self-review is a known risk; a hidden one is a false gate.
- Keep every gate. A single agent skipping gates "because it is only one agent"
  removes the only thing the process was buying.

## Related skills

- [studio-spec-pipeline](../studio-spec-pipeline/SKILL.md) - the gates and steps the stations execute.
- [studio-spec](../studio-spec/SKILL.md) - the document contract each station writes against.
- [studio-bugfix](../studio-bugfix/SKILL.md) - repair work that arrives as a defect.
- [studio-shared-repo](../studio-shared-repo/SKILL.md) - single-writer rules for shared writes.
- [Skills index](../README.md) - installation and trigger phrases.
