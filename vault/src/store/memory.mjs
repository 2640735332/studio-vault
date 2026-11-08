import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { sha256Hex, timingSafeEqualHex, uuid } from "../lib/ids.mjs";
import { SNAPSHOT_TABLES } from "./pg.mjs";

const now = () => new Date().toISOString();

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Non-durable in-memory store.
 *
 * Purpose: local development and the acceptance self-test when no PostgreSQL server is
 * reachable (for example on a machine without Docker or psql).
 * It implements the exact same store interface as PgVaultStore so the HTTP layer and tests are
 * exercised identically, but it is explicitly reported as degraded / non-durable by /health.
 */

const OPEN_BUG_STATUSES = new Set(["closed", "fixed", "duplicate", "wontfix", "cannot_reproduce", "false_red"]);

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value === undefined || value === null ? "" : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function retentionCutoffs(options = {}) {
  const daysAgo = (days) => new Date(Date.now() - Number(days) * 86400 * 1000).toISOString();
  const hoursAgo = (hours) => new Date(Date.now() - Number(hours) * 3600 * 1000).toISOString();
  return {
    projectId: options.projectId || null,
    reportArchiveCutoff: daysAgo(options.reportArchiveDays === undefined ? 365 : options.reportArchiveDays),
    reportRetainCutoff: daysAgo(options.reportRetainDays === undefined ? 730 : options.reportRetainDays),
    auditCutoff: daysAgo(options.auditDays === undefined ? 180 : options.auditDays),
    ingestCutoff: daysAgo(options.ingestDays === undefined ? 90 : options.ingestDays),
    blobCutoff: hoursAgo(options.blobGraceHours === undefined ? 24 : options.blobGraceHours),
  };
}

export class MemoryVaultStore {
  driver = "memory";
  durable = false;

  constructor(config, logger) {
    this.config = config;
    this.log = logger || (() => {});
    this.startedAt = now();
    this.projects = new Map();
    this.tokens = new Map();
    this.bugs = new Map();
    this.legacyIndex = new Map();
    this.reports = new Map();
    this.reportFiles = new Map();
    this.links = [];
    this.ingestJobs = new Map();
    this.auditEvents = [];
    this.migrations = [];
    this.blobs = new Map();
    this.migrationRuns = new Map();
    this.migrationItems = [];
  }

