# Workspace templates (used by `studio init`)

These files are the scaffolding sources for `studio init --demo`. They are read
by `packages/studio/src/commands/init.js`, have `{{KEY}}` placeholders substituted,
and are then written into the target workspace:

| Template | Generated path |
|---|---|
| `demo/BRIEF.md` | `docs/briefs/<YYYY-MM-DD>-demo-brief/BRIEF.md` |
| `demo/bug-Readme.md` | `game/reports/bugs/bug-<YYYYMMDD>-000000-9001/Readme.md` |
| `demo/buildings.json` | `game/src/data/buildings.json` |

Available placeholders: `{{PROJECT_ID}}`, `{{PROJECT_NAME}}`, `{{DATE}}`,
`{{NOW}}`, `{{BUG_ID}}`, `{{NODE_VERSION}}`.

When adding a placeholder, update `templateVars()` in `init.js` as well. If a
placeholder is left unfilled, `init` fails fast instead of writing broken
content into the workspace.
