#!/usr/bin/env node
// Vault schema migrations / partition maintenance.
//
//   node scripts/vault-migrate.mjs --status
//   node scripts/vault-migrate.mjs --dry-run
//   node scripts/vault-migrate.mjs            (apply pending migrations)
//   node scripts/vault-migrate.mjs partitions [--from-months -1] [--to-months 6]
//   node scripts/vault-migrate.mjs --create-database   (create the configured database if missing)
//   node scripts/vault-migrate.mjs --recreate-database (DESTRUCTIVE: drop + recreate, then migrate)
//
// Requires VAULT_DB=pg (memory driver has no schema to migrate; it only reports the file list).
import { loadConfig } from "../src/lib/config.mjs";
import { PgClient } from "../src/store/pg-client.mjs";
import { PgConnection } from "../src/lib/pgwire.mjs";
import {
  applyMigrations,
  ensurePartitions,
  listPartitions,
  migrationStatus,
  readMigrations,
} from "../src/store/migrate.mjs";

function parseArgs(argv) {
  const args = { mode: "apply", fromMonths: -1, toMonths: 6, createDatabase: false, recreateDatabase: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--status") args.mode = "status";
    else if (arg === "--dry-run" || arg === "--plan") args.mode = "dry-run";
    else if (arg === "--apply") args.mode = "apply";
    else if (arg === "partitions" || arg === "--partitions") args.mode = "partitions";
    else if (arg === "--create-database") args.createDatabase = true;
    else if (arg === "--recreate-database") args.recreateDatabase = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--from-months") args.fromMonths = Number(argv[++i]);
    else if (arg === "--to-months") args.toMonths = Number(argv[++i]);
    else if (arg.startsWith("--from-months=")) args.fromMonths = Number(arg.split("=")[1]);
    else if (arg.startsWith("--to-months=")) args.toMonths = Number(arg.split("=")[1]);
    else throw new Error("unknown argument: " + arg);
  }
  return args;
}

async function ensureDatabase(config) {
  const connection = { ...config.pg, database: "postgres" };
  const conn = await PgConnection.connect({ ...connection, applicationName: "vault-migrate-create-db" });
  try {
    const exists = await conn.query("SELECT 1 FROM pg_database WHERE datname = '" + String(config.pg.database).replace(/'/g, "''") + "'");
    if (exists.rows.length === 0) {
      await conn.query('CREATE DATABASE "' + String(config.pg.database).replace(/"/g, '""') + '"');
      return { created: true, database: config.pg.database };
    }
    return { created: false, database: config.pg.database };
  } finally {
    await conn.end();
  }
}

async function recreateDatabase(config) {
  const conn = await PgConnection.connect({ ...config.pg, database: "postgres", applicationName: "vault-migrate-recreate-db" });
  try {
    await conn.query('DROP DATABASE IF EXISTS "' + String(config.pg.database).replace(/"/g, '""') + '" WITH (FORCE)');
    await conn.query('CREATE DATABASE "' + String(config.pg.database).replace(/"/g, '""') + '"');
    return true;
  } finally {
    await conn.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const output = { command: "vault-migrate", mode: args.mode, driver: config.driver, database: config.pg.database };
  if (config.driver !== "pg") {
    const files = await readMigrations(config.migrationsDir);
    output.note = "VAULT_DB=memory: migrations are not executed; the in-memory driver reports the migration file set only";
    output.migrations = files.map((file) => ({ version: file.version, checksum: file.checksum, statements: file.statements.length }));
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }
  if (args.recreateDatabase) {
    const recreated = await recreateDatabase(config);
    output.database = { recreated, database: config.pg.database };
  } else if (args.createDatabase) {
    output.database = await ensureDatabase(config);
  }
  const client = new PgClient({ ...config.pg, applicationName: "vault-migrate" });
  try {
    if (args.mode === "status") {
      output.status = await migrationStatus({ client, dir: config.migrationsDir });
    } else if (args.mode === "dry-run") {
      const files = await readMigrations(config.migrationsDir);
      output.plan = files.map((file) => ({ version: file.version, checksum: file.checksum, statements: file.statements.length }));
      output.status = await migrationStatus({ client, dir: config.migrationsDir }).catch((error) => ({ error: String(error.message) }));
    } else if (args.mode === "partitions") {
      output.partitions = await ensurePartitions({
        client,
        fromMonths: args.fromMonths,
        toMonths: args.toMonths,
        log: (message) => process.stderr.write(message + "\n"),
      });
      output.existing = await listPartitions({ client });
    } else {
      output.result = await applyMigrations({
        client,
        dir: config.migrationsDir,
        log: (message) => process.stderr.write(message + "\n"),
      });
      output.partitions = await ensurePartitions({ client, fromMonths: args.fromMonths, toMonths: args.toMonths });
    }
    output.ok = true;
  } finally {
    await client.close();
  }
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write("vault-migrate failed: " + String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});