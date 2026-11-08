# Studio companion skills

Nine portable skills that teach an AI coding agent how to operate a Studio
workspace, briefs, the spec documents, the team shared repository, bug packages,
the defect fix loop, optional multi-station runs and the Vault data service. A
skill is a plain Markdown `SKILL.md` with YAML frontmatter - **there is no
runtime, no dependency and no effect on the Studio CLI**. The file is read by an
agent that supports skills, so it changes how the agent works, not what the
tools do.

- English content with Chinese trigger words, so the same file works for both
  audiences.
- Commands are the real Studio CLI commands (`studio <cmd>`, or
  `node <studio-vault>/packages/cli/bin/studio-cli.js <cmd>` from a source
  checkout).
- Cross-links are relative, so the skills work as a set wherever they are
  installed.

## Index

| Skill | Use it when | Skip it when | Triggers (EN / 中文) |
|---|---|---|---|
| [studio-workspace](studio-workspace/SKILL.md) | Setting up a workspace, reading `studio doctor`, starting or fixing the viewer. | You already have a running workspace and need a specific workflow. | initialize studio workspace / start viewer / doctor output / 初始化工作区 / 起 viewer / doctor 报错 |
| [studio-brief](studio-brief/SKILL.md) | Writing a `BRIEF.md`, reviewing it, moving it through the brief state machine, deciding on ADRs and lessons. | The work already has an accepted brief and a track; start from `studio-spec`. | write a brief / brief status / mark ready / 写简报 / 简报状态 / 标记可交 |
| [studio-spec](studio-spec/SKILL.md) | Writing or repairing spec packages and tracks, adding or registering a domain, deciding which document owns a fact, explaining an incomplete Specs or Domains page. | You need the order of work rather than the document contract - use `studio-spec-pipeline`. | spec documents / PRD / TECH / TRACE matrix / domain index / _index.yml / 8 documents / 规格文档 / 写 PRD / 写 TECH / 域索引 / 追溯矩阵 / 8 份文档 / 文档缺失 |
| [studio-spec-pipeline](studio-spec-pipeline/SKILL.md) | Turning an accepted brief into a delivered track: gates, two review stations, definition of done, send-backs. | The documents already exist and you only touch one of them; or the change is too small to need a track. | brief to track / spec gates / 8/8 / traceability gate / DoD / send back / 从简报建轨 / spec 流水线 / 门禁 / 退回简报 |
| [studio-shared-repo](studio-shared-repo/SKILL.md) | Syncing briefs with the team shared repo, running `bootstrap` / `sync` / `commit` / `watch`, recovering from write-back conflicts. | The team is single-machine and no shared repository is configured. | shared repo sync / mirror / write-back conflict / 共享仓 / 同步简报 / 写回冲突 / journal 恢复 |
| [studio-bug](studio-bug/SKILL.md) | Filing a bug package with evidence, triaging it, reporting directly to Vault, repairing the offline pending queue. | The defect is already filed and you are fixing it - use `studio-bugfix`. | file a bug / bug evidence / triage / Vault report / 提 bug / 缺陷证据 / 复现步骤 / pending 队列 |
| [studio-bugfix](studio-bugfix/SKILL.md) | Fixing a defect: registering it in the track `BUG.md`, RED test, regression, close verdicts, Vault version conflicts. | You only need to produce the report package, not the fix. | fix a bug / BUG.md register / RED test / regression / not a defect / duplicate / 修 bug / 缺陷修复 / 回归 / 非缺陷 / 重复缺陷 |
| [studio-orchestration](studio-orchestration/SKILL.md) | Large or cross-surface runs: stations, handoff packets, write isolation, bounded repair rounds, escalation. | One agent and one small change; the plain pipeline is faster. | multi-station run / handoff contract / write scope / escalation / 多站编排 / 交接契约 / 写域隔离 / 修复轮 / 升级 |
| [studio-vault](studio-vault/SKILL.md) | Using the Vault REST API, tokens and scopes, report upload, ingest, audit, backup and migration. | Vault is not configured and the workspace is local-only. | Vault API / token scope / upload evidence / backup / Vault 服务 / 证据上传 / 备份 |

Reading order for a new team: `studio-workspace` first, then `studio-brief`, then
`studio-spec` (the document contract) and `studio-spec-pipeline` (the order of
work), then `studio-shared-repo` (only if the team shares briefs), then
`studio-bug` and `studio-bugfix`, then `studio-vault` (only if the team runs the
service). `studio-orchestration` is optional and only pays off on large runs.

## Install into a game repository

Copy the skill directories into the place where your agent loads skills. These
common locations are all supported; pick the one your agent uses:

| Agent convention | Directory |
|---|---|
| Generic / multi-agent | `<game-repo>/.agents/skills/` |
| Claude Code | `<game-repo>/.claude/skills/` |
| DeepSeek Harness | `<game-repo>/.dsh/skills/` |
| OpenCode | `<game-repo>/.opencode/skills/` |

```bash
# 1) plain copy (works everywhere; README.md is copied too, no harm)
cp -r <studio-vault>/skills/* <game-repo>/.agents/skills/

# 2) or the zero-dependency installer (creates the directory if missing)
node <studio-vault>/scripts/install-skills.mjs --target <game-repo>
node <studio-vault>/scripts/install-skills.mjs --target <game-repo> --dir .claude/skills

# options
#   --target <dir>   game repository root (default: current directory)
#   --dir <path>     destination under the target (default: .agents/skills)
#   --force          overwrite skill directories that already exist
#   --help           usage
```

The installer copies the nine skill directories plus this index as `README.md`,
prints what it installed, updated or skipped, and exits non-zero only on a real
error. Re-running it without `--force` is safe: existing skills are left
untouched. Use `--force` to update installed copies after pulling a newer
`studio-vault`.

To uninstall, delete the nine directories (and `README.md` if you do not want the
index) under your skills folder; nothing else was written.

## Verify the installation

```bash
ls <game-repo>/.agents/skills/                # 9 skill dirs + README.md index
head -5 <game-repo>/.agents/skills/studio-spec/SKILL.md   # YAML frontmatter with name + description
```

Each `SKILL.md` must start with a `---` frontmatter block containing `name`
(equal to the directory name) and `description` (what the skill does plus its
trigger words). The rest of the file is the instruction body.

## Notes for skill authors

- Keep the frontmatter format stable; agents use `name` and `description` to
  decide when to load a skill.
- Put trigger words in the description (English and Chinese), not in the body.
- Keep commands runnable: use `studio <cmd>` plus the source-checkout form, and
  the placeholders `<game-repo>`, `<shared-repo>`, `<vault-url>`, `<package>`,
  `<track>`.
- Keep cross-links relative (`../studio-bug/SKILL.md`) so the set stays portable.
- Do not document features the CLI does not have; compare against the real
  `--help` output after CLI changes.
- Say which rules are enforced by code and which are team convention (for
  example the viewer counts present documents, and nothing validates their
  content). Readers need to know what a green check actually means.
- The skill body should stay short enough to read in one session; detailed
  contracts belong in the repository docs and are linked from the skill.

## Related documentation

These links resolve inside the `studio-vault` checkout. After installing the
skills elsewhere, start from the skill-to-skill links above or open the docs in
the checkout.

- [README.md](../README.md) - the project overview and quickstart.
- [docs/QUICKSTART.md](../docs/QUICKSTART.md) - try Vault in memory mode and Studio in demo mode.
- [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) - Studio layers, viewer data flow and Vault internals.
- [vault/README.md](../vault/README.md) - Vault API table and deployment.
