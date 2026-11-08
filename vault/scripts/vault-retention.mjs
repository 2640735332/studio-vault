#!/usr/bin/env node
// Vault retention / archive job (docs/DATABASE.md §lifecycle).
//
//   node scripts/vault-retention.mjs                        # dry-run (default): counts only
//   node scripts/vault-retention.mjs --apply                # execute the policy
//   node scripts/vault-retention.mjs --apply --project p    # scope to one project
//   node scripts/vault-retention.mjs --report retention.json --json
//
// Policy (defaults, all overridable):
//   - reports older than 365d  -> storage_tier = 'cold' (archive, still queryable)
//   - reports older than 730d  -> soft delete (deleted_at) unless linked to an OPEN bug
//   - audit_events older than 180d -> delete (monthly partitions older than cutoff are dropped)
//   - ingest_jobs (succeeded/failed) older than 90d -> delete
//   - blobs with refcount <= 0 older than 24h -> delete object + row (garbage collection)
//
// Safety: dry-run by default; --apply prints the same JSON with an "actions" section.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/lib/config.mjs";
import { createLogger } from "../src/lib/log.mjs";
import { openStore } from "../src/store/index.mjs";
import { createObjectStore } from "../src/store/objects.mjs";

function parseArgs(argv) {
  const args = {
    apply: false,
    project: null,
    report: null,
    json: false,
    reportArchiveDays: 365,
    reportRetainDays: 730,
    auditDays: 180,
    ingestDays: 90,
    blobGraceHours: 24,
    maxBlobDeletes: 1000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--project") args.project = argv[++i];
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (arg === "--report-archive-days") args.reportArchiveDays = Number(argv[++i]);
    else if (arg === "--report-retain-days") args.reportRetainDays = Number(argv[++i]);
    else if (arg === "--audit-days") args.auditDays = Number(argv[++i]);
    else if (arg === "--ingest-days") args.ingestDays = Number(argv[++i]);
    else if (arg === "--blob-grace-hours") args.blobGraceHours = Number(argv[++i]);
    else if (arg === "--max-blob-deletes") args.maxBlobDeletes = Number(argv[++i]);
    else throw new Error("unknown argument: " + arg);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = createLogger({ level: "warn", name: "vault-retention" });
  const store = await openStore(config, { logger: log });
  const options = {
    projectId: args.project,
    reportArchiveDays: args.reportArchiveDays,
    reportRetainDays: args.reportRetainDays,
    auditDays: args.auditDays,
    ingestDays: args.ingestDays,
    blobGraceHours: args.blobGraceHours,
  };
  const result = {
    command: "vault-retention",
    mode: args.apply ? "apply" : "dry-run",
    generatedAt: new Date().toISOString(),
    driver: config.driver,
    objectStore: config.objectStore,
    options,
    candidates: null,
    actions: null,
  };
  try {
    result.candidates = await store.retentionCandidates(options);
    if (args.apply) {
      const objectStore = await createObjectStore(config);
      const audit = await store.applyExpireAudit(options);
      const actions = {
        archivedReports: await store.applyArchiveReports(options),
        expiredReports: await store.applyExpireReports(options),
        expiredAuditEvents: audit.deletedRows,
        droppedAuditPartitions: audit.droppedPartitions,
        deletedIngestJobs: await store.applyExpireIngestJobs(options),
        garbageBlobs: { deletedObjects: 0, deletedRows: 0, errors: [] },
      };
      const garbage = await store.listGarbageBlobs({ ...options, limit: args.maxBlobDeletes });
      for (const blob of garbage) {
        try {
          await objectStore.delete(blob.sha256);
          if (await store.deleteBlobRow(blob.sha256)) actions.garbageBlobs.deletedRows += 1;
          actions.garbageBlobs.deletedObjects += 1;
        } catch (error) {
          actions.garbageBlobs.errors.push({ sha256: blob.sha256, error: String(error && error.message ? error.message : error) });
        }
      }
      result.actions = actions;
    }
    const text = JSON.stringify(result, null, 2) + "\n";
    if (args.report) {
      await fs.mkdir(path.dirname(path.resolve(args.report)), { recursive: true });
      await fs.writeFile(args.report, text);
    }
    process.stdout.write(text);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write("vault-retention failed: " + String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
