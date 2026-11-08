#!/usr/bin/env node
// Gray dual-read: local (read-only) package tree vs Vault authoritative copy, per-file sha256.
//   node scripts/vault-dual-read.mjs --sample 10 [--report <path>] [--project demo-project]
// Exit code 0 = sampled packages identical; 1 = mismatch list (cutover step 4 gate).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/lib/config.mjs";
import { createLogger } from "../src/lib/log.mjs";
import { openStore } from "../src/store/index.mjs";
import { dualRead } from "../src/import/reconcile.mjs";
import { scanAll } from "../src/import/scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, "..", "..", "..");

function parseArgs(argv) {
  const args = { includeExternalWorktrees: false,  project: "demo-project", repo: DEFAULT_REPO_ROOT, sources: [], sample: 10, offset: 0, report: null, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") args.project = argv[++i];
    else if (arg === "--repo") args.repo = path.resolve(argv[++i]);
    else if (arg === "--source") args.sources.push(path.resolve(argv[++i]));
    else if (arg === "--sample") args.sample = Number(argv[++i]);
    else if (arg === "--offset") args.offset = Number(argv[++i]);
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else throw new Error("unknown argument: " + arg);
  }
  return args;
}

function sanitize(value, repoRoot) {
  let text = JSON.stringify(value, null, 2);
  for (const variant of [repoRoot, repoRoot.replaceAll("\\", "/"), JSON.stringify(repoRoot).slice(1, -1)]) if (variant) text = text.split(variant).join("<repoRoot>");
  return text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const log = createLogger({ level: "warn", name: "vault-dual-read" });
  const store = await openStore(config, { logger: log });
  try {
    const scan = await scanAll({ repoRoot: args.repo, sources: args.sources, limit: args.limit, includeExternalWorktrees: args.includeExternalWorktrees, log: () => {} });
    const packages = scan.packages.slice(args.offset, args.offset + args.sample);
    const result = await dualRead({ store, projectId: args.project, packages, sample: args.sample });
    const output = {
      command: "vault-dual-read",
      generatedAt: new Date().toISOString(),
      project: args.project,
      mode: "local-readonly-vs-vault-authoritative",
      sources: scan.discovered.map((source) => ({ worktree: source.worktreeName, packages: source.packages })),
      ...result,
    };
    const text = sanitize(output, args.repo);
    if (args.report) await fs.writeFile(args.report, text + "\n");
    process.stdout.write(text + "\n");
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write("vault-dual-read failed: " + String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
