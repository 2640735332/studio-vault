#!/usr/bin/env node
// Vault project status snapshot (counters used by the cutover runbook + rollback drill evidence).
//   node scripts/vault-status.mjs [--project demo-project] [--report <path>] [--runs 5]
import fs from "node:fs/promises";
import { loadConfig } from "../src/lib/config.mjs";
import { createLogger } from "../src/lib/log.mjs";
import { openStore } from "../src/store/index.mjs";

function parseArgs(argv) {
  const args = { project: "demo-project", report: null, runs: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") args.project = argv[++i];
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--runs") args.runs = Number(argv[++i]);
    else throw new Error("unknown argument: " + arg);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = createLogger({ level: "warn", name: "vault-status" });
  const store = await openStore(config, { logger: log });
  try {
    const reports = await store.reportCounters(args.project, "bug-package");
    const allReports = await store.reportCounters(args.project);
    const bugs = await store.bugCounters(args.project);
    const ingest = await store.ingestCounters(args.project);
    const items = await store.migrationItemSummary(args.project);
    const blobs = await store.blobStats();
    const runs = await store.listMigrationRuns({ projectId: args.project, limit: args.runs });
    const output = {
      command: "vault-status",
      generatedAt: new Date().toISOString(),
      project: args.project,
      driver: config.driver,
      counters: {
        bugPackageReports: reports,
        allReports,
        bugs,
        ingest,
        migrationItems: items,
        blobs,
      },
      runs: runs.map((run) => ({ id: run.id, kind: run.kind, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, counters: run.counters })),
    };
    const text = JSON.stringify(output, null, 2) + "\n";
    if (args.report) await fs.writeFile(args.report, text);
    process.stdout.write(text);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write("vault-status failed: " + String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
