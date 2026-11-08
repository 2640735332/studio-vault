import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MemoryVaultStore } from "../src/store/memory.mjs";
import { FsObjectStore } from "../src/store/objects.mjs";
import { mapBugStatus, parseBugReadme, scanAll } from "../src/import/scan.mjs";
import { executeImport, rollbackRun } from "../src/import/importer.mjs";
import { dualRead, reconcile } from "../src/import/reconcile.mjs";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const silent = { info() {}, warn() {}, error() {} };

function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const README_A = [
  "ID: 97342253",
  "标题: isoAssets：右和上动作贴图反了",
  "描述: 四向贴图方向错",
  "复现时间: 2026-09-29T00:58:39",
  "日志: log-2026-09-29.jsonl",
  "截图: screenshot-01.png",
  '现场快照: {"scene":"Main","camera_zoom":1.75}',
  "状态: 已关闭",
  "",
  "历史变更:",
  "- [2026-09-29T02:37:22] 已关闭: 方案 A 修复",
  "",
].join("\n");

async function makeFixtureRoot(tempRoot) {
  const worktree = "demo-project_test";
  const bugsRoot = path.join(tempRoot, worktree, "game", "reports", "bugs");
  const pkgA = path.join(bugsRoot, "bug-20260929-005839-1");
  const pkgB = path.join(bugsRoot, "bug-20261001-120000-2");
  for (const dir of [pkgA, pkgB]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(pkgA, "Readme.md"), README_A);
  await fs.writeFile(path.join(pkgA, "log-2026-09-29.jsonl"), '{"event":"boot"}\n');
  await fs.writeFile(path.join(pkgA, "screenshot-01.png"), Buffer.from("fake-png-bytes-a"));
  await fs.writeFile(
    path.join(pkgB, "Readme.md"),
    ["ID: 11223344", "标题: second bug", "状态: 已关闭 · 非缺陷", ""].join("\n"),
  );
  await fs.writeFile(path.join(pkgB, "log-2026-10-01.jsonl"), '{"event":"late"}\n');
  return { worktree, bugsRoot, tempRoot };
}

test("parseBugReadme extracts the F3 package fields", () => {
  const parsed = parseBugReadme(README_A);
  assert.equal(parsed.legacyId, "97342253");
  assert.equal(parsed.title, "isoAssets：右和上动作贴图反了");
  assert.equal(parsed.reproducedAt, "2026-09-29T00:58:39");
  assert.equal(parsed.sceneSnapshot.scene, "Main");
  assert.equal(parsed.rawStatus, "已关闭");
  assert.equal(parsed.logs[0], "log-2026-09-29.jsonl");
  assert.equal(parsed.screenshots[0], "screenshot-01.png");
  assert.ok(parsed.history.length >= 1);
});

test("mapBugStatus keeps the raw status and maps known states", () => {
  assert.equal(mapBugStatus("已关闭").status, "closed");
  assert.equal(mapBugStatus("已关闭 · 非缺陷/假红").status, "false_red");
  assert.equal(mapBugStatus("已关闭 · 未复现").status, "cannot_reproduce");
  assert.equal(mapBugStatus("已修复").status, "fixed");
  assert.equal(mapBugStatus("新").status, "new");
  assert.equal(mapBugStatus("某种未知状态").status, "new");
  assert.equal(mapBugStatus("某种未知状态").rawStatus, "某种未知状态");
});

