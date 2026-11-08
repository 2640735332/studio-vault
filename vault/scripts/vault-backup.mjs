#!/usr/bin/env node
// Vault backup: logical snapshot (+ optional native pg_dump) with a sha256 manifest.
//
//   node scripts/vault-backup.mjs [--out <dir>] [--label <name>] [--no-audit]
//                                [--pg-dump] [--pg-dump-bin <path>] [--json]
//
// Output layout (default <VAULT_DATA_DIR>/backup):
//   vault-<label>-<stamp>/snapshot.json      logical dump (PG: to_jsonb rows; memory: in-memory tables)
//   vault-<label>-<stamp>/manifest.json      counts + per-file/per-table sha256 + tool/driver metadata
//   vault-<label>-<stamp>/postgres.dump      optional pg_dump custom-format archive
//
// Production backup policy: PostgreSQL daily dump + object-store copy + this logical
// manifest; restore drill = scripts/vault-restore-check.mjs.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../src/lib/config.mjs";
import { createLogger } from "../src/lib/log.mjs";
import { openStore } from "../src/store/index.mjs";

function parseArgs(argv) {
  const args = { out: null, label: null, includeAudit: true, pgDump: false, pgDumpBin: process.env.VAULT_PG_DUMP || "pg_dump", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i];
    else if (arg === "--label") args.label = argv[++i];
    else if (arg === "--no-audit") args.includeAudit = false;
    else if (arg === "--pg-dump") args.pgDump = true;
    else if (arg === "--pg-dump-bin") args.pgDumpBin = argv[++i];
    else if (arg === "--json") args.json = true;
    else throw new Error("unknown argument: " + arg);
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function canonicalTableHash(rows) {
  const items = rows.map((row) => JSON.stringify(row)).sort();
  return sha256(Buffer.from(items.join("\n"), "utf8"));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runPgDump({ bin, config, target }) {
  return new Promise((resolve) => {
    const args = ["--format=custom", "--no-password", "--file", target, "--host", config.pg.host, "--port", String(config.pg.port), "--username", config.pg.user, "--dbname", config.pg.database];
    let child;
    try {
      child = spawn(bin, args, { env: { ...process.env, PGPASSWORD: config.pg.password || "" }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ available: false, error: String(error.message) });
      return;
    }
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ available: false, error: String(error.message) }));
    child.on("close", (code) => resolve({ available: true, exitCode: code, stderr: stderr.slice(-2000) }));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = createLogger({ level: "warn", name: "vault-backup" });
  const store = await openStore(config, { logger: log });
  const outRoot = args.out || path.join(config.dataDir, "backup");
  const label = args.label || "daily";
  const directory = path.join(outRoot, "vault-" + label + "-" + stamp());
  await fs.mkdir(directory, { recursive: true });
  const result = { command: "vault-backup", ok: false, directory, driver: config.driver, createdAt: new Date().toISOString() };
  try {
    const snapshot = await store.exportSnapshot({ includeAudit: args.includeAudit });
    const snapshotText = JSON.stringify(snapshot, null, 1);
    const snapshotPath = path.join(directory, "snapshot.json");
    await fs.writeFile(snapshotPath, snapshotText);
    const tables = {};
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      tables[table] = { rows: rows.length, sha256: canonicalTableHash(rows) };
    }
    const manifest = {
      schemaVersion: 1,
      tool: "vault-backup",
      toolVersion: config.version,
      createdAt: snapshot.generatedAt,
      driver: config.driver,
      database: snapshot.database,
      includeAudit: args.includeAudit,
      files: { snapshot: { name: "snapshot.json", bytes: Buffer.byteLength(snapshotText), sha256: sha256(Buffer.from(snapshotText)) } },
      tables,
      pgDump: null,
    };
    if (args.pgDump) {
      if (config.driver !== "pg") {
        manifest.pgDump = { available: false, note: "VAULT_DB=memory: native pg_dump not applicable" };
      } else {
        const dumpPath = path.join(directory, "postgres.dump");
        const dump = await runPgDump({ bin: args.pgDumpBin, config, target: dumpPath });
        if (dump.available && dump.exitCode === 0) {
          const buffer = await fs.readFile(dumpPath);
          manifest.pgDump = { available: true, name: "postgres.dump", bytes: buffer.length, sha256: sha256(buffer), format: "custom" };
        } else {
          manifest.pgDump = { available: false, bin: args.pgDumpBin, exitCode: dump.exitCode ?? null, error: dump.error || dump.stderr || null };
        }
      }
    }
    const manifestText = JSON.stringify(manifest, null, 2);
    await fs.writeFile(path.join(directory, "manifest.json"), manifestText);
    result.ok = true;
    result.manifestPath = path.join(directory, "manifest.json");
    result.snapshotPath = snapshotPath;
    result.tables = manifest.tables;
    result.bytes = Buffer.byteLength(snapshotText);
    result.pgDump = manifest.pgDump;
    result.snapshotSha256 = manifest.files.snapshot.sha256;
  } finally {
    await store.close();
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write("vault-backup failed: " + String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
