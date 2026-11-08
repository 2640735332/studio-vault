import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Split a SQL script into statements.
 * Understands: line comments (--), block comments, single-quoted strings (including E'' escapes),
 * and dollar-quoted bodies ($$...$$ / $tag$...$tag$). This is intentionally small: Vault
 * migrations are plain DDL with short DO-blocks, not arbitrary PL/pgSQL programs.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  const text = String(sql);
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
      current += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\" && /^[eE]$/.test(text[i - 1] || "")) {
          j += 2;
          continue;
        }
        if (text[j] === "'" && text[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (text[j] === "'") break;
        j += 1;
      }
      current += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = text.indexOf(tag, i + tag.length);
        const stop = end === -1 ? text.length : end + tag.length;
        current += text.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

export async function listMigrationFiles(dir) {
  const entries = await fs.readdir(dir);
  return entries
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ version: name.replace(/\.sql$/, ""), file: name, fullPath: path.join(dir, name) }));
}

export async function readMigrations(dir) {
  const files = await listMigrationFiles(dir);
  const out = [];
  for (const item of files) {
    const sql = await fs.readFile(item.fullPath, "utf8");
    out.push({ ...item, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex"), statements: splitStatements(sql) });
  }
  return out;
}

const LEDGER_DDL =
  "CREATE TABLE IF NOT EXISTS schema_migrations (" +
  "version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), " +
  "execution_ms integer NOT NULL DEFAULT 0)";

async function readLedger(client) {
  const result = await client.query("SELECT version, checksum, applied_at, execution_ms FROM schema_migrations ORDER BY version");
  return result.rows;
}

export async function migrationStatus({ client, dir }) {
  const files = await listMigrationFiles(dir);
  const ledger = await readLedger(client);
  const applied = new Map(ledger.map((row) => [row.version, row]));
  return {
    dir,
    applied: ledger.map((row) => ({
      version: row.version,
      checksum: row.checksum,
      appliedAt: row.applied_at,
      executionMs: Number(row.execution_ms || 0),
    })),
    pending: files.filter((file) => !applied.has(file.version)).map((file) => file.version),
    latest: ledger.length ? ledger[ledger.length - 1].version : null,
  };
}

/**
 * Apply pending migrations in filename order. Each migration is applied in its own transaction
 * together with its ledger row, so a failed migration leaves no partial schema behind.
 * Checksum drift on an already-applied migration is a hard error (expand/contract discipline).
 */
export async function applyMigrations({ client, dir, log = () => {} }) {
  await client.query(LEDGER_DDL);
  const files = await readMigrations(dir);
  const ledger = await readLedger(client);
  const applied = new Map(ledger.map((row) => [row.version, row]));
  const appliedNow = [];
  for (const file of files) {
    const existing = applied.get(file.version);
    if (existing) {
      if (existing.checksum !== file.checksum) {
        throw new Error(
          "migration checksum drift for " + file.version + ": applied=" + existing.checksum + " on-disk=" + file.checksum,
        );
      }
      continue;
    }
    const started = Date.now();
    await client.transaction(async (query) => {
      for (const statement of file.statements) await query(statement);
      await query(
        "INSERT INTO schema_migrations (version, checksum, execution_ms) VALUES (" +
          "'" + file.version.replace(/'/g, "''") + "', '" + file.checksum + "', " + (Date.now() - started) + ")",
      );
    });
    const elapsed = Date.now() - started;
    appliedNow.push({ version: file.version, statements: file.statements.length, executionMs: elapsed });
    log("applied migration " + file.version + " (" + file.statements.length + " statements, " + elapsed + "ms)");
  }
  return { applied: appliedNow, status: await migrationStatus({ client, dir }) };
}

/**
 * Monthly partition plan. Vault parents declare PARTITION BY RANGE on a timestamp column and
 * carry a DEFAULT partition so ingestion never fails on a missing month; this helper adds the
 * explicit month partitions used for retention/archival (hot: recent months).
 */
export const PARTITIONED_TABLES = [
  { table: "bugs", column: "created_at" },
  { table: "reports", column: "created_at" },
  { table: "test_runs", column: "started_at" },
  { table: "audit_events", column: "created_at" },
];

function monthBounds(base, offsetMonths) {
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offsetMonths, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end, suffix: String(start.getUTCFullYear()) + String(start.getUTCMonth() + 1).padStart(2, "0") };
}

export function partitionPlan({ fromMonths = -1, toMonths = 6, now = new Date() } = {}) {
  const plan = [];
  for (const entry of PARTITIONED_TABLES) {
    for (let offset = fromMonths; offset <= toMonths; offset += 1) {
      const bounds = monthBounds(now, offset);
      plan.push({
        table: entry.table,
        column: entry.column,
        partition: entry.table + "_" + bounds.suffix,
        from: bounds.start.toISOString().slice(0, 10),
        to: bounds.end.toISOString().slice(0, 10),
        sql:
          "CREATE TABLE IF NOT EXISTS " + entry.table + "_" + bounds.suffix + " PARTITION OF " + entry.table +
          " FOR VALUES FROM ('" + bounds.start.toISOString().slice(0, 10) + "') TO ('" +
          bounds.end.toISOString().slice(0, 10) + "')",
      });
    }
  }
  return plan;
}

export async function ensurePartitions({ client, fromMonths = -1, toMonths = 6, now = new Date(), log = () => {} }) {
  const plan = partitionPlan({ fromMonths, toMonths, now });
  const created = [];
  for (const item of plan) {
    const before = await client.query(
      "SELECT to_regclass('public." + item.partition + "') AS rel",
    );
    const exists = before.rows[0] && before.rows[0].rel;
    if (exists) continue;
    await client.query(item.sql);
    created.push(item.partition);
    log("created partition " + item.partition + " [" + item.from + ", " + item.to + ")");
  }
  return { planned: plan.length, created };
}

export async function listPartitions({ client }) {
  const result = await client.query(
    "SELECT c.relname AS partition, p.relname AS parent FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class p ON p.oid = i.inhparent " +
      "WHERE c.relkind = 'r' ORDER BY p.relname, c.relname",
  );
  return result.rows.map((row) => ({ partition: row.partition, parent: row.parent }));
}
