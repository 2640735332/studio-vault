---
name: studio-spec
description: "Contract for the spec artefacts a Studio workspace keeps under specs/: the eight per-track documents (INPUT, PRD, TECH, TASK, TRACE, REVIEW, TEST, BUG), the three package documents (SPEC, ARCH, GLOSSARY), and the domain registry specs/<package>/domains/_index.yml with a CURRENT / TESTS / VISUAL trio per domain. Use when creating or repairing a spec package or track, adding or registering a domain, deciding which document owns a fact, or explaining why the viewer Specs or Domains page shows something missing or incomplete. 触发词：规格文档 / 规格契约 / 写 PRD / 写 TECH / 写 TASK / TRACE 追溯 / 追溯矩阵 / 域索引 / _index.yml / 新增域 / 8 份文档 / 包级文档 / 规格页 / 文档缺失。",
---

# Studio spec: the document contract

`specs/` is the durable, reviewable record of what a game is supposed to do and
how it was verified. The viewer reads it directly: **Specs** lists packages,
tracks and their documents; **Domains** lists the behavioural domains. Nothing
is generated - the documents are hand-written Markdown, and the viewer checks
presence, not correctness.

> **Path convention.** Paths are relative to `<game-repo>`, the workspace that
> holds `studio.config.json`. `<package>` is a directory under `specs/`;
> `<track>` is one feature slice inside a package, named `track-<number>-<topic>`
> (the `track-` prefix is required: track-level bug sync scans `track-*` only).

## 1. The tree

```text
specs/<package>/
  SPEC.md  ARCH.md  GLOSSARY.md          # package documents (3)
  domains/
    _index.yml                           # domain registry (SSOT)
    <domain>/
      CURRENT.md  TESTS.md  VISUAL.md    # required trio
      e2e/                               # end-to-end case files
  <track>/
    INPUT.md PRD.md TECH.md TASK.md TRACE.md REVIEW.md TEST.md BUG.md   # 8
```

The scanner - not taste - defines what is visible:

- Every directory directly under `specs/` is a package; every directory under a
  package except `domains` is a track. A scratch folder becomes a phantom track
  showing `0/8`, so keep working files outside `specs/`.
- Package-level entries `schema.json`, `STANDARDS.md` and `node_modules` are
  skipped; dot-directories are ignored at both levels.
- File names are exact and case-sensitive (`PRD.md`, not `prd.md`). The package
  description comes from the `## 概述` (overview) section of `SPEC.md`.

## 2. The eight track documents

| File | Standard label | Must contain |
|---|---|---|
| `INPUT.md` | - | Source table (date, source, form, provider) linking the brief under `docs/briefs/` and any 8-digit player report id; raw description; track-vs-extension decision with rejected alternatives; frozen open questions; code facts with the date checked. |
| `PRD.md` | IEEE 830-1998 | Purpose, scope, non-goals, references, dependencies; requirements `FR-01`, ... each independently verifiable; acceptance criteria `AC-01`, ... mapped back to the brief ACs; data contracts. |
| `TECH.md` | IEEE 1016-2009 | Current-state inventory, architecture, components `COMP-01`, ... each tied to a decision `ADR-001`, ... (or a stated reason for none), interfaces, rationale, ADR index. |
| `TASK.md` | TASK state machine | One row per unit: id, description, state, owner, estimate, linked `FR-*` / `AC-*`, note; implementation order; changelog. |
| `TRACE.md` | ISO/IEC/IEEE 29148:2018 | Forward table (requirement, design, task, test) and backward table (test, requirement); AC coverage check; gaps called out, never omitted. |
| `REVIEW.md` | IEEE 1028-2008 | Review log (date, scope, participants, verdict); author self-check; findings with stable ids (`RV-01`, ...); fix-round records. |
| `TEST.md` | ISO/IEC/IEEE 29119-3 | Plan (scope, environment, strategy, expected-to-fail-first list, known traps); matrix `TC-01` ... against requirements; unit vs end-to-end split; E2E by priority; execution records with date and result. |
| `BUG.md` | IEEE 1044 | Defect register: overview table (id, summary, state, severity, priority, source, linked requirement, found date), one detail section per defect, changelog. |

Put a fact at package level when more than one track needs it; do not repeat a
package rule in every track and let the copies drift.

## 3. The three package documents

| File | Standard | Content |
|---|---|---|
| `SPEC.md` | - | What the package is; its `## 概述` section is the viewer description. |
| `ARCH.md` | IEEE 1016-2009 | Cross-track architecture shared by all tracks. |
| `GLOSSARY.md` | - | One name per concept; the vocabulary every document reuses. |

