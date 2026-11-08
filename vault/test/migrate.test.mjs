import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { migrationStatus, partitionPlan, readMigrations, splitStatements } from "../src/store/migrate.mjs";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

test("splitStatements handles DDL, comments, strings and dollar-quoted blocks", () => {
  const sql = [
    "-- a comment; with semicolon",
    "CREATE TABLE a (id text);",
    "INSERT INTO a VALUES ('semi;colon');",
    "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;",
    "/* block; comment */",
    "CREATE INDEX IF NOT EXISTS a_idx ON a (id);",
  ].join("\n");
  const statements = splitStatements(sql);
  assert.equal(statements.length, 4);
  assert.match(statements[1], /'semi;colon'/);
  assert.match(statements[2], /^DO \$\$ BEGIN PERFORM 1; PERFORM 2; END \$\$$/);
});

test("migration files are ordered, checksummed and cover the initial schema", async () => {
  const migrations = await readMigrations(MIGRATIONS_DIR);
  assert.ok(migrations.length >= 5, "expected at least 5 migration files");
  assert.deepEqual(
    migrations.map((migration) => migration.version),
    [...migrations.map((migration) => migration.version)].sort(),
  );
  const allSql = migrations.map((migration) => migration.sql).join("\n");
  for (const table of [
    "schema_migrations",
    "projects",
    "tokens",
    "bugs",
    "bug_legacy_index",
    "reports",
    "report_files",
    "report_links",
    "blobs",
    "test_runs",
    "test_run_steps",
    "ingest_jobs",
    "audit_events",
  ]) {
    assert.match(allSql, new RegExp("CREATE TABLE IF NOT EXISTS " + table + "\\b"), "missing table " + table);
  }
  assert.match(allSql, /PARTITION BY RANGE \(created_at\)/);
  assert.match(allSql, /UNIQUE \(project_id, source_path, content_sha256, kind\)/);
  for (const migration of migrations) {
    assert.match(migration.checksum, /^[0-9a-f]{64}$/);
    assert.ok(migration.statements.length > 0);
  }
});

test("partitionPlan produces monthly partitions for all partitioned parents", () => {
  const plan = partitionPlan({ fromMonths: 0, toMonths: 2, now: new Date("2026-11-15T00:00:00Z") });
  const tables = new Set(plan.map((item) => item.table));
  assert.deepEqual([...tables].sort(), ["audit_events", "bugs", "reports", "test_runs"]);
  const bugPartitions = plan.filter((item) => item.table === "bugs").map((item) => item.partition);
  assert.deepEqual(bugPartitions, ["bugs_202611", "bugs_202612", "bugs_202701"]);
  assert.match(plan.find((item) => item.partition === "bugs_202611").sql, /FOR VALUES FROM \('2026-11-01'\) TO \('2026-12-01'\)/);
});

test("in-memory store reports migration files as applied", async () => {
  const { MemoryVaultStore } = await import("../src/store/memory.mjs");
  const config = { migrationsDir: MIGRATIONS_DIR, devSeed: false, devProjects: [], devTokens: [] };
  const store = new MemoryVaultStore(config, { info() {}, warn() {} });
  await store.init();
  const status = await store.migrationStatus();
  const files = await readMigrations(MIGRATIONS_DIR);
  assert.equal(status.pending.length, 0);
  assert.equal(status.applied.length, files.length);
  assert.equal(status.latest, files[files.length - 1].version);
  await store.close();
});
