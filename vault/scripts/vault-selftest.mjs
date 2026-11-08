#!/usr/bin/env node
// Vault acceptance self-test: starts the service, exercises /api/v1 contract, token scope
// negative matrix, optimistic lock (409), audit trail, then the backup/restore drill.
//
//   node scripts/vault-selftest.mjs                          (memory driver, no evidence files)
//   node scripts/vault-selftest.mjs --driver pg              (needs VAULT_PG_* / VAULT_DB=pg env)
//   node scripts/vault-selftest.mjs --evidence-dir ./evidence --label local-memory
//
// Covers health/metrics, token scope negatives, storage, and the backup/restore drill.
// Evidence files: vault.json + auth.json.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEV_TOKENS, loadConfig } from "../src/lib/config.mjs";
import { MemoryVaultStore } from "../src/store/memory.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const SCRIPT_NAME = "vault-selftest";

function parseArgs(argv) {
  const args = { driver: null, evidenceDir: null, port: 0, label: null, json: false, keepServer: false, skipBackup: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--driver") args.driver = argv[++i];
    else if (arg === "--evidence-dir") args.evidenceDir = argv[++i];
    else if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--label") args.label = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (arg === "--keep-server") args.keepServer = true;
    else if (arg === "--skip-backup") args.skipBackup = true;
    else throw new Error("unknown argument: " + arg);
  }
  return args;
}

function tokenFor(devToken) {
  return "vt_" + devToken.id + "_" + devToken.secret;
}

function maskToken(raw) {
  if (!raw) return null;
  return raw.slice(0, 10) + "***" + raw.slice(-2);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function canonicalTableHash(rows) {
  return sha256Hex(rows.map((row) => JSON.stringify(row)).sort().join("\n"));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("vault server did not become ready within 45s")), 45000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.startsWith("VAULT_READY ")) continue;
        try {
          const ready = JSON.parse(line.slice("VAULT_READY ".length));
          clearTimeout(timer);
          resolve(ready);
          return;
        } catch (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
      }
      buffer = lines[lines.length - 1];
    });
    child.stderr.on("data", (chunk) => {
      buffer += "";
      process.stderr.write("[vault-selftest server] " + chunk.toString());
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("vault server exited before ready (code " + code + ")"));
    });
  });
}

function createHttp(baseUrl) {
  return async function request(method, pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.token) headers.authorization = "Bearer " + options.token;
    let body;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await fetch(baseUrl + pathname, { method, headers, body });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  };
}

function stringifyForEvidence(value, { root, workspace }) {
  let text = JSON.stringify(value, null, 2);
  const substitutions = [];
  if (root) substitutions.push([root, "<vaultPackage>"]);
  if (workspace) substitutions.push([workspace, "<workspaceRoot>"]);
  substitutions.push([os.homedir(), "<home>"]);
  substitutions.push([os.tmpdir(), "<tmp>"]);
  for (const [from, to] of substitutions) {
    // Replace both the native form and the JSON-stringified (double-backslash) form.
    for (const variant of [from, from.replaceAll("\\", "/"), JSON.stringify(from).slice(1, -1)]) {
      if (variant) text = text.split(variant).join(to);
    }
  }
  return text;
}

