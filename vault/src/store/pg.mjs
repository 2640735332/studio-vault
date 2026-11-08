import { PgClient } from "./pg-client.mjs";
import { applyMigrations, migrationStatus } from "./migrate.mjs";
import { lit, litJson, litText, litTimestamp, litUuid } from "../lib/sql.mjs";
import { sha256Hex, timingSafeEqualHex, uuid } from "../lib/ids.mjs";

function jsonValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function n(value) {
  return value === null || value === undefined ? null : Number(value);
}

function mapProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    settings: jsonValue(row.settings) || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    tokenHash: row.token_hash,
    projects: jsonValue(row.projects) || [],
    role: row.role,
    metadata: jsonValue(row.metadata) || {},
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function mapBug(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    legacyId: row.legacy_id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    priority: row.priority,
    assignee: row.assignee,
    fingerprint: row.fingerprint,
    clusterId: row.cluster_id,
    resolution: row.resolution,
    closedAt: row.closed_at,
    author: row.author,
    updatedBy: row.updated_by,
    repo: row.repo,
    branch: row.branch,
    worktree: row.worktree,
    commitSha: row.commit_sha,
    sourceTrack: row.source_track,
    payload: jsonValue(row.payload) || {},
    version: n(row.version),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    storageTier: row.storage_tier,
    restoreStatus: row.restore_status,
    author: row.author,
    payload: jsonValue(row.payload) || {},
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReportFile(row) {
  return {
    reportId: row.report_id,
    path: row.path,
    sha256: row.sha256,
    sizeBytes: n(row.size_bytes),
    role: row.role,
    createdAt: row.created_at,
  };
}

function mapIngestJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    sourcePath: row.source_path,
    contentSha256: row.content_sha256,
    status: row.status,
    attempts: n(row.attempts),
    lastError: row.last_error,
    reportId: row.report_id,
    bytesTotal: n(row.bytes_total),
    filesTotal: n(row.files_total),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAudit(row) {
  return {
    eventId: row.event_id,
    projectId: row.project_id,
    actor: row.actor,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    outcome: row.outcome,
    statusCode: n(row.status_code),
    before: jsonValue(row.before),
    after: jsonValue(row.after),
    details: jsonValue(row.details) || {},
    requestId: row.request_id,
    remoteAddr: row.remote_addr,
    createdAt: row.created_at,
  };
}

function mapBlob(row) {
  if (!row) return null;
  return {
    sha256: row.sha256,
    sizeBytes: n(row.size_bytes),
    bucket: row.bucket,
    objectKey: row.object_key,
    refcount: n(row.refcount),
    storageTier: row.storage_tier,
    contentType: row.content_type,
    createdAt: row.created_at,
  };
}

function mapMigrationRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    source: row.source,
    mode: row.mode,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    counters: jsonValue(row.counters) || {},
    notes: jsonValue(row.notes) || {},
  };
}

function mapMigrationItem(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    projectId: row.project_id,
    kind: row.kind,
    entityId: row.entity_id,
    sourcePath: row.source_path,
    contentSha256: row.content_sha256,
    legacyId: row.legacy_id,
    extra: jsonValue(row.extra) || {},
    createdAt: row.created_at,
  };
}

export const SNAPSHOT_TABLES = [
  "projects",
  "tokens",
  "blobs",
  "bugs",
  "bug_legacy_index",
  "reports",
  "report_files",
  "report_links",
  "ingest_jobs",
  "audit_events",
];


