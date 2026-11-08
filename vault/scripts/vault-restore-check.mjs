#!/usr/bin/env node
// Vault restore drill: restore a logical snapshot into a fresh destination and verify it.
//
//   node scripts/vault-restore-check.mjs --snapshot <path/to/snapshot.json> [--target memory|pg]
//        [--database vault_restore_<stamp>] [--keep] [--sample 10] [--report <file>] [--json]
//
// For PG targets a throw-away database is created (schema applied via migrations), the snapshot
// is imported and every table is compared (counts + canonical content hash; the first N rows per
// table are reported as the spot-check sample). Run a periodic 10-record restore drill.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/lib/config.mjs";
import { createLogger } from "../src/lib/log.mjs";
import { PgConnection } from "../src/lib/pgwire.mjs";
import { MemoryVaultStore } from "../src/store/memory.mjs";
import { PgVaultStore } from "../src/store/pg.mjs";
import { SNAPSHOT_TABLES } from "../src/store/pg.mjs";

function parseArgs(argv) {
  const args = { snapshot: null, target: null, database: null, keep: false, sample: 10, report: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--snapshot") args.snapshot = argv[++i];
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--database") args.database = argv[++i];
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--sample") args.sample = Number(argv[++i]);
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--json") args.json = true;
    else throw new Error("unknown argument: " + arg);
  }
  if (!args.snapshot) throw new Error("--snapshot is required");
  return args;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function canonicalTableHash(rows) {
  const items = rows.map((row) => JSON.stringify(row)).sort();
  return sha256(Buffer.from(items.join("\n"), "utf8"));
}

async function createDatabase(config, database) {
  const conn = await PgConnection.connect({ ...config.pg, database: "postgres", applicationName: "vault-restore-check" });
  try {
    await conn.query('DROP DATABASE IF EXISTS "' + database.replace(/"/g, '""') + '"');
    await conn.query('CREATE DATABASE "' + database.replace(/"/g, '""') + '"');
  } finally {
    await conn.end();
  }
}

async function dropDatabase(config, database) {
  const conn = await PgConnection.connect({ ...config.pg, database: "postgres", applicationName: "vault-restore-check" });
  try {
    await conn.query('DROP DATABASE IF EXISTS "' + database.replace(/"/g, '""') + '"');
  } finally {
    await conn.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = createLogger({ level: "warn", name: "vault-restore-check" });
  const snapshotText = await fs.readFile(args.snapshot, "utf8");
  const snapshot = JSON.parse(snapshotText);
  const targetKind = args.target || (snapshot.driver === "pg" ? "pg" : "memory");
  const result = {
    command: "vault-restore-check",
    ok: false,
    generatedAt: new Date().toISOString(),
    snapshot: path.basename(args.snapshot),
    snapshotSha256: sha256(Buffer.from(snapshotText)),
    sourceDriver: snapshot.driver,
    targetDriver: targetKind,
    checks: [],
    samples: [],
  };
  const cleanup = [];
  let target;
  try {
    if (targetKind === "pg") {
      if (snapshot.driver !== "pg") throw new Error("cannot restore a memory snapshot into PostgreSQL (driver-specific logical format)");
      const database = args.database || "vault_restore_" + Date.now();
      await createDatabase(config, database);
      cleanup.push(() => dropDatabase(config, database));
      target = new PgVaultStore({ ...config, pg: { ...config.pg, database }, migrateOnStart: true, devSeed: false }, log);
      await target.init();
      result.target = { driver: "pg", database };
      const migrationStatus = target.lastMigrationStatus;
      result.checks.push({ id: "schema", ok: Boolean(migrationStatus && migrationStatus.pending.length === 0), detail: migrationStatus ? migrationStatus.applied.length + " migrations applied" : "unknown" });
    } else {
      target = new MemoryVaultStore({ ...config, migrateOnStart: true, devSeed: false }, log);
      await target.init();
      result.target = { driver: "memory", database: "(memory)" };
    }
    const imported = await target.importSnapshot(snapshot);
    result.imported = imported;
    const targetCounts = await target.tableCounts();
    result.counts = { source: {}, target: targetCounts };
    for (const table of SNAPSHOT_TABLES) {
      const sourceRows = snapshot.tables?.[table] || [];
      result.counts.source[table] = sourceRows.length;
    }
    for (const table of SNAPSHOT_TABLES) {
      const sourceRows = snapshot.tables?.[table] || [];
      const check = {
        id: "table:" + table,
        ok: result.counts.source[table] === targetCounts[table],
        source: result.counts.source[table],
        target: targetCounts[table],
      };
      result.checks.push(check);
    }
    const targetSnapshot = await target.exportSnapshot({ includeAudit: true });
    for (const table of SNAPSHOT_TABLES) {
      const sourceRows = snapshot.tables?.[table] || [];
      const restoredRows = targetSnapshot.tables?.[table] || [];
      const sourceHash = canonicalTableHash(sourceRows);
      const restoredHash = canonicalTableHash(restoredRows);
      const ok = sourceRows.length === restoredRows.length && sourceHash === restoredHash;
      result.checks.push({ id: "content:" + table, ok, sourceHash, restoredHash });
      const sampleSize = Math.min(Math.max(Number(args.sample) || 0, 0), sourceRows.length, 10);
      for (let i = 0; i < sampleSize; i += 1) {
        const row = sourceRows[i];
        const rowHash = sha256(Buffer.from(JSON.stringify(row), "utf8"));
        result.samples.push({ table, index: i, sha256: rowHash, matched: restoredHash === sourceHash });
      }
    }
    result.ok = result.checks.every((check) => check.ok);
    result.summary = {
      tables: SNAPSHOT_TABLES.length,
      checks: result.checks.length,
      failed: result.checks.filter((check) => !check.ok).length,
      sampledRows: result.samples.length,
    };
  } finally {
    if (target && target.close) await target.close();
    if (!args.keep) for (const fn of cleanup) await fn();
  }
  const text = JSON.stringify(result, null, 2) + "\n";
  if (args.report) {
    await fs.mkdir(path.dirname(args.report), { recursive: true });
    await fs.writeFile(args.report, text);
  }
  if (args.json || true) process.stdout.write(text);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write("vault-restore-check failed: " + String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