async function runMemoryBackupDrill(config, log) {
  const source = new MemoryVaultStore({ ...config, driver: "memory", devSeed: false }, log);
  await source.init();
  await source.ensureProject("demo-project", "demo-project");
  const bugResult = await source.createBug("demo-project", { legacyId: "87654321", title: "backup drill bug", status: "new", severity: "medium" }, "token:selftest");
  const reportResult = await source.createReport(
    "demo-project",
    { kind: "e2e", title: "backup drill report", files: [{ path: "run/report.md", sha256: sha256Hex("report body"), sizeBytes: 11 }] },
    "token:selftest",
  );
  await source.createLink("demo-project", { reportId: reportResult.report.id, bugId: bugResult.bug.id, role: "evidence" });
  await source.appendAudit({ projectId: "demo-project", actor: "token:selftest", action: "backup.drill", entity: "bug", entityId: bugResult.bug.id });
  const snapshot = await source.exportSnapshot();
  const sourceCounts = await source.tableCounts();
  const restored = new MemoryVaultStore({ ...config, driver: "memory", devSeed: false }, log);
  await restored.init();
  await restored.importSnapshot(snapshot);
  const restoredCounts = await restored.tableCounts();
  const restoredSnapshot = await restored.exportSnapshot();
  const tableChecks = Object.keys(sourceCounts).map((table) => ({
    table,
    ok: sourceCounts[table] === restoredCounts[table],
    source: sourceCounts[table],
    target: restoredCounts[table],
  }));
  const contentChecks = Object.keys(snapshot.tables).map((table) => ({
    table,
    ok: canonicalTableHash(snapshot.tables[table] || []) === canonicalTableHash(restoredSnapshot.tables[table] || []),
  }));
  await source.close();
  await restored.close();
  return {
    snapshotBytes: JSON.stringify(snapshot).length,
    snapshotSha256: sha256Hex(JSON.stringify(snapshot)),
    tableChecks,
    contentChecks,
    ok: tableChecks.every((check) => check.ok) && contentChecks.every((check) => check.ok),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const driver = args.driver || config.driver;
  if (driver !== "memory" && driver !== "pg") throw new Error("--driver must be memory or pg");
  const evidenceDir = args.evidenceDir ? path.resolve(PACKAGE_ROOT, args.evidenceDir) : null;
  const label = args.label || "local-" + driver;
  const cases = [];
  const startedAt = new Date().toISOString();
  const childEnv = {
    ...process.env,
    VAULT_DB: driver,
    VAULT_BIND: "127.0.0.1",
    VAULT_PORT: String(args.port || 0),
    VAULT_DEV_SEED: "1",
    VAULT_LOG_LEVEL: process.env.VAULT_LOG_LEVEL || "warn",
    VAULT_MIGRATE_ON_START: "1",
  };
  const server = spawn(process.execPath, [path.join(PACKAGE_ROOT, "src", "server.mjs")], {
    cwd: PACKAGE_ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = null;
  const record = (id, description, ok, expected, actual) => {
    cases.push({ id, description, ok: Boolean(ok), expected, actual });
    process.stdout.write((ok ? "PASS " : "FAIL ") + id + " " + description + (ok ? "" : " :: expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(actual)) + "\n");
  };
  try {
    ready = await waitForReady(server);
    const baseUrl = "http://127.0.0.1:" + ready.port;
    const request = createHttp(baseUrl);
    const tokenA = tokenFor(DEV_TOKENS[0]);
    const tokenB = tokenFor(DEV_TOKENS[1]);
    const tokenMulti = tokenFor(DEV_TOKENS[2]);
    const auditEvidence = { scopeMatrix: [], forgedAuthor: [], audit: null };
    // Per-run fixture values: the PG database persists between selftest runs, so 8-digit legacy ids
    // and ingest idempotency keys must be unique per run to keep the run repeatable.
    const runTag = String(Date.now());
    const legacyId = String((Number(runTag) % 90000000) + 10000000);
    const ingestPath = "game/reports/bugs/selftest-" + runTag;
    const ingestKey = sha256Hex("ingest-payload-" + runTag);

    // ── health / metrics ────────────────────────────────────────────────────
    const health = await request("GET", "/api/v1/health");
    record(
      "H-01",
      "GET /api/v1/health -> 200 with version/apiVersion/projects/usage/queue/storage",
      health.status === 200 &&
        health.json &&
        /^[0-9]+\.[0-9]+\.[0-9]+/.test(String(health.json.version)) &&
        health.json.apiVersion === "v1" &&
        health.json.projects && typeof health.json.projects.total === "number" &&
        health.json.usage && typeof health.json.usage.bugs === "number" &&
        health.json.queue && typeof health.json.queue.total === "number" &&
        health.json.storage && health.json.storage.driver === driver,
      "200 {version, apiVersion:v1, projects, usage, queue, storage.driver:" + driver + "}",
      health.json,
    );
    record(
      "H-02",
      "GET /api/v1/health -> migrations applied>=5 pending=0",
      health.json && health.json.migrations && health.json.migrations.applied >= 5 && health.json.migrations.pending === 0,
      "migrations.applied>=5, pending=0",
      health.json && health.json.migrations,
    );
    const metrics = await request("GET", "/api/v1/metrics");
    record(
      "H-03",
      "GET /api/v1/metrics -> 200 Prometheus text with request counters",
      metrics.status === 200 && /vault_http_requests_total/.test(metrics.text) && /vault_process_uptime_seconds/.test(metrics.text),
      "200 text contains vault_http_requests_total / vault_process_uptime_seconds",
      { status: metrics.status, bytes: metrics.text.length },
    );

    // ── auth / scope negative matrix ─────────────────────────────────────────
    const noToken = await request("GET", "/api/v1/projects");
    record("A-01", "no token -> 401", noToken.status === 401, 401, noToken.status);
    auditEvidence.scopeMatrix.push({ case: "A-01", token: "none", project: null, expected: 401, actual: noToken.status, ok: noToken.status === 401 });
    const badToken = await request("GET", "/api/v1/projects", { token: "vt_bad_badtokenbadtoken" });
    record("A-02", "malformed/unknown token -> 401", badToken.status === 401, 401, badToken.status);
    auditEvidence.scopeMatrix.push({ case: "A-02", token: "malformed", project: null, expected: 401, actual: badToken.status, ok: badToken.status === 401 });

    const projectsA = await request("GET", "/api/v1/projects", { token: tokenA });
    const projectIds = (projectsA.json && projectsA.json.items ? projectsA.json.items : []).map((project) => project.id);
    record(
      "A-03",
      "token A lists only its scoped project (demo-project)",
      projectsA.status === 200 && projectIds.length === 1 && projectIds[0] === "demo-project",
      ["demo-project"],
      projectIds,
    );
    auditEvidence.scopeMatrix.push({ case: "A-03", token: maskToken(tokenA), project: "demo-project", expected: 200, actual: projectsA.status, ok: projectsA.status === 200 });

    const crossProject = await request("GET", "/api/v1/projects/demo-b", { token: tokenA });
    record(
      "A-04",
      "token A requests project B /api/v1/projects/demo-b -> 403 project_forbidden",
      crossProject.status === 403 && crossProject.json && crossProject.json.error && crossProject.json.error.code === "project_forbidden",
      403,
      { status: crossProject.status, body: crossProject.json },
    );
    auditEvidence.scopeMatrix.push({ case: "A-04", token: maskToken(tokenA), project: "demo-b", expected: 403, actual: crossProject.status, ok: crossProject.status === 403 });

    const crossBugs = await request("GET", "/api/v1/bugs?project=demo-b", { token: tokenA });
    record("A-05", "token A lists bugs of project B -> 403", crossBugs.status === 403, 403, crossBugs.status);
    auditEvidence.scopeMatrix.push({ case: "A-05", token: maskToken(tokenA), project: "demo-b", expected: 403, actual: crossBugs.status, ok: crossBugs.status === 403 });

    const reverse = await request("GET", "/api/v1/projects/demo-project", { token: tokenB });
    record("A-06", "token B (demo-b) requests project A -> 403", reverse.status === 403, 403, reverse.status);
    auditEvidence.scopeMatrix.push({ case: "A-06", token: maskToken(tokenB), project: "demo-project", expected: 403, actual: reverse.status, ok: reverse.status === 403 });

    const forgedBody = await request("POST", "/api/v1/bugs", { token: tokenA, body: { title: "forged author", author: "someone-else" } });
    record(
      "A-07",
      "client-supplied author in body -> 403 author_forged",
      forgedBody.status === 403 && forgedBody.json && forgedBody.json.error && forgedBody.json.error.code === "author_forged",
      403,
      { status: forgedBody.status, code: forgedBody.json && forgedBody.json.error && forgedBody.json.error.code },
    );
    auditEvidence.forgedAuthor.push({ case: "A-07", channel: "body.author", expected: 403, actual: forgedBody.status, ok: forgedBody.status === 403 });

    const forgedHeader = await request("POST", "/api/v1/bugs", { token: tokenA, headers: { "x-vault-author": "someone-else" }, body: { title: "forged header" } });
    record(
      "A-08",
      "client-supplied X-Vault-Author header -> 403 author_forged",
      forgedHeader.status === 403 && forgedHeader.json && forgedHeader.json.error && forgedHeader.json.error.code === "author_forged",
      403,
      { status: forgedHeader.status, code: forgedHeader.json && forgedHeader.json.error && forgedHeader.json.error.code },
    );
    auditEvidence.forgedAuthor.push({ case: "A-08", channel: "x-vault-author", expected: 403, actual: forgedHeader.status, ok: forgedHeader.status === 403 });

    const deniedAudit = await request("GET", "/api/v1/audit?limit=100", { token: tokenA });
    const auditItems = (deniedAudit.json && deniedAudit.json.items) || [];
    const deniedEvents = auditItems.filter((event) => event.action === "auth.denied");
    record(
      "A-09",
      "audit_events records real caller for denied scope access (auth.denied >= 3)",
      deniedAudit.status === 200 && deniedEvents.length >= 3 && deniedEvents.some((event) => event.actor === "token:dev-a"),
      ">=3 auth.denied events (caller token:dev-a visible; project-scoped denials included)",
      { status: deniedAudit.status, denied: deniedEvents.length, actors: [...new Set(deniedEvents.map((event) => event.actor))] },
    );
    const forgedAudit = auditItems.filter((event) => event.action === "auth.forged_author_rejected");
    record("A-10", "audit_events records rejected forged author (>=2)", forgedAudit.length >= 2, ">=2 auth.forged_author_rejected", { count: forgedAudit.length });
    auditEvidence.audit = {
      totalReturned: auditItems.length,
      denied: deniedEvents.map((event) => ({ actor: event.actor, action: event.action, statusCode: event.statusCode, details: event.details, requestId: event.requestId })),
      forged: forgedAudit.map((event) => ({ actor: event.actor, action: event.action, details: event.details })),
      recentActions: [...new Set(auditItems.map((event) => event.action))].slice(0, 20),
    };

    // ── bugs: create / optimistic lock 409 / legacy lookup / audit ──────────
    const created = await request("POST", "/api/v1/bugs", {
      token: tokenA,
      body: {
        legacyId,
        title: "selftest bug",
        status: "new",
        severity: "high",
        branch: "feat/game-001",
        payload: { source: "vault-selftest", seed: 1 },
      },
    });
    const bug = created.json && created.json.bug;
    record(
      "P-01",
      "POST /api/v1/bugs -> 201 (project derived from token, author derived from token)",
      created.status === 201 && bug && bug.version === 1 && bug.projectId === "demo-project" && bug.author === "token:dev-a",
      "201 {version:1, projectId:demo-project, author:token:dev-a}",
      bug ? { status: created.status, version: bug.version, projectId: bug.projectId, author: bug.author } : created.json,
    );
    const patched = await request("PATCH", "/api/v1/bugs/" + (bug ? bug.id : "missing"), { token: tokenA, body: { status: "triaged", severity: "blocker", ifVersion: 1 } });
    record(
      "P-02",
      "PATCH /api/v1/bugs/:id with ifVersion=1 -> 200 version 2",
      patched.status === 200 && patched.json && patched.json.bug && patched.json.bug.version === 2 && patched.json.bug.status === "triaged",
      "200 {version:2, status:triaged}",
      patched.json && patched.json.bug ? { status: patched.status, version: patched.json.bug.version, bugStatus: patched.json.bug.status } : patched.json,
    );
    const stale = await request("PATCH", "/api/v1/bugs/" + (bug ? bug.id : "missing"), { token: tokenA, body: { status: "closed", ifVersion: 1 } });
    record(
      "P-03",
      "PATCH with stale ifVersion=1 -> 409 version_conflict (optimistic lock)",
      stale.status === 409 && stale.json && stale.json.error && stale.json.error.code === "version_conflict" && stale.json.error.current && stale.json.error.current.version === 2,
      "409 {code:version_conflict, current.version:2}",
      { status: stale.status, body: stale.json },
    );
    const byLegacy = await request("GET", "/api/v1/bugs/by-legacy/" + legacyId, { token: tokenA });
    record(
      "P-04",
      "GET /api/v1/bugs/by-legacy/:legacyId -> 200 same bug",
      byLegacy.status === 200 && byLegacy.json && byLegacy.json.bug && byLegacy.json.bug.id === (bug && bug.id),
      "200 {bug.id == created id}",
      byLegacy.json && byLegacy.json.bug ? byLegacy.json.bug.id : byLegacy.json,
    );

    const report = await request("POST", "/api/v1/reports", {
      token: tokenA,
      body: {
        kind: "e2e",
        title: "selftest report",
        files: [{ path: "run/report.md", sha256: sha256Hex("report body"), sizeBytes: 11, role: "evidence" }],
      },
    });
    record(
      "P-05",
      "POST /api/v1/reports -> 201 with file manifest (sha256)",
      report.status === 201 && report.json && report.json.report && report.json.files && report.json.files.length === 1 && report.json.files[0].sha256 === sha256Hex("report body"),
      "201 {report, files[1].sha256 matches}",
      report.json && report.json.report ? { status: report.status, reportId: report.json.report.id, files: (report.json.files || []).length } : report.json,
    );
    const reportId = report.json && report.json.report && report.json.report.id;
    const link = await request("POST", "/api/v1/links", { token: tokenA, body: { reportId, bugId: bug && bug.id, role: "evidence" } });
    const links = await request("GET", "/api/v1/links?bug_id=" + (bug ? bug.id : "missing"), { token: tokenA });
    record(
      "P-06",
      "POST /api/v1/links -> 201 and GET /api/v1/links?bug_id lists it (report_links only)",
      link.status === 201 && links.status === 200 && links.json && links.json.total === 1,
      "201 + links.total=1",
      { create: link.status, list: links.json && links.json.total },
    );
    const ingest1 = await request("POST", "/api/v1/ingest", { token: tokenA, body: { sourcePath: ingestPath, contentSha256: ingestKey, kind: "bug" } });
    const ingest2 = await request("POST", "/api/v1/ingest", { token: tokenA, body: { sourcePath: ingestPath, contentSha256: ingestKey, kind: "bug" } });
    record(
      "P-07",
      "POST /api/v1/ingest twice with the same idempotency key -> 201 then 200 (same job id)",
      ingest1.status === 201 && ingest1.json.created === true && ingest2.status === 200 && ingest2.json.created === false && ingest1.json.job.id === ingest2.json.job.id,
      "201 created=true then 200 created=false, same id",
      { first: ingest1.status, second: ingest2.status, created: [ingest1.json && ingest1.json.created, ingest2.json && ingest2.json.created] },
    );
    const finalAudit = await request("GET", "/api/v1/audit?limit=100", { token: tokenA });
    const finalActions = ((finalAudit.json && finalAudit.json.items) || []).map((event) => event.action);
    record(
      "P-08",
      "audit_events contains bug.create / bug.update / report.create / ingest.create",
      ["bug.create", "bug.update", "report.create", "ingest.create"].every((action) => finalActions.includes(action)),
      ["bug.create", "bug.update", "report.create", "ingest.create"],
      [...new Set(finalActions)],
    );

    // ── token admin lifecycle ───────────────────────────────────────────────
    const tokenCreate = await request("POST", "/api/v1/tokens", { token: tokenA, body: { label: "selftest-temp", projects: ["demo-b"], role: "writer" } });
    const tempToken = tokenCreate.json && tokenCreate.json.token;
    const tempScope = tempToken ? await request("GET", "/api/v1/projects", { token: tempToken }) : { status: 0 };
    const tempCross = tempToken ? await request("GET", "/api/v1/projects/demo-project", { token: tempToken }) : { status: 0 };
    const revoke = tokenCreate.json ? await request("DELETE", "/api/v1/tokens/" + tokenCreate.json.id, { token: tokenA }) : { status: 0 };
    const afterRevoke = tempToken ? await request("GET", "/api/v1/projects", { token: tempToken }) : { status: 0 };
    record(
      "T-01",
      "admin creates scoped token -> new token sees only demo-b, cross-project 403, revoke -> 401",
      tokenCreate.status === 201 &&
        tempScope.status === 200 &&
        (tempScope.json.items || []).map((project) => project.id).join() === "demo-b" &&
        tempCross.status === 403 &&
        revoke.status === 200 &&
        afterRevoke.status === 401,
      "201 -> scope[demo-b] -> 403 -> revoke 200 -> 401",
      { create: tokenCreate.status, scope: tempScope.status, cross: tempCross.status, revoke: revoke.status, afterRevoke: afterRevoke.status },
    );
    auditEvidence.tokenLifecycle = {
      create: tokenCreate.status,
      scopedProjects: tempScope.json ? (tempScope.json.items || []).map((project) => project.id) : null,
      crossProject: tempCross.status,
      revoke: revoke.status,
      afterRevoke: afterRevoke.status,
    };

    // ── backup / restore drill ─────────────────────────────────────────────
    let backupEvidence = null;
    if (!args.skipBackup) {
      if (driver === "pg") {
        const backupDir = path.join(os.tmpdir(), "vault-selftest-backup-" + stamp());
        const backup = await runChild([path.join(PACKAGE_ROOT, "scripts", "vault-backup.mjs"), "--out", backupDir, "--label", "selftest", "--pg-dump"], childEnv);
        const backupJson = backup.json;
        record(
          "B-01",
          "vault-backup (logical snapshot + pg_dump attempt) produces manifest with table counts",
          backup.code === 0 && backupJson && backupJson.ok === true && backupJson.tables && backupJson.tables.bugs && backupJson.tables.bugs.rows >= 1,
          "exit 0, ok=true, tables.bugs.rows>=1",
          backupJson ? { exit: backup.code, ok: backupJson.ok, tables: backupJson.tables, pgDump: backupJson.pgDump } : backup.raw.slice(-2000),
        );
        const restore = await runChild(
          [path.join(PACKAGE_ROOT, "scripts", "vault-restore-check.mjs"), "--snapshot", backupJson ? backupJson.snapshotPath : "missing", "--target", "pg", "--sample", "10"],
          childEnv,
        );
        const restoreJson = restore.json;
        record(
          "B-02",
          "vault-restore-check restores snapshot into a fresh database: all tables + content hashes match",
          restore.code === 0 && restoreJson && restoreJson.ok === true && restoreJson.summary && restoreJson.summary.failed === 0,
          "exit 0, ok=true, failed=0",
          restoreJson ? { exit: restore.code, ok: restoreJson.ok, summary: restoreJson.summary, failedChecks: (restoreJson.checks || []).filter((check) => !check.ok) } : restore.raw.slice(-2000),
        );
        const migrateStatus = await runChild([path.join(PACKAGE_ROOT, "scripts", "vault-migrate.mjs"), "--status"], childEnv);
        const migrateJson = migrateStatus.json;
        record(
          "B-03",
          "vault-migrate --status reports applied migrations and no pending",
          migrateStatus.code === 0 && migrateJson && migrateJson.ok === true && migrateJson.status && migrateJson.status.applied.length >= 5 && migrateJson.status.pending.length === 0,
          "ok=true, applied>=5, pending=0",
          migrateJson ? migrateJson.status : migrateStatus.raw.slice(-2000),
        );
        const partitionStatus = await runChild([path.join(PACKAGE_ROOT, "scripts", "vault-migrate.mjs"), "partitions", "--from-months", "-1", "--to-months", "1"], childEnv);
        const partitionJson = partitionStatus.json;
        record(
          "B-04",
          "vault-migrate partitions plans/creates month partitions for bugs/reports/test_runs/audit_events",
          partitionStatus.code === 0 && partitionJson && partitionJson.ok === true && partitionJson.partitions && partitionJson.partitions.planned >= 12 && partitionJson.existing && partitionJson.existing.length >= 4,
          "planned>=12, existing>=4",
          partitionJson ? { planned: partitionJson.partitions.planned, created: partitionJson.partitions.created, existing: (partitionJson.existing || []).length } : partitionStatus.raw.slice(-2000),
        );
        backupEvidence = {
          backup: backupJson ? { ok: backupJson.ok, bytes: backupJson.bytes, tables: backupJson.tables, snapshotSha256: backupJson.snapshotSha256, pgDump: backupJson.pgDump } : { exit: backup.code },
          restore: restoreJson ? { ok: restoreJson.ok, summary: restoreJson.summary, targetDatabase: restoreJson.target } : { exit: restore.code },
          migrate: migrateJson ? migrateJson.status : null,
          partitions: partitionJson ? { planned: partitionJson.partitions ? partitionJson.partitions.planned : null, created: partitionJson.partitions ? partitionJson.partitions.created.length : null, existing: (partitionJson.existing || []).length } : null,
        };
      } else {
        const drill = await runMemoryBackupDrill(
          { ...config, migrationsDir: path.join(PACKAGE_ROOT, "migrations"), devSeed: false },
          { info: () => {}, warn: () => {} },
        );
        record(
          "B-01",
          "memory driver backup/restore drill: snapshot -> fresh store -> counts + content hashes match",
          drill.ok === true,
          "all table counts and content hashes match",
          { tables: drill.tableChecks, content: drill.contentChecks },
        );
        backupEvidence = {
          memoryDrill: {
            ok: drill.ok,
            snapshotBytes: drill.snapshotBytes,
            snapshotSha256: drill.snapshotSha256,
            counts: drill.tableChecks,
            content: drill.contentChecks,
            note: "memory driver has no cross-process storage; the drill runs the backup/restore code paths in-process",
          },
        };
      }
    }

    const pass = cases.filter((entry) => entry.ok).length;
    const fail = cases.length - pass;
    const generatedAt = new Date().toISOString();
    const summary = { total: cases.length, pass, fail };
    if (evidenceDir) {
      await fs.mkdir(evidenceDir, { recursive: true });
      const vaultEvidence = {
        schemaVersion: 1,
        script: SCRIPT_NAME,
        phase: "acceptance",
        label,
        generatedAt,
        startedAt,
        command: "node vault/scripts/vault-selftest.mjs --driver " + driver + (args.evidenceDir ? " --evidence-dir " + args.evidenceDir : ""),
        environment: {
          node: process.version,
          platform: process.platform,
          driver,
          vaultVersion: ready.version,
          apiVersion: ready.apiVersion,
          port: ready.port,
          migrateOnStart: true,
          devSeed: true,
        },
        health: health.json,
        metrics: { status: metrics.status, bytes: metrics.text.length },
        summary,
        cases,
        backup: backupEvidence,
        owner: "vault service",
      };
      const authEvidence = {
        schemaVersion: 1,
        script: SCRIPT_NAME,
        phase: "acceptance",
        label,
        generatedAt,
        checks: ["project isolation (a token for project A requesting project B gets 403)", "token scope negative matrix + forged author + audit trail"],
        cases: cases.filter((entry) => entry.id.startsWith("A-") || entry.id.startsWith("T-")),
        scopeMatrix: auditEvidence.scopeMatrix,
        forgedAuthor: auditEvidence.forgedAuthor,
        tokenLifecycle: auditEvidence.tokenLifecycle,
        audit: auditEvidence.audit,
        summary: {
          total: cases.filter((entry) => entry.id.startsWith("A-") || entry.id.startsWith("T-")).length,
          pass: cases.filter((entry) => (entry.id.startsWith("A-") || entry.id.startsWith("T-")) && entry.ok).length,
          fail: cases.filter((entry) => (entry.id.startsWith("A-") || entry.id.startsWith("T-")) && !entry.ok).length,
        },
      };
      await fs.writeFile(path.join(evidenceDir, "vault.json"), stringifyForEvidence(vaultEvidence, { root: PACKAGE_ROOT }) + "\n");
      await fs.writeFile(path.join(evidenceDir, "auth.json"), stringifyForEvidence(authEvidence, { root: PACKAGE_ROOT }) + "\n");
      const rawLines = cases.map((entry) => (entry.ok ? "PASS " : "FAIL ") + entry.id + " " + entry.description + " :: expected=" + JSON.stringify(entry.expected) + " actual=" + JSON.stringify(entry.actual));
      rawLines.push("SUMMARY pass=" + pass + " fail=" + fail + " driver=" + driver + " generatedAt=" + generatedAt);
      await fs.mkdir(path.join(evidenceDir, "results"), { recursive: true });
      await fs.writeFile(path.join(evidenceDir, "results", "VAULT-SELFTEST." + label + ".raw.txt"), rawLines.join("\n") + "\n");
      process.stdout.write("evidence written: " + path.join(evidenceDir, "vault.json") + ", " + path.join(evidenceDir, "auth.json") + "\n");
    }
    process.stdout.write("SUMMARY " + JSON.stringify(summary) + "\n");
    if (fail > 0) process.exitCode = 1;
  } finally {
    if (!args.keepServer) {
      server.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          server.kill("SIGKILL");
          resolve();
        }, 5000);
        server.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

function runChild(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: PACKAGE_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const raw = stdout + (stderr ? "\n[stderr]\n" + stderr : "");
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      resolve({ code, json, raw, stdout, stderr });
    });
  });
}

main().catch((error) => {
  process.stderr.write("vault-selftest failed: " + String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
