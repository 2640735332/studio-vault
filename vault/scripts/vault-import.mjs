#!/usr/bin/env node
// Vault stock migration: import game/reports/bugs packages (bugs + evidence reports) into Vault.
//
//   node scripts/vault-import.mjs --dry-run                       # scan sources, no writes
//   node scripts/vault-import.mjs --report <path>                 # idempotent import (resume = rerun)
//   node scripts/vault-import.mjs --rollback-run <runId> --purge-bugs
//   node scripts/vault-import.mjs --limit 20 --project rollback-drill --report <path>   # drill project
//
// Idempotency: ingest_jobs unique key (project, source_path, content_sha256, kind) + migration_items.
// Rollback: remove the run's reports/files/links/ingest jobs, decrement blob refs, optionally purge bugs.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/lib/config.mjs";
import { createLogger } from "../src/lib/log.mjs";
import { openStore } from "../src/store/index.mjs";
import { createObjectStore } from "../src/store/objects.mjs";
import { executeImport, rollbackRun } from "../src/import/importer.mjs";
import { reconcile } from "../src/import/reconcile.mjs";
import { scanAll } from "../src/import/scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const DEFAULT_REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");

function parseArgs(argv) {
  const args = { includeExternalWorktrees: false,  project: "demo-project", repo: DEFAULT_REPO_ROOT, sources: [], dryRun: false, limit: 0, report: null, mapping: null, rollbackRun: null, purgeBugs: false, json: false, progressEvery: 50, label: null, maxPackages: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") args.project = argv[++i];
    else if (arg === "--repo") args.repo = path.resolve(argv[++i]);
    else if (arg === "--source") args.sources.push(path.resolve(argv[++i]));
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--mapping") args.mapping = argv[++i];
    else if (arg === "--rollback-run") args.rollbackRun = argv[++i];
    else if (arg === "--purge-bugs") args.purgeBugs = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--include-external-worktrees") args.includeExternalWorktrees = true;
    else if (arg === "--progress-every") args.progressEvery = Number(argv[++i]);
    else if (arg === "--label") args.label = argv[++i];
    else throw new Error("unknown argument: " + arg);
  }
  return args;
}

function sanitize(value, repoRoot) {
  let text = JSON.stringify(value, null, 2);
  const variants = [repoRoot, repoRoot.replaceAll("\\", "/"), JSON.stringify(repoRoot).slice(1, -1)];
  for (const variant of variants) if (variant) text = text.split(variant).join("<repoRoot>");
  return text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel === "info" ? "warn" : config.logLevel, name: "vault-import" });
  const store = await openStore(config, { logger: log });
  try {
    if (args.rollbackRun) {
      const objectStore = await createObjectStore(config);
      const result = await rollbackRun({ store, objectStore, projectId: args.project, runId: args.rollbackRun, purgeBugs: args.purgeBugs, logger: log });
      const run = await store.getMigrationRun(args.rollbackRun);
      const output = { command: "vault-import", mode: "rollback", project: args.project, rollback: result, run, generatedAt: new Date().toISOString() };
      const text = sanitize(output, args.repo);
      if (args.report) await fs.writeFile(args.report, text + "\n");
      process.stdout.write(text + "\n");
      return;
    }

    const scan = await scanAll({ repoRoot: args.repo, sources: args.sources, limit: args.limit, includeExternalWorktrees: args.includeExternalWorktrees, log: (message) => process.stderr.write(message + "\n") });
    if (args.dryRun) {
      const output = {
        command: "vault-import",
        mode: "dry-run",
        project: args.project,
        generatedAt: new Date().toISOString(),
        sources: scan.discovered.map((source) => ({ worktree: source.worktreeName, packages: source.packages })),
        counters: scan.counters,
        skippedSources: scan.skippedSources,
      };
      const text = sanitize(output, args.repo);
      if (args.report) await fs.writeFile(args.report, text + "\n");
      process.stdout.write(text + "\n");
      return;
    }

    await store.ensureProject(args.project, args.project);
    const objectStore = await createObjectStore(config);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await store.createMigrationRun({
      id: runId,
      projectId: args.project,
      kind: "bug-package-import",
      source: args.sources.length > 0 ? "explicit:" + args.sources.length + " roots" : "git-worktree-list",
      mode: "execute",
      status: "running",
      notes: { label: args.label, limit: args.limit, objectStore: objectStore.driver, scannedPackages: scan.counters.packages },
    });
    const result = await executeImport({ store, objectStore, projectId: args.project, scanResult: scan, runId, logger: log, progressEvery: args.progressEvery });
    const after = await reconcile({ store, projectId: args.project, scanResult: scan });
    // Per-run item counters (migration_items rows created by THIS run) stay separate from the
    // project-wide summary, which is kept for reconciliation reporting only.
    const runItems = await store.migrationItemCounters(runId);
    const projectItems = await store.migrationItemSummary(args.project);
    const counters = {
      source: scan.counters,
      import: result.counters,
      vault: after.vault,
      migrationItems: runItems,
      projectMigrationItems: projectItems,
      reconcileOk: after.ok,
    };
    await store.finishMigrationRun(runId, {
      status: result.counters.failed === 0 ? "completed" : "completed_with_failures",
      counters,
      notes: { finishedAt: new Date().toISOString(), failures: result.failures.slice(0, 20) },
    });
    const itemList = await store.listMigrationItems(runId);
    const mapping = itemList
      .filter((item) => item.legacyId)
      .map((item) => ({ legacyId: item.legacyId, bugId: item.extra.bugId || null, reportId: item.entityId, sourcePath: item.sourcePath, contentSha256: item.contentSha256 }));
    if (args.mapping) {
      await fs.writeFile(args.mapping, JSON.stringify({ project: args.project, runId, generatedAt: new Date().toISOString(), mappings: mapping }, null, 2) + "\n");
    }
    const output = {
      command: "vault-import",
      mode: "execute",
      project: args.project,
      runId,
      startedAt,
      generatedAt: new Date().toISOString(),
      sources: scan.discovered.map((source) => ({ worktree: source.worktreeName, packages: source.packages })),
      counters,
      reconcile: after,
      failures: result.failures,
      mapping: { count: mapping.length, sample: mapping.slice(0, 5) },
      durationMs: Date.now() - Date.parse(startedAt),
    };
    const text = sanitize(output, args.repo);
    if (args.report) await fs.writeFile(args.report, text + "\n");
    process.stdout.write(text + "\n");
    process.exitCode = after.ok && result.counters.failed === 0 ? 0 : 1;
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write("vault-import failed: " + String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