test("scan + import + reconcile + dual-read + rollback round trip (memory store, fs objects)", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vault-import-test-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const { worktree } = await makeFixtureRoot(tempRoot);
  const scan = await scanAll({ sources: [path.join(tempRoot, worktree)], log: () => {} });
  assert.equal(scan.counters.packages, 2);
  assert.equal(scan.counters.files, 5);
  assert.equal(scan.counters.uniqueLegacyIds, 2);
  assert.deepEqual(
    scan.packages.map((pkg) => pkg.legacyId).sort(),
    ["11223344", "97342253"],
  );

  const config = { migrationsDir: MIGRATIONS_DIR, devSeed: false, devProjects: [], devTokens: [], dataDir: tempRoot };
  const store = new MemoryVaultStore(config, silent);
  await store.init();
  await store.ensureProject("demo-project_test", "demo-project_test");
  const objectStore = new FsObjectStore({ root: path.join(tempRoot, "objects") });
  await objectStore.init();

  const run = await store.createMigrationRun({ projectId: "demo-project_test", kind: "bug-package-import", source: "test", mode: "execute", status: "running" });
  const result = await executeImport({ store, objectStore, projectId: "demo-project_test", scanResult: scan, runId: run.id, logger: silent, progressEvery: 0 });
  assert.equal(result.counters.imported, 2);
  assert.equal(result.counters.failed, 0);
  assert.equal(result.counters.files, 5);
  assert.equal(result.counters.bugsCreated, 2);

  const recon = await reconcile({ store, projectId: "demo-project_test", scanResult: scan });
  assert.equal(recon.ok, true, JSON.stringify(recon.counters));
  assert.equal(recon.counters.packages.deltaReports, 0);
  assert.equal(recon.counters.files.deltaReportFiles, 0);
  assert.equal(recon.counters.bytes.deltaReportFiles, 0);
  assert.equal(recon.counters.legacyIds.delta, 0);

  const dual = await dualRead({ store, projectId: "demo-project_test", packages: scan.packages, sample: 10 });
  assert.equal(dual.ok, true);
  assert.equal(dual.mismatches, 0);
  assert.equal(dual.checks.length, 2);
  for (const check of dual.checks) {
    assert.equal(check.contentSha256Match, true);
    assert.deepEqual(check.missingFiles, []);
  }

  // idempotency: second import must skip everything and not change counters
  const second = await executeImport({ store, objectStore, projectId: "demo-project_test", scanResult: scan, runId: run.id, logger: silent, progressEvery: 0 });
  assert.equal(second.counters.imported, 0);
  assert.equal(second.counters.skipped, 2);
  const reconAfter = await reconcile({ store, projectId: "demo-project_test", scanResult: scan });
  assert.equal(reconAfter.ok, true);

  // blob dedupe: object files exist and blob rows have refcounts equal to file references
  const blobsBefore = await store.blobStats();
  assert.equal(blobsBefore.blobs, 5);

  // rollback (drill): everything created by the run is removed and counters drop to zero
  const rolledBack = await rollbackRun({ store, objectStore, projectId: "demo-project_test", runId: run.id, purgeBugs: true, logger: silent });
  assert.equal(rolledBack.reportsDeleted, 2);
  assert.equal(rolledBack.filesDeleted, 5);
  assert.equal(rolledBack.linksDeleted, 2);
  assert.equal(rolledBack.jobsDeleted, 2);
  assert.equal(rolledBack.bugsDeleted, 2);
  const after = await store.reportCounters("demo-project_test", "bug-package");
  assert.deepEqual(after, { reports: 0, files: 0, bytes: 0 });
  assert.deepEqual(await store.bugCounters("demo-project_test"), { bugs: 0, uniqueLegacyIds: 0 });
  const blobsAfter = await store.blobStats();
  assert.equal(blobsAfter.blobs, 0);
  assert.equal(blobsAfter.refs, 0);
  const runAfter = await store.getMigrationRun(run.id);
  assert.equal(runAfter.status, "rolled_back");
  await store.close();
});

test("blob refcount dedupes identical files across packages", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vault-dedupe-test-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const worktree = "demo-project_test";
  const bugsRoot = path.join(tempRoot, worktree, "game", "reports", "bugs");
  for (const name of ["bug-20260101-000000-1", "bug-20260101-000000-2"]) {
    const dir = path.join(bugsRoot, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "Readme.md"), "ID: " + (name.endsWith("1") ? "10000001" : "10000002") + "\n标题: dup\n");
    await fs.writeFile(path.join(dir, "same.log"), "identical-content");
  }
  const scan = await scanAll({ sources: [path.join(tempRoot, worktree)], log: () => {} });
  const config = { migrationsDir: MIGRATIONS_DIR, devSeed: false, devProjects: [], devTokens: [], dataDir: tempRoot };
  const store = new MemoryVaultStore(config, silent);
  await store.init();
  await store.ensureProject("p", "p");
  const objectStore = new FsObjectStore({ root: path.join(tempRoot, "objects") });
  await objectStore.init();
  const run = await store.createMigrationRun({ projectId: "p", kind: "test", source: "test", mode: "execute", status: "running" });
  await executeImport({ store, objectStore, projectId: "p", scanResult: scan, runId: run.id, logger: silent, progressEvery: 0 });
  const stats = await store.blobStats();
  assert.equal(stats.blobs, 3, "2 readmes + 1 deduplicated log");
  assert.equal(stats.refs, 4);
  await store.close();
});
