import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MemoryVaultStore } from "../src/store/memory.mjs";
import { SNAPSHOT_TABLES } from "../src/store/pg.mjs";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const silent = { info() {}, warn() {}, error() {} };
const sha = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");
const config = { migrationsDir: MIGRATIONS_DIR, devSeed: false, devProjects: [], devTokens: [] };

test("logical snapshot round-trips through a fresh store (counts + content hashes)", async () => {
  const source = new MemoryVaultStore(config, silent);
  await source.init();
  await source.ensureProject("demo-project", "demo-project");
  const bug = await source.createBug("demo-project", { legacyId: "12345678", title: "drill", status: "new", severity: "high" }, "token:drill");
  const report = await source.createReport("demo-project", { kind: "e2e", title: "drill", files: [{ path: "a.md", sha256: sha("a"), sizeBytes: 1 }] }, "token:drill");
  await source.createLink("demo-project", { reportId: report.report.id, bugId: bug.bug.id, role: "evidence" });
  await source.appendAudit({ projectId: "demo-project", actor: "token:drill", action: "drill" });
  const snapshot = await source.exportSnapshot();
  const counts = await source.tableCounts();

  const target = new MemoryVaultStore(config, silent);
  await target.init();
  await target.importSnapshot(snapshot);
  const restoredCounts = await target.tableCounts();
  assert.deepEqual(restoredCounts, counts);
  const restoredSnapshot = await target.exportSnapshot();
  for (const table of SNAPSHOT_TABLES) {
    const sourceRows = snapshot.tables[table] || [];
    const restoredRows = restoredSnapshot.tables[table] || [];
    const hash = (rows) => sha(rows.map((row) => JSON.stringify(row)).sort().join("\n"));
    assert.equal(hash(restoredRows), hash(sourceRows), "content mismatch for " + table);
  }
  const bugRow = snapshot.tables.bugs[0];
  assert.equal(bugRow.legacyId, "12345678");
  const reportFiles = snapshot.tables.report_files;
  assert.equal(reportFiles.length, 1);
  assert.equal(reportFiles[0].sha256, sha("a"));
  await source.close();
  await target.close();
});

test("in-memory store export contains the canonical snapshot table set", async () => {
  const store = new MemoryVaultStore(config, silent);
  await store.init();
  const snapshot = await store.exportSnapshot();
  assert.deepEqual(Object.keys(snapshot.tables).sort(), [...SNAPSHOT_TABLES].sort());
  assert.equal(snapshot.schemaVersion, 1);
  await store.close();
});