  static #legacyKey(projectId, legacyId) {
    return projectId + "\u0000" + legacyId;
  }

  async init() {
    const entries = await fs.readdir(this.config.migrationsDir).catch(() => []);
    const files = entries.filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      const sql = await fs.readFile(path.join(this.config.migrationsDir, file), "utf8");
      this.migrations.push({
        version: file.replace(/\.sql$/, ""),
        checksum: crypto.createHash("sha256").update(sql).digest("hex"),
        appliedAt: this.startedAt,
        executionMs: 0,
      });
    }
    if (this.config.devSeed) {
      for (const projectId of this.config.devProjects) this.ensureProject(projectId, projectId);
      for (const devToken of this.config.devTokens) {
        if (this.tokens.has(devToken.id)) continue;
        this.tokens.set(devToken.id, {
          id: devToken.id,
          label: devToken.label,
          tokenHash: sha256Hex(devToken.secret),
          projects: [...devToken.projects],
          role: devToken.role,
          metadata: { dev: true },
          createdAt: this.startedAt,
          lastUsedAt: null,
          revokedAt: null,
        });
      }
      this.log.info("dev seed ensured (memory)", {
        projects: this.projects.size,
        tokens: this.tokens.size,
        migrations: this.migrations.length,
      });
    }
  }

  async close() {}

  async ping() {
    return { ok: true, latencyMs: 0, serverVersion: "in-memory", database: "(memory)", serverTime: now() };
  }

  async migrationStatus() {
    return {
      dir: this.config.migrationsDir,
      applied: clone(this.migrations),
      pending: [],
      latest: this.migrations.length ? this.migrations[this.migrations.length - 1].version : null,
    };
  }

  async healthCounts() {
    return {
      usage: {
        projects: this.projects.size,
        bugs: [...this.bugs.values()].filter((bug) => !bug.deletedAt).length,
        reports: [...this.reports.values()].filter((report) => !report.deletedAt).length,
        testRuns: 0,
        blobs: 0,
        bytes: 0,
        activeTokens: [...this.tokens.values()].filter((token) => !token.revokedAt).length,
      },
      queue: await this.ingestQueueStats(),
    };
  }

  async listPartitions() {
    return [];
  }

  // ── projects ────────────────────────────────────────────────────────────────
  async ensureProject(id, name) {
    const existing = this.projects.get(id);
    if (existing) {
      existing.name = name || id;
      existing.updatedAt = now();
      return clone(existing);
    }
    const project = {
      id,
      name: name || id,
      description: "registered by vault bootstrap",
      settings: {},
      createdAt: now(),
      updatedAt: now(),
    };
    this.projects.set(id, project);
    return clone(project);
  }

  async getProject(id) {
    return clone(this.projects.get(id) || null);
  }

  async listProjects(projectIds) {
    const scoped = Array.isArray(projectIds) && projectIds.length > 0 ? new Set(projectIds) : null;
    return [...this.projects.values()]
      .filter((project) => (scoped ? scoped.has(project.id) : true))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
  }

  // ── tokens ──────────────────────────────────────────────────────────────────
  async findToken(id) {
    return clone(this.tokens.get(id) || null);
  }

  async touchToken(id) {
    const token = this.tokens.get(id);
    if (token) token.lastUsedAt = now();
  }

  async verifyToken(id, secret) {
    const token = this.tokens.get(id);
    if (!token) return { ok: false, reason: "unknown_token" };
    if (token.revokedAt) return { ok: false, reason: "revoked_token", token: clone(token) };
    const probe = sha256Hex(secret);
    if (!timingSafeEqualHex(probe, token.tokenHash)) return { ok: false, reason: "invalid_token", token: clone(token) };
    token.lastUsedAt = now();
    return { ok: true, token: clone(token) };
  }

  async createToken(input) {
    const token = {
      id: input.id,
      label: input.label,
      tokenHash: input.tokenHash,
      projects: [...(input.projects || [])],
      role: input.role || "writer",
      metadata: input.metadata || {},
      createdAt: now(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.tokens.set(token.id, token);
    return clone(token);
  }

  async listTokens() {
    return [...this.tokens.values()].map(clone);
  }

  async revokeToken(id) {
    const token = this.tokens.get(id);
    if (!token) return null;
    token.revokedAt = now();
    return clone(token);
  }

  // ── bugs ────────────────────────────────────────────────────────────────────
  async createBug(projectId, input, author) {
    const at = now();
    const bug = {
      id: uuid(),
      projectId,
      legacyId: input.legacyId ?? null,
      title: input.title ?? null,
      status: input.status ?? "new",
      severity: input.severity ?? "medium",
      priority: input.priority ?? null,
      assignee: input.assignee ?? null,
      fingerprint: input.fingerprint ?? null,
      clusterId: input.clusterId ?? null,
      resolution: input.resolution ?? null,
      closedAt: null,
      author,
      updatedBy: author,
      repo: input.repo ?? null,
      branch: input.branch ?? null,
      worktree: input.worktree ?? null,
      commitSha: input.commitSha ?? null,
      sourceTrack: input.sourceTrack ?? null,
      payload: clone(input.payload || {}),
      version: 1,
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    this.bugs.set(bug.id, bug);
    let legacyConflict = null;
    if (bug.legacyId) {
      const key = MemoryVaultStore.#legacyKey(projectId, bug.legacyId);
      const existing = this.legacyIndex.get(key);
      if (existing) {
        legacyConflict = { legacyId: bug.legacyId, existingBugId: existing };
      } else {
        this.legacyIndex.set(key, bug.id);
      }
    }
    return { bug: clone(bug), legacyConflict };
  }

  async listBugs(projectId, filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit ?? 50), 1), 500);
    const offset = Math.max(Number(filter.offset ?? 0), 0);
    const all = [...this.bugs.values()]
      .filter((bug) => bug.projectId === projectId)
      .filter((bug) => (filter.includeDeleted ? true : !bug.deletedAt))
      .filter((bug) => (filter.status ? bug.status === filter.status : true))
      .filter((bug) => (filter.legacyId ? bug.legacyId === filter.legacyId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: all.slice(offset, offset + limit).map(clone), total: all.length, limit, offset };
  }

  async getBug(projectId, id) {
    const bug = this.bugs.get(id);
    if (!bug || bug.projectId !== projectId || bug.deletedAt) return null;
    return clone(bug);
  }

  async getBugByLegacyId(projectId, legacyId) {
    const id = this.legacyIndex.get(MemoryVaultStore.#legacyKey(projectId, legacyId));
    if (!id) return null;
    return this.getBug(projectId, id);
  }

  async updateBug(projectId, id, patch, expectedVersion, author) {
    const bug = this.bugs.get(id);
    if (!bug || bug.projectId !== projectId) return { found: false };
    const before = clone(bug);
    if (expectedVersion !== undefined && expectedVersion !== null && Number(bug.version) !== Number(expectedVersion)) {
      return { conflict: true, current: before };
    }
    const fields = ["title", "status", "severity", "priority", "assignee", "fingerprint", "clusterId", "resolution", "sourceTrack", "repo", "branch", "worktree", "commitSha"];
    for (const field of fields) if (Object.prototype.hasOwnProperty.call(patch, field)) bug[field] = patch[field];
    if (Object.prototype.hasOwnProperty.call(patch, "closedAt")) bug.closedAt = patch.closedAt;
    if (Object.prototype.hasOwnProperty.call(patch, "payload")) bug.payload = clone(patch.payload);
    bug.version = Number(bug.version) + 1;
    bug.updatedAt = now();
    bug.updatedBy = author;
    return { conflict: false, before, bug: clone(bug) };
  }

  // ── reports / links ─────────────────────────────────────────────────────────
  async createReport(projectId, input, author) {
    if (input.ifAbsent && this.reports.has(input.id)) return { conflict: true };
    const at = now();
    const report = {
      id: input.id || uuid(),
      projectId,
      kind: input.kind ?? "report",
      title: input.title ?? null,
      storageTier: input.storageTier ?? "hot",
      restoreStatus: input.restoreStatus ?? "none",
      author,
      payload: clone(input.payload || {}),
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    this.reports.set(report.id, report);
    this.reportFiles.set(report.id, new Map());
    const files = Array.isArray(input.files) ? input.files : [];
    const stored = [];
    for (const file of files) stored.push(await this.addReportFile(report.id, file));
    return { report: clone(report), files: stored };
  }

  async addReportFile(reportId, file) {
    const map = this.reportFiles.get(reportId) || new Map();
    this.reportFiles.set(reportId, map);
    const entry = {
      reportId,
      path: file.path,
      sha256: file.sha256,
      sizeBytes: Number(file.sizeBytes || 0),
      role: file.role ?? null,
      createdAt: now(),
    };
    map.set(file.path, entry);
    return clone(entry);
  }

  async listReportFiles(reportId) {
    const map = this.reportFiles.get(reportId) || new Map();
    return [...map.values()].map(clone);
  }

  async getReport(projectId, id) {
    const report = this.reports.get(id);
    if (!report || report.projectId !== projectId || report.deletedAt) return null;
    return { report: clone(report), files: await this.listReportFiles(id) };
  }

  async listReports(projectId, filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit ?? 50), 1), 500);
    const offset = Math.max(Number(filter.offset ?? 0), 0);
    const all = [...this.reports.values()]
      .filter((report) => report.projectId === projectId && !report.deletedAt)
      .filter((report) => (filter.kind ? report.kind === filter.kind : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: all.slice(offset, offset + limit).map(clone), total: all.length, limit, offset };
  }

  async createLink(projectId, input) {
    const role = input.role ?? "evidence";
    const exists = this.links.some(
      (link) => link.reportId === input.reportId && link.bugId === input.bugId && link.role === role,
    );
    const link = { reportId: input.reportId, bugId: input.bugId, role, createdAt: now() };
    if (!exists) {
      this.links.push(link);
      return { created: true, link: clone(link) };
    }
    return { created: false, link: clone(link) };
  }

  async listLinks(projectId, filter = {}) {
    return this.links
      .filter((link) => (filter.bugId ? link.bugId === filter.bugId : true))
      .filter((link) => (filter.reportId ? link.reportId === filter.reportId : true))
      .map(clone);
  }

  async deleteLink(input) {
    const role = input.role ?? "evidence";
    const index = this.links.findIndex(
      (link) => link.reportId === input.reportId && link.bugId === input.bugId && link.role === role,
    );
    if (index === -1) return false;
    this.links.splice(index, 1);
    return true;
  }

  // ── ingest jobs ─────────────────────────────────────────────────────────────
  async createIngestJob(projectId, input) {
    const key = [projectId, input.sourcePath, input.contentSha256, input.kind ?? "report"].join("\u0000");
    for (const job of this.ingestJobs.values()) {
      if ([job.projectId, job.sourcePath, job.contentSha256, job.kind].join("\u0000") === key) {
        return { created: false, job: clone(job) };
      }
    }
    const at = now();
    const job = {
      id: uuid(),
      projectId,
      kind: input.kind ?? "report",
      sourcePath: input.sourcePath,
      contentSha256: input.contentSha256,
      status: input.status ?? "pending",
      attempts: 0,
      lastError: null,
      reportId: input.reportId ?? null,
      bytesTotal: Number(input.bytesTotal || 0),
      filesTotal: Number(input.filesTotal || 0),
      createdAt: at,
      updatedAt: at,
    };
    this.ingestJobs.set(job.id, job);
    return { created: true, job: clone(job) };
  }

  async getIngestJob(id) {
    return clone(this.ingestJobs.get(id) || null);
  }

  async ingestQueueStats() {
    const counts = { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 };
    for (const job of this.ingestJobs.values()) counts[job.status] = (counts[job.status] || 0) + 1;
    return { ...counts, total: this.ingestJobs.size };
  }

  // ── audit ──────────────────────────────────────────────────────────────────
  async appendAudit(event) {
    const entry = {
      eventId: uuid(),
      projectId: event.projectId ?? null,
      actor: event.actor ?? "anonymous",
      action: event.action,
      entity: event.entity ?? null,
      entityId: event.entityId ?? null,
      outcome: event.outcome ?? "ok",
      statusCode: event.statusCode ?? null,
      before: event.before === undefined ? null : clone(event.before),
      after: event.after === undefined ? null : clone(event.after),
      details: clone(event.details || {}),
      requestId: event.requestId ?? null,
      remoteAddr: event.remoteAddr ?? null,
      createdAt: now(),
    };
    this.auditEvents.push(entry);
    return { eventId: entry.eventId };
  }

  // ── object blobs ────────────────────────────────────────────────────────────
  async upsertBlob(input) {
    const existing = this.blobs.get(input.sha256);
    if (existing) {
      existing.refcount = Number(existing.refcount) + 1;
      return { created: false, refcount: existing.refcount, blob: clone(existing) };
    }
    const blob = {
      sha256: input.sha256,
      sizeBytes: Number(input.sizeBytes || 0),
      bucket: input.bucket || "vault",
      objectKey: input.objectKey || input.sha256,
      refcount: 1,
      storageTier: "hot",
      contentType: input.contentType || null,
      createdAt: now(),
    };
    this.blobs.set(blob.sha256, blob);
    return { created: true, refcount: 1, blob: clone(blob) };
  }

  async getBlob(sha256) {
    return clone(this.blobs.get(sha256) || null);
  }

  async decrementBlobRef(sha256) {
    const blob = this.blobs.get(sha256);
    if (!blob) return { found: false, refcount: 0, removed: false };
    blob.refcount = Number(blob.refcount) - 1;
    if (blob.refcount <= 0) {
      this.blobs.delete(sha256);
      return { found: true, refcount: blob.refcount, removed: true };
    }
    return { found: true, refcount: blob.refcount, removed: false };
  }

  async blobStats() {
    const blobs = [...this.blobs.values()];
    return {
      blobs: blobs.length,
      bytes: blobs.reduce((sum, blob) => sum + Number(blob.sizeBytes || 0), 0),
      refs: blobs.reduce((sum, blob) => sum + Number(blob.refcount || 0), 0),
    };
  }

  // ── migration runs / items ──────────────────────────────────────────────────
  async createMigrationRun(input) {
    const run = {
      id: input.id || uuid(),
      projectId: input.projectId,
      kind: input.kind || "bug-package-import",
      source: input.source,
      mode: input.mode || "execute",
      status: input.status || "running",
      startedAt: now(),
      finishedAt: null,
      counters: {},
      notes: clone(input.notes || {}),
    };
    this.migrationRuns.set(run.id, run);
    return clone(run);
  }

  async finishMigrationRun(id, { status, counters, notes }) {
    const run = this.migrationRuns.get(id);
    if (!run) return null;
    run.status = status || "completed";
    run.counters = clone(counters || {});
    if (notes !== undefined) run.notes = clone(notes);
    run.finishedAt = now();
    return clone(run);
  }

  async getMigrationRun(id) {
    return clone(this.migrationRuns.get(id) || null);
  }

  async listMigrationRuns(filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit ?? 20), 1), 200);
    return [...this.migrationRuns.values()]
      .filter((run) => (filter.projectId ? run.projectId === filter.projectId : true))
      .filter((run) => (filter.status ? run.status === filter.status : true))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map(clone);
  }

  async insertMigrationItem(item) {
    const exists = this.migrationItems.some(
      (entry) => entry.runId === item.runId && entry.kind === item.kind && entry.entityId === item.entityId,
    );
    if (exists) return null;
    const entry = {
      runId: item.runId,
      projectId: item.projectId,
      kind: item.kind,
      entityId: item.entityId,
      sourcePath: item.sourcePath,
      contentSha256: item.contentSha256,
      legacyId: item.legacyId ?? null,
      extra: clone(item.extra || {}),
      createdAt: now(),
    };
    this.migrationItems.push(entry);
    return clone(entry);
  }

  async listMigrationItems(runId) {
    return this.migrationItems.filter((item) => item.runId === runId).map(clone);
  }

  async deleteMigrationItems(runId) {
    const before = this.migrationItems.length;
    this.migrationItems = this.migrationItems.filter((item) => item.runId !== runId);
    return before - this.migrationItems.length;
  }

  async migrationItemCounters(runId) {
    const items = this.migrationItems.filter((item) => item.runId === runId);
    return {
      items: items.length,
      files: items.reduce((sum, item) => sum + Number(item.extra.filesTotal || 0), 0),
      bytes: items.reduce((sum, item) => sum + Number(item.extra.bytesTotal || 0), 0),
    };
  }

  // ── counters used by reconciliation ─────────────────────────────────────────
  async reportCounters(projectId, kind) {
    const reports = [...this.reports.values()].filter(
      (report) => report.projectId === projectId && !report.deletedAt && (kind ? report.kind === kind : true),
    );
    let files = 0;
    let bytes = 0;
    for (const report of reports) {
      const map = this.reportFiles.get(report.id) || new Map();
      for (const file of map.values()) {
        files += 1;
        bytes += Number(file.sizeBytes || file.size_bytes || 0);
      }
    }
    return { reports: reports.length, files, bytes };
  }

  async bugCounters(projectId) {
    const bugs = [...this.bugs.values()].filter((bug) => bug.projectId === projectId && !bug.deletedAt);
    const legacy = new Set(bugs.map((bug) => bug.legacyId).filter((value) => value !== null && value !== undefined));
    return { bugs: bugs.length, uniqueLegacyIds: legacy.size };
  }

  async ingestCounters(projectId) {
    const counters = { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, total: 0, files: 0, bytes: 0 };
    for (const job of this.ingestJobs.values()) {
      if (job.projectId !== projectId) continue;
      counters[job.status] = (counters[job.status] || 0) + 1;
      counters.total += 1;
      counters.files += Number(job.filesTotal || 0);
      counters.bytes += Number(job.bytesTotal || 0);
    }
    return counters;
  }

  async updateIngestJob(id, patch) {
    const job = this.ingestJobs.get(id);
    if (!job) return null;
    if (patch.status !== undefined) job.status = patch.status;
    if (patch.attempts !== undefined) job.attempts = Number(patch.attempts);
    if (patch.lastError !== undefined) job.lastError = patch.lastError;
    if (patch.reportId !== undefined) job.reportId = patch.reportId;
    if (patch.bytesTotal !== undefined) job.bytesTotal = Number(patch.bytesTotal);
    if (patch.filesTotal !== undefined) job.filesTotal = Number(patch.filesTotal);
    job.updatedAt = now();
    return clone(job);
  }

  // ── hard deletes for rollback ──────────────────────────────────────────────
  async deleteReport(projectId, reportId) {
    const report = this.reports.get(reportId);
    if (!report || report.projectId !== projectId) return false;
    this.reports.delete(reportId);
    this.reportFiles.delete(reportId);
    return true;
  }

  async deleteIngestJob(id) {
    return this.ingestJobs.delete(id);
  }

  async deleteBug(projectId, id) {
    const bug = this.bugs.get(id);
    if (!bug || bug.projectId !== projectId) return false;
    this.bugs.delete(id);
    for (const [key, value] of [...this.legacyIndex.entries()]) {
      if (value === id) this.legacyIndex.delete(key);
    }
    return true;
  }

  async findReportBySourcePath(projectId, sourcePath) {
    const match = [...this.reports.values()]
      .filter((report) => report.projectId === projectId && report.kind === "bug-package" && !report.deletedAt)
      .filter((report) => report.payload && report.payload.sourcePath === sourcePath)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return clone(match || null);
  }

  async migrationItemSummary(projectId) {
    const items = this.migrationItems.filter((item) => item.projectId === projectId);
    const legacy = new Set(items.map((item) => item.legacyId).filter((value) => value !== null && value !== undefined));
    return {
      items: items.length,
      legacyIds: legacy.size,
      files: items.reduce((sum, item) => sum + Number(item.extra.filesTotal || 0), 0),
      bytes: items.reduce((sum, item) => sum + Number(item.extra.bytesTotal || 0), 0),
    };
  }

  async countReportLinks(reportId) {
    return this.links.filter((link) => link.reportId === reportId).length;
  }  // ── audit queries (docs/DATABASE.md §audit) ────────────────────────────────
  #auditMatches(event, projectId, filter) {
    if (projectId || filter.selfActor) {
      const inProject = projectId ? event.projectId === projectId : false;
      const ownAction = filter.selfActor ? event.actor === filter.selfActor : false;
      if (!inProject && !ownAction) return false;
    }
    if (filter.action && event.action !== filter.action) return false;
    if (filter.actor && event.actor !== filter.actor) return false;
    if (filter.entity && event.entity !== filter.entity) return false;
    if (filter.entityId && event.entityId !== filter.entityId) return false;
    if (filter.outcome && event.outcome !== filter.outcome) return false;
    if (filter.since && event.createdAt < new Date(filter.since).toISOString()) return false;
    if (filter.until && event.createdAt > new Date(filter.until).toISOString()) return false;
    return true;
  }

  async queryAudit(projectId, filter = {}) {
    const limit = clampInt(filter.limit, 50, 1, 500);
    const offset = clampInt(filter.offset, 0, 0, 100000000);
    const matched = this.auditEvents
      .filter((event) => this.#auditMatches(event, projectId, filter))
      .sort((a, b) => (a.createdAt === b.createdAt ? 0 : b.createdAt.localeCompare(a.createdAt)));
    return { items: matched.slice(offset, offset + limit).map(clone), total: matched.length, limit, offset };
  }

  async listAudit(projectId, filter = {}) {
    const result = await this.queryAudit(projectId, filter);
    return result.items;
  }

  async getAuditEvent(eventId) {
    const match = this.auditEvents.find((event) => event.eventId === eventId);
    return clone(match || null);
  }

  async auditSummary(projectId, filter = {}) {
    const matched = this.auditEvents.filter((event) => this.#auditMatches(event, projectId, filter));
    const byAction = new Map();
    const byOutcome = new Map();
    for (const event of matched) {
      byAction.set(event.action, (byAction.get(event.action) || 0) + 1);
      byOutcome.set(event.outcome, (byOutcome.get(event.outcome) || 0) + 1);
    }
    const toRows = (map, key) =>
      [...map.entries()].map(([name, count]) => ({ [key]: name, count })).sort((a, b) => (b.count - a.count) || a[key].localeCompare(b[key]));
    return { total: matched.length, byAction: toRows(byAction, "action"), byOutcome: toRows(byOutcome, "outcome") };
  }

  // ── migration ledger queries (docs/DATABASE.md §migration-ledger) ─────────
  async queryMigrationRuns(filter = {}) {
    const limit = clampInt(filter.limit, 20, 1, 200);
    const offset = clampInt(filter.offset, 0, 0, 100000000);
    const matched = [...this.migrationRuns.values()]
      .filter((run) => (filter.projectId ? run.projectId === filter.projectId : true))
      .filter((run) => (filter.status ? run.status === filter.status : true))
      .filter((run) => (filter.kind ? run.kind === filter.kind : true))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return { items: matched.slice(offset, offset + limit).map(clone), total: matched.length, limit, offset };
  }

  async migrationItemKindCounts(runId) {
    const counts = new Map();
    for (const item of this.migrationItems) {
      if (item.runId !== runId) continue;
      counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
    }
    return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => a.kind.localeCompare(b.kind));
  }

  async migrationStatusSnapshot() {
    return {
      applied: this.migrations.length,
      pending: 0,
      latest: this.migrations.length ? this.migrations[this.migrations.length - 1].version : null,
      versions: this.migrations.map((row) => row.version),
    };
  }

  // ── retention / archive (docs/DATABASE.md §lifecycle) ─────────────────────
  #reportHasOpenBug(reportId) {
    for (const link of this.links) {
      if (link.reportId !== reportId) continue;
      const bug = this.bugs.get(link.bugId);
      if (bug && !bug.deletedAt && !OPEN_BUG_STATUSES.has(bug.status)) return true;
    }
    return false;
  }

  async retentionCandidates(options = {}) {
    const cutoffs = retentionCutoffs(options);
    const reports = [...this.reports.values()].filter((report) => !report.deletedAt);
    const archiveReports = reports.filter(
      (report) => report.storageTier !== "cold" && report.createdAt < cutoffs.reportArchiveCutoff && (!cutoffs.projectId || report.projectId === cutoffs.projectId),
    ).length;
    const expireReports = reports.filter(
      (report) =>
        report.createdAt < cutoffs.reportRetainCutoff &&
        report.kind !== "workspace-archive" &&
        (!cutoffs.projectId || report.projectId === cutoffs.projectId) &&
        !this.#reportHasOpenBug(report.id),
    ).length;
    const expireAuditEvents = this.auditEvents.filter(
      (event) => event.createdAt < cutoffs.auditCutoff && (!cutoffs.projectId || event.projectId === cutoffs.projectId),
    ).length;
    const expireIngestJobs = [...this.ingestJobs.values()].filter(
      (job) =>
        (job.status === "succeeded" || job.status === "failed") &&
        job.updatedAt < cutoffs.ingestCutoff &&
        (!cutoffs.projectId || job.projectId === cutoffs.projectId),
    ).length;
    const garbageBlobs = [...this.blobs.values()].filter((blob) => Number(blob.refcount) <= 0 && blob.createdAt < cutoffs.blobCutoff).length;
    return { options: { ...options }, cutoffs, archiveReports, expireReports, expireAuditEvents, expireIngestJobs, garbageBlobs };
  }

  async applyArchiveReports(options = {}) {
    const cutoffs = retentionCutoffs(options);
    let count = 0;
    for (const report of this.reports.values()) {
      if (report.deletedAt) continue;
      if (report.storageTier === "cold") continue;
      if (cutoffs.projectId && report.projectId !== cutoffs.projectId) continue;
      if (report.createdAt >= cutoffs.reportArchiveCutoff) continue;
      report.storageTier = "cold";
      report.updatedAt = now();
      count += 1;
    }
    return count;
  }

  async applyExpireReports(options = {}) {
    const cutoffs = retentionCutoffs(options);
    let count = 0;
    for (const report of this.reports.values()) {
      if (report.deletedAt) continue;
      if (report.kind === "workspace-archive") continue;
      if (cutoffs.projectId && report.projectId !== cutoffs.projectId) continue;
      if (report.createdAt >= cutoffs.reportRetainCutoff) continue;
      if (this.#reportHasOpenBug(report.id)) continue;
      report.deletedAt = now();
      report.storageTier = "cold";
      report.updatedAt = now();
      count += 1;
    }
    return count;
  }

  async applyExpireAudit(options = {}) {
    const cutoffs = retentionCutoffs(options);
    const before = this.auditEvents.length;
    this.auditEvents = this.auditEvents.filter((event) => {
      if (event.createdAt >= cutoffs.auditCutoff) return true;
      if (cutoffs.projectId && event.projectId !== cutoffs.projectId) return true;
      return false;
    });
    return { droppedPartitions: [], deletedRows: before - this.auditEvents.length };
  }

  async applyExpireIngestJobs(options = {}) {
    const cutoffs = retentionCutoffs(options);
    let count = 0;
    for (const [id, job] of [...this.ingestJobs.entries()]) {
      if (job.status !== "succeeded" && job.status !== "failed") continue;
      if (cutoffs.projectId && job.projectId !== cutoffs.projectId) continue;
      if (job.updatedAt >= cutoffs.ingestCutoff) continue;
      this.ingestJobs.delete(id);
      count += 1;
    }
    return count;
  }

  async listGarbageBlobs(options = {}) {
    const cutoffs = retentionCutoffs(options);
    const limit = clampInt(options.limit, 1000, 1, 5000);
    return [...this.blobs.values()]
      .filter((blob) => Number(blob.refcount) <= 0 && blob.createdAt < cutoffs.blobCutoff)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async deleteBlobRow(sha256) {
    const blob = this.blobs.get(sha256);
    if (!blob || Number(blob.refcount) > 0) return false;
    this.blobs.delete(sha256);
    return true;
  }

  // ── backup / restore ───────────────────────────────────────────────────────
  async exportSnapshot({ includeAudit = true } = {}) {
    const tables = {
      projects: [...this.projects.values()].map(clone),
      tokens: [...this.tokens.values()].map(clone),
      blobs: [],
      bugs: [...this.bugs.values()].map(clone),
      bug_legacy_index: [...this.legacyIndex.entries()].map(([key, bugId]) => {
        const [projectId, legacyId] = key.split("\u0000");
        const bug = this.bugs.get(bugId);
        return { project_id: projectId, legacy_id: legacyId, bug_id: bugId, bug_created_at: bug ? bug.createdAt : null };
      }),
      reports: [...this.reports.values()].map((report) => ({
        id: report.id,
        project_id: report.projectId,
        kind: report.kind,
        title: report.title,
        storage_tier: report.storageTier,
        restore_status: report.restoreStatus,
        author: report.author,
        payload: report.payload,
        deleted_at: report.deletedAt,
        created_at: report.createdAt,
        updated_at: report.updatedAt,
      })),
      report_files: [...this.reportFiles.entries()].flatMap(([, map]) => [...map.values()]),
      report_links: this.links.map(clone),
      ingest_jobs: [...this.ingestJobs.values()].map(clone),
      audit_events: includeAudit ? this.auditEvents.map(clone) : [],
    };
    return {
      schemaVersion: 1,
      generatedAt: now(),
      driver: "memory",
      database: "(memory)",
      tables,
    };
  }

  async importSnapshot(snapshot) {
    const imported = {};
    for (const table of SNAPSHOT_TABLES) {
      const rows = snapshot.tables?.[table];
      if (!Array.isArray(rows)) continue;
      imported[table] = rows.length;
      for (const row of rows) {
        if (table === "projects") this.projects.set(row.id, clone(row));
        else if (table === "tokens") this.tokens.set(row.id, clone(row));
        else if (table === "bugs") this.bugs.set(row.id, clone(row));
        else if (table === "reports") {
          this.reports.set(row.id, {
            id: row.id,
            projectId: row.project_id,
            kind: row.kind,
            title: row.title,
            storageTier: row.storage_tier,
            restoreStatus: row.restore_status,
            author: row.author,
            payload: clone(row.payload),
            deletedAt: row.deleted_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          });
        } else if (table === "report_files") {
          const reportId = row.report_id ?? row.reportId;
          const map = this.reportFiles.get(reportId) || new Map();
          map.set(row.path, clone(row));
          this.reportFiles.set(reportId, map);
        } else if (table === "report_links") this.links.push(clone(row));
        else if (table === "ingest_jobs") this.ingestJobs.set(row.id, clone(row));
        else if (table === "audit_events") this.auditEvents.push(clone(row));
        else if (table === "bug_legacy_index") {
          this.legacyIndex.set(MemoryVaultStore.#legacyKey(row.project_id, row.legacy_id), row.bug_id);
        }
      }
    }
    return imported;
  }

  async tableCounts() {
    return {
      projects: this.projects.size,
      tokens: this.tokens.size,
      blobs: 0,
      bugs: this.bugs.size,
      bug_legacy_index: this.legacyIndex.size,
      reports: this.reports.size,
      report_files: [...this.reportFiles.values()].reduce((sum, map) => sum + map.size, 0),
      report_links: this.links.length,
      ingest_jobs: this.ingestJobs.size,
      audit_events: this.auditEvents.length,
    };
  }
}