const OPEN_BUG_STATUSES = ["closed", "fixed", "duplicate", "wontfix", "cannot_reproduce", "false_red"];

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value === undefined || value === null ? "" : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function auditWhere(projectId, filter = {}) {
  const scope = [];
  if (projectId) scope.push("project_id = " + litText(projectId));
  if (filter.selfActor) scope.push("actor = " + litText(filter.selfActor));
  const where = [];
  if (scope.length) where.push("(" + scope.join(" OR ") + ")");
  if (filter.action) where.push("action = " + litText(filter.action));
  if (filter.actor) where.push("actor = " + litText(filter.actor));
  if (filter.entity) where.push("entity = " + litText(filter.entity));
  if (filter.entityId) where.push("entity_id = " + litText(filter.entityId));
  if (filter.outcome) where.push("outcome = " + litText(filter.outcome));
  if (filter.since) where.push("created_at >= " + litTimestamp(filter.since));
  if (filter.until) where.push("created_at <= " + litTimestamp(filter.until));
  return where;
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

function openBugLinkExclusion() {
  return (
    "NOT EXISTS (SELECT 1 FROM report_links l JOIN bugs b ON b.id = l.bug_id WHERE l.report_id = r.id" +
    " AND b.deleted_at IS NULL AND b.status NOT IN (" + OPEN_BUG_STATUSES.map((status) => litText(status)).join(", ") + "))"
  );
}

const BUG_PATCH_FIELDS = {
  title: "title",
  status: "status",
  severity: "severity",
  priority: "priority",
  assignee: "assignee",
  fingerprint: "fingerprint",
  clusterId: "cluster_id",
  resolution: "resolution",
  sourceTrack: "source_track",
  repo: "repo",
  branch: "branch",
  worktree: "worktree",
  commitSha: "commit_sha",
};

export class PgVaultStore {
  driver = "pg";
  durable = true;

  constructor(config, logger) {
    this.config = config;
    this.log = logger || (() => {});
    this.client = new PgClient({ ...config.pg, applicationName: "studio-vault/" + config.version });
    this.lastMigrationStatus = null;
    this.startedAt = new Date().toISOString();
  }

  async init() {
    await this.client.ping();
    if (this.config.migrateOnStart) {
      const result = await applyMigrations({ client: this.client, dir: this.config.migrationsDir, log: (m) => this.log.info(m) });
      this.lastMigrationStatus = result.status;
      const { ensurePartitions } = await import("./migrate.mjs");
      await ensurePartitions({ client: this.client, fromMonths: -1, toMonths: 2, log: (m) => this.log.info(m) });
    } else {
      this.lastMigrationStatus = await migrationStatus({ client: this.client, dir: this.config.migrationsDir });
    }
    await this.#bootstrap();
  }

  async close() {
    await this.client.close();
  }

  async ping() {
    return this.client.ping();
  }

  async healthCounts() {
    const result = await this.client.query(
      "SELECT " +
        "(SELECT count(*) FROM projects)::text AS projects, " +
        "(SELECT count(*) FROM bugs WHERE deleted_at IS NULL)::text AS bugs, " +
        "(SELECT count(*) FROM reports WHERE deleted_at IS NULL)::text AS reports, " +
        "(SELECT count(*) FROM test_runs WHERE deleted_at IS NULL)::text AS test_runs, " +
        "(SELECT count(*) FROM blobs)::text AS blobs, " +
        "(SELECT COALESCE(sum(size_bytes), 0) FROM blobs)::text AS bytes, " +
        "(SELECT count(*) FROM tokens WHERE revoked_at IS NULL)::text AS active_tokens",
    );
    const row = result.rows[0] || {};
    const queue = await this.ingestQueueStats();
    return {
      usage: {
        projects: n(row.projects),
        bugs: n(row.bugs),
        reports: n(row.reports),
        testRuns: n(row.test_runs),
        blobs: n(row.blobs),
        bytes: n(row.bytes),
        activeTokens: n(row.active_tokens),
      },
      queue,
    };
  }

  async listPartitions() {
    const { listPartitions } = await import("./migrate.mjs");
    return listPartitions({ client: this.client });
  }

  async #bootstrap() {
    if (!this.config.devSeed) return;
    for (const projectId of this.config.devProjects) await this.ensureProject(projectId, projectId);
    for (const devToken of this.config.devTokens) {
      const existing = await this.findToken(devToken.id);
      if (existing) continue;
      await this.createToken({
        id: devToken.id,
        label: devToken.label,
        tokenHash: sha256Hex(devToken.secret),
        projects: devToken.projects,
        role: devToken.role,
        metadata: { dev: true },
      });
    }
    this.log.info("dev seed ensured", { projects: this.config.devProjects.length, tokens: this.config.devTokens.length });
  }

  // ── projects ────────────────────────────────────────────────────────────────
  async ensureProject(id, name) {
    const result = await this.client.query(
      "INSERT INTO projects (id, name, description) VALUES (" +
        litText(id) + ", " + litText(name || id) + ", " + litText("registered by vault bootstrap") + ") " +
        "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now() RETURNING *",
    );
    return mapProject(result.rows[0]);
  }

  async getProject(id) {
    const result = await this.client.query("SELECT * FROM projects WHERE id = " + litText(id));
    return mapProject(result.rows[0]);
  }

  async listProjects(projectIds) {
    let sql = "SELECT * FROM projects";
    if (Array.isArray(projectIds) && projectIds.length > 0) {
      sql += " WHERE id IN (" + projectIds.map((id) => litText(id)).join(", ") + ")";
    }
    sql += " ORDER BY id";
    const result = await this.client.query(sql);
    return result.rows.map(mapProject);
  }

  // ── tokens ──────────────────────────────────────────────────────────────────
  async findToken(id) {
    const result = await this.client.query("SELECT * FROM tokens WHERE id = " + litText(id));
    return mapToken(result.rows[0]);
  }

  async touchToken(id) {
    await this.client.query("UPDATE tokens SET last_used_at = now() WHERE id = " + litText(id));
  }

  async verifyToken(id, secret) {
    const token = await this.findToken(id);
    if (!token) return { ok: false, reason: "unknown_token" };
    if (token.revokedAt) return { ok: false, reason: "revoked_token", token };
    const probe = sha256Hex(secret);
    if (!timingSafeEqualHex(probe, token.tokenHash)) return { ok: false, reason: "invalid_token", token };
    await this.touchToken(id);
    return { ok: true, token };
  }

  async createToken(input) {
    const result = await this.client.query(
      "INSERT INTO tokens (id, label, token_hash, projects, role, metadata) VALUES (" +
        litText(input.id) + ", " + litText(input.label) + ", " + litText(input.tokenHash) + ", " +
        litJson(input.projects || []) + ", " + litText(input.role || "writer") + ", " + litJson(input.metadata || {}) + ") RETURNING *",
    );
    return mapToken(result.rows[0]);
  }

  async listTokens() {
    const result = await this.client.query(
      "SELECT id, label, projects, role, metadata, created_at, last_used_at, revoked_at FROM tokens ORDER BY created_at",
    );
    return result.rows.map(mapToken);
  }

  async revokeToken(id) {
    const result = await this.client.query("UPDATE tokens SET revoked_at = now() WHERE id = " + litText(id) + " RETURNING *");
    return mapToken(result.rows[0]);
  }

  // ── bugs ────────────────────────────────────────────────────────────────────
  async createBug(projectId, input, author) {
    const id = uuid();
    const now = new Date();
    const result = await this.client.query(
      "INSERT INTO bugs (id, project_id, legacy_id, title, status, severity, assignee, fingerprint, cluster_id, " +
        "resolution, author, updated_by, repo, branch, worktree, commit_sha, source_track, priority, payload, version, " +
        "created_at, updated_at) VALUES (" +
        [
          litUuid(id),
          litText(projectId),
          litText(input.legacyId ?? null),
          litText(input.title ?? null),
          litText(input.status ?? "new"),
          litText(input.severity ?? "medium"),
          litText(input.assignee ?? null),
          litText(input.fingerprint ?? null),
          litText(input.clusterId ?? null),
          litText(input.resolution ?? null),
          litText(author),
          litText(author),
          litText(input.repo ?? null),
          litText(input.branch ?? null),
          litText(input.worktree ?? null),
          litText(input.commitSha ?? null),
          litText(input.sourceTrack ?? null),
          litText(input.priority ?? null),
          litJson(input.payload ?? {}),
          "1",
          "'" + now.toISOString() + "'::timestamptz",
          "'" + now.toISOString() + "'::timestamptz",
        ].join(", ") + ") RETURNING *",
    );
    const bug = mapBug(result.rows[0]);
    let legacyConflict = null;
    const legacyId = input.legacyId;
    if (legacyId) {
      const indexResult = await this.client.query(
        "INSERT INTO bug_legacy_index (project_id, legacy_id, bug_id, bug_created_at) VALUES (" +
          litText(projectId) + ", " + litText(legacyId) + ", " + litUuid(bug.id) + ", '" + bug.createdAt + "'::timestamptz) " +
          "ON CONFLICT (project_id, legacy_id) DO NOTHING RETURNING bug_id",
      );
      if (indexResult.rows.length === 0) {
        const existing = await this.client.query(
          "SELECT bug_id FROM bug_legacy_index WHERE project_id = " + litText(projectId) + " AND legacy_id = " + litText(legacyId),
        );
        legacyConflict = { legacyId, existingBugId: existing.rows[0] ? existing.rows[0].bug_id : null };
      }
    }
    return { bug, legacyConflict };
  }

  #bugWhere(projectId, filter = {}) {
    const where = ["project_id = " + litText(projectId)];
    if (!filter.includeDeleted) where.push("deleted_at IS NULL");
    if (filter.status) where.push("status = " + litText(filter.status));
    if (filter.legacyId) where.push("legacy_id = " + litText(filter.legacyId));
    return where.join(" AND ");
  }

  async listBugs(projectId, filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit ?? 50), 1), 500);
    const offset = Math.max(Number(filter.offset ?? 0), 0);
    const where = this.#bugWhere(projectId, filter);
    const totalResult = await this.client.query("SELECT count(*)::text AS total FROM bugs WHERE " + where);
    const result = await this.client.query(
      "SELECT * FROM bugs WHERE " + where + " ORDER BY created_at DESC LIMIT " + String(limit) + " OFFSET " + String(offset),
    );
    return { items: result.rows.map(mapBug), total: n(totalResult.rows[0]?.total) ?? 0, limit, offset };
  }

  async getBug(projectId, id) {
    const result = await this.client.query(
      "SELECT * FROM bugs WHERE id = " + litUuid(id) + " AND " + this.#bugWhere(projectId, {}),
    );
    return mapBug(result.rows[0]);
  }

  async getBugByLegacyId(projectId, legacyId) {
    const result = await this.client.query(
      "SELECT b.* FROM bugs b JOIN bug_legacy_index i ON i.bug_id = b.id " +
        "WHERE i.project_id = " + litText(projectId) + " AND i.legacy_id = " + litText(legacyId) + " LIMIT 1",
    );
    return mapBug(result.rows[0]);
  }

  async updateBug(projectId, id, patch, expectedVersion, author) {
    return this.client.transaction(async (query) => {
      const currentResult = await query(
        "SELECT * FROM bugs WHERE id = " + litUuid(id) + " AND project_id = " + litText(projectId) + " LIMIT 1",
      );
      if (currentResult.rows.length === 0) return { found: false };
      const before = mapBug(currentResult.rows[0]);
      if (expectedVersion !== undefined && expectedVersion !== null && Number(before.version) !== Number(expectedVersion)) {
        return { conflict: true, current: before };
      }
      const sets = [];
      for (const [key, column] of Object.entries(BUG_PATCH_FIELDS)) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) sets.push(column + " = " + litText(patch[key] === null ? null : String(patch[key])));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "closedAt")) sets.push("closed_at = " + litText(patch.closedAt));
      if (Object.prototype.hasOwnProperty.call(patch, "payload")) sets.push("payload = " + litJson(patch.payload));
      sets.push("version = version + 1");
      sets.push("updated_at = now()");
      sets.push("updated_by = " + litText(author));
      const updatedResult = await query(
        "UPDATE bugs SET " + sets.join(", ") + " WHERE id = " + litUuid(id) + " AND project_id = " + litText(projectId) +
          " AND version = " + String(Number(before.version)) + " RETURNING *",
      );
      if (updatedResult.rows.length === 0) return { conflict: true, current: before };
      return { conflict: false, before, bug: mapBug(updatedResult.rows[0]) };
    });
  }

  // ── reports / links ─────────────────────────────────────────────────────────
  async createReport(projectId, input, author) {
    if (input.ifAbsent) {
      return this.client.transaction(async (query) => {
        const claimed = await query("INSERT INTO report_identity_index (report_id, project_id) VALUES (" +
          litUuid(input.id) + ", " + litText(projectId) + ") ON CONFLICT DO NOTHING RETURNING report_id");
        if (!claimed.rows.length) return { conflict: true };
        const existing = await query("SELECT id FROM reports WHERE id = " + litUuid(input.id) + " LIMIT 1");
        if (existing.rows.length) return { conflict: true };
        // Reuse the normal writer on the same transaction; never reacquire PgClient's mutex.
        const scoped = Object.create(this);
        scoped.client = { query };
        return scoped.createReport(projectId, { ...input, ifAbsent: false }, author);
      });
    }
    const id = input.id || uuid();
    const result = await this.client.query(
      "INSERT INTO reports (id, project_id, kind, title, storage_tier, restore_status, author, payload) VALUES (" +
        [
          litUuid(id),
          litText(projectId),
          litText(input.kind ?? "report"),
          litText(input.title ?? null),
          litText(input.storageTier ?? "hot"),
          litText(input.restoreStatus ?? "none"),
          litText(author),
          litJson(input.payload ?? {}),
        ].join(", ") + ") RETURNING *",
    );
    const report = mapReport(result.rows[0]);
    const files = Array.isArray(input.files) ? input.files : [];
    for (const file of files) {
      await this.addReportFile(report.id, file);
    }
    return { report, files: await this.listReportFiles(report.id) };
  }

  async addReportFile(reportId, file) {
    const result = await this.client.query(
      "INSERT INTO report_files (report_id, path, sha256, size_bytes, role) VALUES (" +
        [litUuid(reportId), litText(file.path), litText(file.sha256), String(Number(file.sizeBytes || 0)), litText(file.role ?? null)].join(", ") +
        ") ON CONFLICT (report_id, path) DO UPDATE SET sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes RETURNING *",
    );
    return mapReportFile(result.rows[0]);
  }

  async listReportFiles(reportId) {
    const result = await this.client.query(
      "SELECT * FROM report_files WHERE report_id = " + litUuid(reportId) + " ORDER BY path",
    );
    return result.rows.map(mapReportFile);
  }

  async getReport(projectId, id) {
    const result = await this.client.query(
      "SELECT * FROM reports WHERE id = " + litUuid(id) + " AND project_id = " + litText(projectId) + " AND deleted_at IS NULL LIMIT 1",
    );
    if (!result.rows.length) return null;
    return { report: mapReport(result.rows[0]), files: await this.listReportFiles(id) };
  }

  async listReports(projectId, filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit ?? 50), 1), 500);
    const offset = Math.max(Number(filter.offset ?? 0), 0);
    const where = ["project_id = " + litText(projectId), "deleted_at IS NULL"];
    if (filter.kind) where.push("kind = " + litText(filter.kind));
    const clause = where.join(" AND ");
    const totalResult = await this.client.query("SELECT count(*)::text AS total FROM reports WHERE " + clause);
    const result = await this.client.query(
      "SELECT * FROM reports WHERE " + clause + " ORDER BY created_at DESC LIMIT " + String(limit) + " OFFSET " + String(offset),
    );
    return { items: result.rows.map(mapReport), total: n(totalResult.rows[0]?.total) ?? 0, limit, offset };
  }

  async createLink(projectId, input) {
    const result = await this.client.query(
      "INSERT INTO report_links (report_id, bug_id, role) VALUES (" +
        [litUuid(input.reportId), litUuid(input.bugId), litText(input.role ?? "evidence")].join(", ") +
        ") ON CONFLICT (report_id, bug_id, role) DO NOTHING RETURNING *",
    );
    if (result.rows.length > 0) return { created: true, link: { reportId: input.reportId, bugId: input.bugId, role: input.role ?? "evidence" } };
    return { created: false, link: { reportId: input.reportId, bugId: input.bugId, role: input.role ?? "evidence" } };
  }

  async listLinks(projectId, filter = {}) {
    const where = [];
    if (filter.bugId) where.push("l.bug_id = " + litUuid(filter.bugId));
    if (filter.reportId) where.push("l.report_id = " + litUuid(filter.reportId));
    if (!filter.bugId && !filter.reportId) where.push("true");
    const result = await this.client.query(
      "SELECT l.* FROM report_links l WHERE " + where.join(" AND ") + " ORDER BY l.created_at DESC LIMIT 500",
    );
    return result.rows.map((row) => ({ reportId: row.report_id, bugId: row.bug_id, role: row.role, createdAt: row.created_at }));
  }

  async deleteLink(input) {
    const result = await this.client.query(
      "DELETE FROM report_links WHERE report_id = " + litUuid(input.reportId) + " AND bug_id = " + litUuid(input.bugId) +
        " AND role = " + litText(input.role ?? "evidence") + " RETURNING *",
    );
    return result.rows.length > 0;
  }

  // ── ingest jobs ─────────────────────────────────────────────────────────────
  async createIngestJob(projectId, input) {
    const id = uuid();
    const result = await this.client.query(
      "INSERT INTO ingest_jobs (id, project_id, kind, source_path, content_sha256, status, bytes_total, files_total) VALUES (" +
        [
          litUuid(id), litText(projectId), litText(input.kind ?? "report"), litText(input.sourcePath),
          litText(input.contentSha256), litText(input.status ?? "pending"),
          String(Number(input.bytesTotal || 0)), String(Number(input.filesTotal || 0)),
        ].join(", ") +
        ") ON CONFLICT ON CONSTRAINT ingest_jobs_idempotency_key DO NOTHING RETURNING *",
    );
    if (result.rows.length > 0) return { created: true, job: mapIngestJob(result.rows[0]) };
    const existing = await this.client.query(
      "SELECT * FROM ingest_jobs WHERE project_id = " + litText(projectId) + " AND source_path = " + litText(input.sourcePath) +
        " AND content_sha256 = " + litText(input.contentSha256) + " AND kind = " + litText(input.kind ?? "report") + " LIMIT 1",
    );
    return { created: false, job: mapIngestJob(existing.rows[0]) };
  }

  async getIngestJob(id) {
    const result = await this.client.query("SELECT * FROM ingest_jobs WHERE id = " + litUuid(id));
    return mapIngestJob(result.rows[0]);
  }

  async ingestQueueStats() {
    const result = await this.client.query("SELECT status, count(*)::text AS count FROM ingest_jobs GROUP BY status");
    const counts = { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 };
    for (const row of result.rows) counts[row.status] = n(row.count) || 0;
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    return { ...counts, total };
  }

  // ── audit ──────────────────────────────────────────────────────────────────
  async appendAudit(event) {
    const id = uuid();
    await this.client.query(
      "INSERT INTO audit_events (event_id, project_id, actor, action, entity, entity_id, outcome, status_code, before, after, details, request_id, remote_addr) VALUES (" +
        [
          litUuid(id),
          litText(event.projectId ?? null),
          litText(event.actor ?? "anonymous"),
          litText(event.action),
          litText(event.entity ?? null),
          litText(event.entityId ?? null),
          litText(event.outcome ?? "ok"),
          event.statusCode === undefined || event.statusCode === null ? "NULL" : String(Number(event.statusCode)),
          event.before === undefined || event.before === null ? "NULL" : litJson(event.before),
          event.after === undefined || event.after === null ? "NULL" : litJson(event.after),
          litJson(event.details || {}),
          litText(event.requestId ?? null),
          litText(event.remoteAddr ?? null),
        ].join(", ") + ")",
    );
    return { eventId: id };
  }

  // ── object blobs (sha256 content addressing; bodies live in the object store) ─
  async upsertBlob(input) {
    const result = await this.client.query(
      "INSERT INTO blobs (sha256, size_bytes, bucket, object_key, refcount, content_type) VALUES (" +
        [
          litText(input.sha256),
          String(Number(input.sizeBytes || 0)),
          litText(input.bucket || "vault"),
          litText(input.objectKey || input.sha256),
          "1",
          litText(input.contentType || null),
        ].join(", ") +
        ") ON CONFLICT (sha256) DO UPDATE SET refcount = blobs.refcount + 1 RETURNING *",
    );
    const row = result.rows[0];
    return { created: n(row.refcount) === 1, refcount: n(row.refcount), blob: mapBlob(row) };
  }

  async getBlob(sha256) {
    const result = await this.client.query("SELECT * FROM blobs WHERE sha256 = " + litText(sha256));
    return mapBlob(result.rows[0]);
  }

  async decrementBlobRef(sha256) {
    const result = await this.client.query("UPDATE blobs SET refcount = refcount - 1 WHERE sha256 = " + litText(sha256) + " RETURNING *");
    if (result.rows.length === 0) return { found: false, refcount: 0, removed: false };
    const refcount = n(result.rows[0].refcount);
    if (refcount <= 0) {
      await this.client.query("DELETE FROM blobs WHERE sha256 = " + litText(sha256));
      return { found: true, refcount, removed: true };
    }
    return { found: true, refcount, removed: false };
  }

  async blobStats() {
    const result = await this.client.query(
      "SELECT count(*)::text AS blobs, COALESCE(sum(size_bytes), 0)::text AS bytes, COALESCE(sum(refcount), 0)::text AS refs FROM blobs",
    );
    const row = result.rows[0] || {};
    return { blobs: n(row.blobs) || 0, bytes: n(row.bytes) || 0, refs: n(row.refs) || 0 };
  }

  // ── migration runs / items (import bookkeeping + rollback) ────────────────
  async createMigrationRun(input) {
    const result = await this.client.query(
      "INSERT INTO migration_runs (id, project_id, kind, source, mode, status, notes) VALUES (" +
        [
          litUuid(input.id),
          litText(input.projectId),
          litText(input.kind || "bug-package-import"),
          litText(input.source),
          litText(input.mode || "execute"),
          litText(input.status || "running"),
          litJson(input.notes || {}),
        ].join(", ") +
        ") RETURNING *",
    );
    return mapMigrationRun(result.rows[0]);
  }

  async finishMigrationRun(id, { status, counters, notes }) {
    const result = await this.client.query(
      "UPDATE migration_runs SET status = " + litText(status || "completed") +
        ", counters = " + litJson(counters || {}) +
        (notes === undefined ? "" : ", notes = " + litJson(notes)) +
        ", finished_at = now() WHERE id = " + litUuid(id) + " RETURNING *",
    );
    return mapMigrationRun(result.rows[0]);
  }

  async getMigrationRun(id) {
    const result = await this.client.query("SELECT * FROM migration_runs WHERE id = " + litUuid(id));
    return mapMigrationRun(result.rows[0]);
  }

  async listMigrationRuns(filter = {}) {
    const limit = Math.min(Math.max(Number(filter.limit ?? 20), 1), 200);
    const where = [];
    if (filter.projectId) where.push("project_id = " + litText(filter.projectId));
    if (filter.status) where.push("status = " + litText(filter.status));
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const result = await this.client.query("SELECT * FROM migration_runs" + clause + " ORDER BY started_at DESC LIMIT " + String(limit));
    return result.rows.map(mapMigrationRun);
  }

  async insertMigrationItem(item) {
    const result = await this.client.query(
      "INSERT INTO migration_items (run_id, project_id, kind, entity_id, source_path, content_sha256, legacy_id, extra) VALUES (" +
        [
          litUuid(item.runId),
          litText(item.projectId),
          litText(item.kind),
          litText(item.entityId),
          litText(item.sourcePath),
          litText(item.contentSha256),
          litText(item.legacyId ?? null),
          litJson(item.extra || {}),
        ].join(", ") +
        ") ON CONFLICT (run_id, kind, entity_id) DO NOTHING RETURNING *",
    );
    return mapMigrationItem(result.rows[0]);
  }

  async listMigrationItems(runId) {
    const result = await this.client.query("SELECT * FROM migration_items WHERE run_id = " + litUuid(runId) + " ORDER BY created_at");
    return result.rows.map(mapMigrationItem);
  }

  async deleteMigrationItems(runId) {
    const result = await this.client.query("DELETE FROM migration_items WHERE run_id = " + litUuid(runId) + " RETURNING entity_id");
    return result.rows.length;
  }

  async migrationItemCounters(runId) {
    const result = await this.client.query(
      "SELECT count(*)::text AS items, COALESCE(sum((extra->>'filesTotal')::int), 0)::text AS files, COALESCE(sum((extra->>'bytesTotal')::bigint), 0)::text AS bytes FROM migration_items WHERE run_id = " +
        litUuid(runId),
    );
    const row = result.rows[0] || {};
    return { items: n(row.items) || 0, files: n(row.files) || 0, bytes: n(row.bytes) || 0 };
  }

  // ── counts used by the reconciliation / cutover steps ─────────────────────
  async reportCounters(projectId, kind) {
    const projectFilter = "r.project_id = " + litText(projectId) + (kind ? " AND r.kind = " + litText(kind) : "") + " AND r.deleted_at IS NULL";
    const result = await this.client.query(
      "SELECT " +
        "(SELECT count(*)::text FROM reports r WHERE " + projectFilter + ") AS reports, " +
        "(SELECT count(*)::text FROM report_files f JOIN reports r ON r.id = f.report_id WHERE " + projectFilter + ") AS files, " +
        "(SELECT COALESCE(sum(f.size_bytes), 0)::text FROM report_files f JOIN reports r ON r.id = f.report_id WHERE " + projectFilter + ") AS bytes",
    );
    const row = result.rows[0] || {};
    return { reports: n(row.reports) || 0, files: n(row.files) || 0, bytes: n(row.bytes) || 0 };
  }

  async bugCounters(projectId) {
    const result = await this.client.query(
      "SELECT count(*)::text AS bugs, count(DISTINCT legacy_id)::text AS unique_legacy FROM bugs WHERE project_id = " +
        litText(projectId) + " AND deleted_at IS NULL",
    );
    const row = result.rows[0] || {};
    return { bugs: n(row.bugs) || 0, uniqueLegacyIds: n(row.unique_legacy) || 0 };
  }

  async ingestCounters(projectId) {
    const result = await this.client.query(
      "SELECT status, count(*)::text AS count, COALESCE(sum(bytes_total), 0)::text AS bytes, COALESCE(sum(files_total), 0)::text AS files FROM ingest_jobs WHERE project_id = " +
        litText(projectId) + " GROUP BY status",
    );
    const counters = { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, total: 0, files: 0, bytes: 0 };
    for (const row of result.rows) {
      counters[row.status] = n(row.count) || 0;
      counters.total += n(row.count) || 0;
      counters.files += n(row.files) || 0;
      counters.bytes += n(row.bytes) || 0;
    }
    return counters;
  }

  async updateIngestJob(id, patch) {
    const sets = [];
    if (patch.status !== undefined) sets.push("status = " + litText(patch.status));
    if (patch.attempts !== undefined) sets.push("attempts = " + String(Number(patch.attempts)));
    if (patch.lastError !== undefined) sets.push("last_error = " + litText(patch.lastError));
    if (patch.reportId !== undefined) sets.push("report_id = " + (patch.reportId === null ? "NULL" : litUuid(patch.reportId)));
    if (patch.bytesTotal !== undefined) sets.push("bytes_total = " + String(Number(patch.bytesTotal)));
    if (patch.filesTotal !== undefined) sets.push("files_total = " + String(Number(patch.filesTotal)));
    sets.push("updated_at = now()");
    const result = await this.client.query("UPDATE ingest_jobs SET " + sets.join(", ") + " WHERE id = " + litUuid(id) + " RETURNING *");
    return mapIngestJob(result.rows[0]);
  }

  // ── hard deletes used by rollback / drill cleanup ─────────────────────────
  async deleteReport(projectId, reportId) {
    await this.client.query("DELETE FROM report_files WHERE report_id = " + litUuid(reportId));
    const result = await this.client.query("DELETE FROM reports WHERE id = " + litUuid(reportId) + " AND project_id = " + litText(projectId) + " RETURNING id");
    return result.rows.length > 0;
  }

  async deleteIngestJob(id) {
    const result = await this.client.query("DELETE FROM ingest_jobs WHERE id = " + litUuid(id) + " RETURNING id");
    return result.rows.length > 0;
  }

  async deleteBug(projectId, id) {
    await this.client.query("DELETE FROM bug_legacy_index WHERE bug_id = " + litUuid(id));
    const result = await this.client.query("DELETE FROM bugs WHERE id = " + litUuid(id) + " AND project_id = " + litText(projectId) + " RETURNING id");
    return result.rows.length > 0;
  }

  async findReportBySourcePath(projectId, sourcePath) {
    const result = await this.client.query(
      "SELECT * FROM reports WHERE project_id = " + litText(projectId) + " AND kind = 'bug-package' AND deleted_at IS NULL AND payload->>'sourcePath' = " +
        litText(sourcePath) + " ORDER BY created_at DESC LIMIT 1",
    );
    return mapReport(result.rows[0]);
  }

  async migrationItemSummary(projectId) {
    const result = await this.client.query(
      "SELECT count(*)::text AS items, count(DISTINCT legacy_id)::text AS legacy_ids, " +
        "COALESCE(sum((extra->>'filesTotal')::int), 0)::text AS files, " +
        "COALESCE(sum((extra->>'bytesTotal')::bigint), 0)::text AS bytes FROM migration_items WHERE project_id = " + litText(projectId),
    );
    const row = result.rows[0] || {};
    return { items: n(row.items) || 0, legacyIds: n(row.legacy_ids) || 0, files: n(row.files) || 0, bytes: n(row.bytes) || 0 };
  }

  async countReportLinks(reportId) {
    const result = await this.client.query("SELECT count(*)::text AS count FROM report_links WHERE report_id = " + litUuid(reportId));
    return n(result.rows[0]?.count) || 0;
  }  // ── audit queries (docs/DATABASE.md §audit) ────────────────────────────────
  async queryAudit(projectId, filter = {}) {
    const limit = clampInt(filter.limit, 50, 1, 500);
    const offset = clampInt(filter.offset, 0, 0, 100000000);
    const where = auditWhere(projectId, filter);
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const totalResult = await this.client.query("SELECT count(*)::text AS total FROM audit_events" + clause);
    const result = await this.client.query(
      "SELECT * FROM audit_events" + clause + " ORDER BY created_at DESC, event_id DESC LIMIT " + String(limit) + " OFFSET " + String(offset),
    );
    return { items: result.rows.map(mapAudit), total: n(totalResult.rows[0] && totalResult.rows[0].total) || 0, limit, offset };
  }

  async listAudit(projectId, filter = {}) {
    const result = await this.queryAudit(projectId, filter);
    return result.items;
  }

  async getAuditEvent(eventId) {
    const result = await this.client.query("SELECT * FROM audit_events WHERE event_id = " + litUuid(eventId));
    return mapAudit(result.rows[0]);
  }

  async auditSummary(projectId, filter = {}) {
    const where = auditWhere(projectId, filter);
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const totalResult = await this.client.query("SELECT count(*)::text AS total FROM audit_events" + clause);
    const byAction = await this.client.query("SELECT action, count(*)::text AS count FROM audit_events" + clause + " GROUP BY action ORDER BY count(*) DESC, action");
    const byOutcome = await this.client.query("SELECT outcome, count(*)::text AS count FROM audit_events" + clause + " GROUP BY outcome ORDER BY count(*) DESC, outcome");
    return {
      total: n(totalResult.rows[0] && totalResult.rows[0].total) || 0,
      byAction: byAction.rows.map((row) => ({ action: row.action, count: n(row.count) || 0 })),
      byOutcome: byOutcome.rows.map((row) => ({ outcome: row.outcome, count: n(row.count) || 0 })),
    };
  }

  // ── migration ledger queries (docs/DATABASE.md §migration-ledger) ─────────
  async queryMigrationRuns(filter = {}) {
    const limit = clampInt(filter.limit, 20, 1, 200);
    const offset = clampInt(filter.offset, 0, 0, 100000000);
    const where = [];
    if (filter.projectId) where.push("project_id = " + litText(filter.projectId));
    if (filter.status) where.push("status = " + litText(filter.status));
    if (filter.kind) where.push("kind = " + litText(filter.kind));
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const totalResult = await this.client.query("SELECT count(*)::text AS total FROM migration_runs" + clause);
    const result = await this.client.query("SELECT * FROM migration_runs" + clause + " ORDER BY started_at DESC LIMIT " + String(limit) + " OFFSET " + String(offset));
    return { items: result.rows.map(mapMigrationRun), total: n(totalResult.rows[0] && totalResult.rows[0].total) || 0, limit, offset };
  }

  async migrationItemKindCounts(runId) {
    const result = await this.client.query(
      "SELECT kind, count(*)::text AS count FROM migration_items WHERE run_id = " + litUuid(runId) + " GROUP BY kind ORDER BY kind",
    );
    return result.rows.map((row) => ({ kind: row.kind, count: n(row.count) || 0 }));
  }

  async migrationStatusSnapshot() {
    if (this.lastMigrationStatus) {
      const status = this.lastMigrationStatus;
      return { applied: status.applied.length, pending: status.pending.length, latest: status.latest, versions: status.applied.map((row) => row.version) };
    }
    const { migrationStatus } = await import("./migrate.mjs");
    const status = await migrationStatus({ client: this.client, dir: this.config.migrationsDir });
    return { applied: status.applied.length, pending: status.pending.length, latest: status.latest, versions: status.applied.map((row) => row.version) };
  }

  // ── retention / archive (docs/DATABASE.md §lifecycle) ─────────────────────
  async retentionCandidates(options = {}) {
    const cutoffs = retentionCutoffs(options);
    const reportProject = cutoffs.projectId ? " AND r.project_id = " + litText(cutoffs.projectId) : "";
    const auditProject = cutoffs.projectId ? " AND project_id = " + litText(cutoffs.projectId) : "";
    const ingestProject = cutoffs.projectId ? " AND project_id = " + litText(cutoffs.projectId) : "";
    const archive = await this.client.query(
      "SELECT count(*)::text AS count FROM reports r WHERE r.deleted_at IS NULL AND r.storage_tier <> 'cold' AND r.created_at < " +
        litTimestamp(cutoffs.reportArchiveCutoff) + reportProject,
    );
    const expire = await this.client.query(
      "SELECT count(*)::text AS count FROM reports r WHERE r.deleted_at IS NULL AND r.created_at < " +
        litTimestamp(cutoffs.reportRetainCutoff) + reportProject + " AND r.kind <> 'workspace-archive' AND " + openBugLinkExclusion(),
    );
    const auditRows = await this.client.query(
      "SELECT count(*)::text AS count FROM audit_events WHERE created_at < " + litTimestamp(cutoffs.auditCutoff) + auditProject,
    );
    const ingestRows = await this.client.query(
      "SELECT count(*)::text AS count FROM ingest_jobs WHERE status IN ('succeeded', 'failed') AND updated_at < " +
        litTimestamp(cutoffs.ingestCutoff) + ingestProject,
    );
    const blobRows = await this.client.query(
      "SELECT count(*)::text AS count FROM blobs WHERE refcount <= 0 AND created_at < " + litTimestamp(cutoffs.blobCutoff),
    );
    return {
      options: { ...options },
      cutoffs,
      archiveReports: n(archive.rows[0] && archive.rows[0].count) || 0,
      expireReports: n(expire.rows[0] && expire.rows[0].count) || 0,
      expireAuditEvents: n(auditRows.rows[0] && auditRows.rows[0].count) || 0,
      expireIngestJobs: n(ingestRows.rows[0] && ingestRows.rows[0].count) || 0,
      garbageBlobs: n(blobRows.rows[0] && blobRows.rows[0].count) || 0,
    };
  }

  async applyArchiveReports(options = {}) {
    const cutoffs = retentionCutoffs(options);
    const reportProject = cutoffs.projectId ? " AND r.project_id = " + litText(cutoffs.projectId) : "";
    const result = await this.client.query(
      "UPDATE reports r SET storage_tier = 'cold', updated_at = now() WHERE r.deleted_at IS NULL AND r.storage_tier <> 'cold' AND r.created_at < " +
        litTimestamp(cutoffs.reportArchiveCutoff) + reportProject + " RETURNING r.id",
    );
    return result.rows.length;
  }

  async applyExpireReports(options = {}) {
    const cutoffs = retentionCutoffs(options);
    const reportProject = cutoffs.projectId ? " AND r.project_id = " + litText(cutoffs.projectId) : "";
    const result = await this.client.query(
      "UPDATE reports r SET deleted_at = now(), storage_tier = 'cold', updated_at = now() WHERE r.deleted_at IS NULL AND r.created_at < " +
        litTimestamp(cutoffs.reportRetainCutoff) + reportProject + " AND r.kind <> 'workspace-archive' AND " + openBugLinkExclusion() + " RETURNING r.id",
    );
    return result.rows.length;
  }

  async applyExpireAudit(options = {}) {
    const cutoffs = retentionCutoffs(options);
    const auditProject = cutoffs.projectId ? " AND project_id = " + litText(cutoffs.projectId) : "";
    const droppedPartitions = [];
    if (!cutoffs.projectId) {
      const parts = await this.client.query(
        "SELECT c.relname AS name FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'audit_events' AND c.relkind = 'r'",
      );
      for (const row of parts.rows) {
        const match = /^audit_events_(\d{4})(\d{2})$/.exec(row.name);
        if (!match) continue;
        const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
        const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
        if (end.toISOString() <= cutoffs.auditCutoff) {
          await this.client.query("DROP TABLE IF EXISTS " + row.name);
          droppedPartitions.push(row.name);
        }
      }
    }
    const deleted = await this.client.query(
      "DELETE FROM audit_events WHERE created_at < " + litTimestamp(cutoffs.auditCutoff) + auditProject + " RETURNING event_id",
    );
    return { droppedPartitions, deletedRows: deleted.rows.length };
  }

  async applyExpireIngestJobs(options = {}) {
    const cutoffs = retentionCutoffs(options);
    const ingestProject = cutoffs.projectId ? " AND project_id = " + litText(cutoffs.projectId) : "";
    const result = await this.client.query(
      "DELETE FROM ingest_jobs WHERE status IN ('succeeded', 'failed') AND updated_at < " + litTimestamp(cutoffs.ingestCutoff) + ingestProject + " RETURNING id",
    );
    return result.rows.length;
  }

  async listGarbageBlobs(options = {}) {
    const cutoffs = retentionCutoffs(options);
    const limit = clampInt(options.limit, 1000, 1, 5000);
    const result = await this.client.query(
      "SELECT sha256, bucket, object_key, size_bytes, refcount, created_at FROM blobs WHERE refcount <= 0 AND created_at < " +
        litTimestamp(cutoffs.blobCutoff) + " ORDER BY created_at LIMIT " + String(limit),
    );
    return result.rows.map((row) => ({
      sha256: row.sha256,
      bucket: row.bucket,
      objectKey: row.object_key,
      sizeBytes: n(row.size_bytes),
      refcount: n(row.refcount),
      createdAt: row.created_at,
    }));
  }

  async deleteBlobRow(sha256) {
    const result = await this.client.query("DELETE FROM blobs WHERE sha256 = " + litText(sha256) + " AND refcount <= 0 RETURNING sha256");
    return result.rows.length > 0;
  }

  // ── backup / restore (logical snapshot used by scripts/vault-backup.mjs) ────
  async exportSnapshot({ includeAudit = true } = {}) {
    const tables = {};
    for (const table of SNAPSHOT_TABLES) {
      if (table === "audit_events" && !includeAudit) continue;
      const result = await this.client.query("SELECT to_jsonb(t) AS row FROM " + table + " t");
      tables[table] = result.rows.map((row) => jsonValue(row.row));
    }
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      driver: "pg",
      database: this.config.pg.database,
      tables,
    };
  }

  async importSnapshot(snapshot) {
    const imported = {};
    for (const table of SNAPSHOT_TABLES) {
      const rows = snapshot.tables?.[table];
      if (!Array.isArray(rows)) continue;
      let count = 0;
      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        const values = columns.map((column) => lit(row[column]));
        await this.client.query(
          "INSERT INTO " + table + " (" + columns.join(", ") + ") VALUES (" + values.join(", ") + ") ON CONFLICT DO NOTHING",
        );
        count += 1;
      }
      imported[table] = count;
    }
    return imported;
  }

  async tableCounts() {
    const counts = {};
    for (const table of SNAPSHOT_TABLES) {
      const result = await this.client.query("SELECT count(*)::text AS count FROM " + table);
      counts[table] = n(result.rows[0]?.count) ?? 0;
    }
    return counts;
  }
}
