import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MemoryVaultStore } from "../src/store/memory.mjs";
import { FsObjectStore } from "../src/store/objects.mjs";
import { parseBugReadme, scanAll } from "../src/import/scan.mjs";
import { executeImport } from "../src/import/importer.mjs";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const silent = { info() {}, warn() {}, error() {} };

const README_E2E = [
  "ID: 13608209",
  "标题: [E2E] demo-case-1 open-menu: Click the demo build card",
  "类型: bug",
  "Tags: bug, e2e",
  "描述: case=demo-release-1",
  "domain=demo",
  "covers=['E2E-DEMO-1']",
  "session_id=demo-session-1",
  "step=open-menu",
  "reason=act failed",
  "script={\"ok\": false, \"result\": {\"rotation\": -1}}",
  "probes={\"ok\": true, \"skipped\": true}",
  "e2e_report=C:\\workspace\\demo\\reports\\e2e\\run\\report.json",
  "E2E报告: C:\\workspace\\demo\\reports\\e2e\\run\\report.json",
  "分支: feat/demo-001",
  "commit: 33ed4e9a6",
  '构建: {"version":"0.1.0","milestone":"M1","engine":{"name":"Godot","version":"4.5-stable"},"os":{"name":"Windows"},"hw":{"gpu":"GPU-0"}}',
  '环境: {"os":"Windows","window":{"w":2560,"h":1440}}',
  '复现: {"frequency":"always","attempts":3}',
  '复现步骤: [{"id":"1","text":"打开菜单"},{"id":"2","text":"选择演示场景"}]',
  '世界状态: {"seed":"123456","slot":"save_01","chunk":{"x":61,"y":26}}',
  '上报者: {"id":"tester-01","source":"f3"}',
  "优先级: P1",
  "严重度: 严重",
  "关联轨: track-demo-1",
  "复现时间: 2026-11-01T06:06:11",
  "日志: log-2026-11-01.jsonl",
  "截图: screenshot-01.png",
  "状态: 新",
  "",
  "历史变更:",
  "- [2026-11-01T06:06:11] 创建 (ID: 13608209)",
  "",
].join("\n");

test("parseBugReadme keeps multi-line E2E description and parses direct-report fields (no fake fields)", () => {
  const parsed = parseBugReadme(README_E2E);
  assert.equal(parsed.legacyId, "13608209");
  assert.equal(parsed.branch, "feat/demo-001");
  assert.equal(parsed.commitSha, "33ed4e9a6");
  assert.equal(parsed.build.version, "0.1.0");
  assert.equal(parsed.env.os, "Windows");
  assert.equal(parsed.steps.length, 2);
  assert.equal(parsed.worldState.seed, "123456");
  assert.equal(parsed.reproRate.frequency, "always");
  assert.equal(parsed.reporter.id, "tester-01");
  assert.equal(parsed.priority, "P1");
  assert.equal(parsed.severity, "high");
  assert.equal(parsed.sourceTrack, "track-demo-1");
  assert.equal(parsed.e2eReport, "C:\\workspace\\demo\\reports\\e2e\\run\\report.json");
  assert.ok(parsed.description.includes("case=demo-release-1"));
  assert.ok(parsed.description.includes("domain=demo"));
  assert.ok(parsed.description.includes("script={\"ok\": false"), "continuation lines stay in description");
  const fieldKeys = Object.keys(parsed.fields);
  assert.ok(!fieldKeys.some((key) => key.startsWith("script=")), "no fake script= field");
  assert.ok(!fieldKeys.some((key) => key.startsWith("probes=")), "no fake probes= field");
  assert.ok(!fieldKeys.some((key) => key.startsWith("e2e_report=")), "no fake e2e_report= field");
});

test("import maps direct-report fields to bug columns/payload and marks dataGaps", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vault-direct-import-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const worktree = "demo-project_test";
  const pkgDir = path.join(tempRoot, worktree, "game", "reports", "bugs", "bug-20261101-060611-305");
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(path.join(pkgDir, "Readme.md"), README_E2E);
  await fs.writeFile(path.join(pkgDir, "log-2026-11-01.jsonl"), '{"event":"boot"}\n');
  await fs.writeFile(path.join(pkgDir, "screenshot-01.png"), Buffer.from("fake-png"));
  const scan = await scanAll({ sources: [path.join(tempRoot, worktree)], log: () => {} });
  assert.equal(scan.counters.packages, 1);
  const pkg = scan.packages[0];
  assert.equal(pkg.branch, "feat/demo-001");
  assert.equal(pkg.commitSha, "33ed4e9a6");
  assert.equal(pkg.priority, "P1");

  const config = { migrationsDir: MIGRATIONS_DIR, devSeed: false, devProjects: [], devTokens: [], dataDir: tempRoot };
  const store = new MemoryVaultStore(config, silent);
  await store.init();
  await store.ensureProject("demo-project_test", "demo-project_test");
  const objectStore = new FsObjectStore({ root: path.join(tempRoot, "objects") });
  await objectStore.init();
  const run = await store.createMigrationRun({ projectId: "demo-project_test", kind: "bug-package-import", source: "test", mode: "execute", status: "running" });
  const result = await executeImport({ store, objectStore, projectId: "demo-project_test", scanResult: scan, runId: run.id, logger: silent, progressEvery: 0 });
  assert.equal(result.counters.bugsCreated, 1);
  const bugs = await store.listBugs("demo-project_test", { limit: 10 });
  assert.equal(bugs.total, 1);
  const bug = bugs.items[0];
  assert.equal(bug.branch, "feat/demo-001");
  assert.equal(bug.commitSha, "33ed4e9a6");
  assert.equal(bug.priority, "P1");
  assert.equal(bug.severity, "high");
  assert.equal(bug.sourceTrack, "track-demo-1");
  assert.equal(bug.payload.build.version, "0.1.0");
  assert.equal(bug.payload.steps.length, 2);
  assert.equal(bug.payload.reproRate.frequency, "always");
  assert.equal(bug.payload.caseContext.case_id, "demo-release-1");
  assert.equal(bug.payload.dataGaps.includes("caseContext"), false);
  const audit = await store.queryAudit("demo-project_test", { limit: 100 });
  const actions = audit.items.map((event) => event.action);
  assert.ok(actions.includes("bug.import"), "import must audit bug creation");
  assert.ok(actions.includes("report.import"), "import must audit report creation");
});