## 4. Domain registry and the trio

`specs/<package>/domains/_index.yml` is the single source of truth for which
behavioural domains exist. The viewer parses a deliberately small YAML subset:

```yaml
package: <package>
domains:
  - id: <domain>
    title: <human-readable name>
    code:
      - src/<area>/<file>
    tracks:
      - track-<number>-<topic>
    gut:
      - tests/<test-file>
    e2e:
      - specs/<package>/domains/<domain>/e2e/<case>.json
```

- `id` is the directory name; `title` is what the viewer displays; `code` lists
  the source files the domain owns - forget one and the next reader misses it.
- The lists are an index, not a second copy: `gut` and `e2e` must match the
  current table in that domain `TESTS.md`.
- Keep the file flat as shown: 4-space keys, 6-space `- ` items, plain or quoted
  scalars. Tabs, nested maps, anchors and multi-line strings do not parse.
- A domain directory carries `CURRENT.md` (what the system does now, one section
  per acceptance criterion plus an explicit not-doing list), `TESTS.md` (test
  index and scheduling) and `VISUAL.md` (art and presentation pointers).
- Never register an id without the trio: a registered domain with no `CURRENT.md`
  shows no current link, which is worse than not registering it yet. A track
  delivers a slice; `CURRENT.md` absorbs the delivered behaviour.

## 5. TASK state machine

| State | Meaning |
|---|---|
| `Backlog` | Known, not committed. |
| `TODO` | Committed for this track, not started. |
| `In Progress` | Being implemented. |
| `Review` | Implemented, awaiting review or verification. |
| `Done` | Reviewed and verified. |
| `Blocked` | Cannot proceed; the blocker is named in the note. |
| `Cancelled` | Will not be done; the reason is recorded. |

Move forward one step at a time; `Blocked` and `Cancelled` must name a reason.
This vocabulary is enforced by review, not by the CLI: the viewer only checks
that `TASK.md` exists.

## 6. How the viewer counts

- `GET /api/packages` returns one object per package:
  `{name, path, description, packageDocs: {SPEC.md, ARCH.md, GLOSSARY.md},
  tracks: [{name, path, docs: {INPUT.md, ...}}]}` - one boolean per document.
- The Specs page shows package documents as `N/3` and each track as `N/8`, with
  a check mark or cross and the standard name per row.
- `GET /api/domains` returns `{package, id, title, tracks, gut, e2e, code,
  current}` per registered domain; `current` is a path when `CURRENT.md` exists,
  otherwise `null`.
- Counting is presence only: no content, link, traceability row or TASK state is
  validated. A green `8/8` means the files exist, nothing more.

## 7. Common failures

| Symptom | Cause / fix |
|---|---|
| Track shows `0/8` | Files not directly in the track directory, or another case / extension. |
| Track missing from Specs | It sits under `domains/`, or one directory level too deep. |
| Package shows `0/3` | `SPEC.md` / `ARCH.md` / `GLOSSARY.md` misspelled or lower-case. |
| Phantom package or track | A scratch directory was left under `specs/`; move it out. |
| Domain listed, no current link | `CURRENT.md` missing from the domain directory. |
| Domain missing entirely | No `_index.yml`, entry not under `domains:`, or tabs/indentation broke the subset. |
| Traceable on paper only | `TRACE.md` names `FR-*`, `COMP-*`, `TASK-*`, `TC-*` ids no sibling document defines. |

## 8. Self-check before hand-off

```bash
ls specs/<package>/{SPEC,ARCH,GLOSSARY}.md                        # package: 3
ls specs/<package>/<track>/*.md                                   # track: 8
ls specs/<package>/domains/<domain>/{CURRENT,TESTS,VISUAL}.md     # domain: trio
grep -o "FR-[0-9]*" specs/<package>/<track>/PRD.md | sort -u       # then diff against TRACE
```

Run these from the workspace root (PowerShell: `Get-ChildItem` instead of `ls`).
A reviewer should repeat them: they are the viewer checks plus the traceability
comparison the viewer does not perform.

## Related skills

- [studio-spec-pipeline](../studio-spec-pipeline/SKILL.md) - the flow that produces these documents.
- [studio-bugfix](../studio-bugfix/SKILL.md) - defects recorded in a track `BUG.md`.
- [studio-brief](../studio-brief/SKILL.md) - the brief that seeds a track.
- [studio-workspace](../studio-workspace/SKILL.md) - create the tree and start the viewer.
- [Skills index](../README.md) - installation and trigger phrases.
