import http from "node:http";
import { createHash } from "node:crypto";
import { createAuth, detectForgedAuthor, formatToken, newSecret, newTokenId, sha256Hex } from "./auth.mjs";
import { createMetrics } from "./metrics.mjs";
import { describeStore } from "./store/index.mjs";
import { createLogger } from "./lib/log.mjs";
import { ApiError, badRequest, forbidden, notFound } from "./lib/errors.mjs";
import { clientIp, mimeForPath, newRequestId, readJsonBody, readRawBody, sendApiError, sendJson, sendText } from "./lib/http.mjs";
import { createObjectStore } from "./store/objects.mjs";

const ROLES = { reader: 1, writer: 2, admin: 3 };

function nowIso() {
  return new Date().toISOString();
}

function queryInt(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function boolParam(url, name) {
  const raw = url.searchParams.get(name);
  return raw === "1" || raw === "true";
}

function requireString(value, field, { maxLength = 200 } = {}) {
  if (typeof value !== "string" || value.trim() === "") throw badRequest(field + " must be a non-empty string");
  if (value.length > maxLength) throw badRequest(field + " is longer than " + String(maxLength) + " characters");
  return value;
}

function optionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw badRequest(field + " must be a string");
  if (options.maxLength && value.length > options.maxLength) throw badRequest(field + " is too long");
  return value;
}

function requireUuid(value, field) {
  const text = requireString(value, field, { maxLength: 64 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) throw badRequest(field + " must be a uuid");
  return text;
}

const BUG_STATUSES = new Set(["new", "triaged", "in_progress", "fixed", "closed", "duplicate", "wontfix", "cannot_reproduce", "false_red"]);
const SEVERITIES = new Set(["low", "medium", "high", "blocker", "critical"]);
const REPO_RELS = new Set(["evidence", "log", "screenshot", "attachment", "primary"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const COMMIT_SHA_RE = /^[0-9a-f]{7,64}$/i;
const DATA_GAP_FIELDS = [
  { key: "branch", missing: (bug) => !bug.branch },
  { key: "commitSha", missing: (bug) => !bug.commitSha },
  { key: "build", missing: (bug) => !isPlainObject(bug.payload && bug.payload.build) },
  { key: "env", missing: (bug) => { const b = bug.payload && bug.payload.build; return !(isPlainObject(b && b.os) || isPlainObject(b && b.hw)); } },
  { key: "steps", missing: (bug) => !Array.isArray(bug.payload && bug.payload.steps) || bug.payload.steps.length === 0 },
  { key: "worldState", missing: (bug) => !isPlainObject(bug.payload && bug.payload.worldState) || Object.keys(bug.payload.worldState).length === 0 },
  { key: "reproRate", missing: (bug) => !isPlainObject(bug.payload && bug.payload.reproRate) },
  { key: "reporter", missing: (bug) => !isPlainObject(bug.payload && bug.payload.reporter) },
  { key: "caseContext", missing: (bug) => { const c = bug.payload && bug.payload.caseContext; return !isPlainObject(c) || !(c.case_id || c.checkpoint || (Array.isArray(c.assertions) && c.assertions.length > 0) || c.expected); } },
  { key: "sourceTrack", missing: (bug) => !bug.sourceTrack },
  { key: "priority", missing: (bug) => !bug.priority },
];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePriority(value) {
  const text = String(value === undefined || value === null ? "" : value).trim().toUpperCase();
  if (!text) return null;
  return PRIORITIES.has(text) ? text : null;
}

function decorateBug(bug) {
  if (!bug) return bug;
  const explicit = bug.payload && Array.isArray(bug.payload.dataGaps) ? bug.payload.dataGaps : null;
  return { ...bug, dataGaps: explicit || DATA_GAP_FIELDS.filter((field) => field.missing(bug)).map((field) => field.key) };
}

function mergePayload(current, patch) {
  const base = isPlainObject(current) ? current : {};
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

function normalizeReportPath(raw, field = "path") {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw badRequest(field + " is required");
  if (text.length > 512) throw badRequest(field + " is longer than 512 characters");
  const rel = text.replace(/\\/g, "/");
  if (rel.startsWith("/") || /^[A-Za-z]:\//.test(rel)) throw badRequest(field + " must be a relative path");
  const parts = rel.split("/");
  if (parts.some((part) => part === ".." || part === "")) throw badRequest(field + " must not contain empty/.. segments");
  return parts.join("/");
}

function inferReportRole(relPath) {
  const lower = String(relPath || "").toLowerCase();
  if (lower.endsWith("readme.md")) return "readme";
  if (/\.(png|jpg|jpeg|webp|gif)$/.test(lower)) return "screenshot";
  if (/\.(jsonl|log|txt)$/.test(lower)) return "log";
  return "attachment";
}

function validateBugInput(body) {
  const input = {};
  if (body.legacyId !== undefined && body.legacyId !== null) {
    input.legacyId = requireString(body.legacyId, "legacyId", { maxLength: 64 });
  }
  if (body.status !== undefined) {
    if (!BUG_STATUSES.has(body.status)) throw badRequest("status must be one of " + [...BUG_STATUSES].join(", "));
    input.status = body.status;
  }
  if (body.severity !== undefined) {
    if (!SEVERITIES.has(body.severity)) throw badRequest("severity must be one of " + [...SEVERITIES].join(", "));
    input.severity = body.severity;
  }
  for (const field of ["title", "assignee", "fingerprint", "clusterId", "resolution", "repo", "branch", "worktree", "sourceTrack"]) {
    if (body[field] !== undefined) input[field] = optionalString(body[field], field, { maxLength: 400 });
  }
  if (body.commitSha !== undefined && body.commitSha !== null && body.commitSha !== "") {
    const sha = optionalString(body.commitSha, "commitSha", { maxLength: 64 });
    if (sha && !COMMIT_SHA_RE.test(sha)) throw badRequest("commitSha must be 7-64 hex characters");
    input.commitSha = sha;
  } else if (body.commitSha === null || body.commitSha === "") {
    input.commitSha = null;
  }
  if (body.priority !== undefined) {
    if (body.priority === null || body.priority === "") input.priority = null;
    else {
      const priority = normalizePriority(body.priority);
      if (!priority) throw badRequest("priority must be one of P0, P1, P2, P3");
      input.priority = priority;
    }
  }
  if (body.payload !== undefined) {
    if (body.payload === null || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      throw badRequest("payload must be a JSON object");
    }
    input.payload = body.payload;
  }
  return input;
}

function buildRoutes(auth, store, config, metrics, log, env = {}) {
  const resolve = (ctx) => auth.resolveProject(ctx.auth, { project: ctx.projectHint });

  async function audit(ctx, event) {
    try {
      await store.appendAudit({
        actor: ctx.auth ? ctx.auth.author : "anonymous",
        requestId: ctx.requestId,
        remoteAddr: clientIp(ctx.req),
        ...event,
      });
    } catch (error) {
      log.warn("audit write failed", { action: event.action, error: String(error && error.message) });
    }
  }

  const routes = [];

  // ── health / metrics ───────────────────────────────────────────────────────
  routes.push({
    method: "GET",
    pattern: "/api/v1/health",
    public: true,
    async handler(ctx) {
      const info = describeStore(store);
      let storage = { ...info, ok: false, error: null };
      let usage = null;
      let queue = null;
      let migrations = null;
      let status = "ok";
      const reasons = [];
      try {
        const ping = await store.ping();
        storage = { ...info, ok: true, latencyMs: ping.latencyMs, serverVersion: ping.serverVersion, database: ping.database };
        const counts = await store.healthCounts();
        usage = counts.usage;
        queue = counts.queue;
        migrations = store.lastMigrationStatus || (await store.migrationStatus());
      } catch (error) {
        storage.ok = false;
        storage.error = String(error && error.message);
        reasons.push("storage_unavailable");
      }
      if (info.degraded) reasons.push("non_durable_store");
      if (reasons.length) status = "degraded";
      const payload = {
        status,
        service: config.service,
        version: config.version,
        apiVersion: config.apiVersion,
        capabilities: { reportCreateOnly: true, performanceArtifactIntegrity: true },
        generatedAt: nowIso(),
        startedAt: ctx.startedAt,
        uptimeSeconds: Number(((Date.now() - Date.parse(ctx.startedAt)) / 1000).toFixed(3)),
        storage,
        objects: { driver: config.objectStore },
        migrations: migrations
          ? { applied: migrations.applied.length, pending: migrations.pending.length, latest: migrations.latest }
          : { applied: 0, pending: 0, latest: null },
        projects: { total: usage ? usage.projects : null },
        usage,
        queue,
        degradedReasons: reasons,
      };
      const strict = boolParam(ctx.url, "strict");
      return { status: strict && status !== "ok" ? 503 : 200, body: payload };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/metrics",
    public: true,
    async handler() {
      let usage = null;
      let queue = null;
      try {
        const counts = await store.healthCounts();
        usage = counts.usage;
        queue = counts.queue;
      } catch {
        // metrics must stay scrapeable even when the store is down
      }
      return { status: 200, text: metrics.render({ usage, queue }), contentType: "text/plain; version=0.0.4; charset=utf-8" };
    },
  });

  // ── projects ──────────────────────────────────────────────────────────────
  routes.push({
    method: "GET",
    pattern: "/api/v1/projects",
    async handler(ctx) {
      const projects = await store.listProjects(ctx.auth.projects);
      return { status: 200, body: { items: projects, total: projects.length } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/projects/:project",
    async handler(ctx) {
      const projectId = resolve({ ...ctx, projectHint: ctx.params.project });
      const project = await store.getProject(projectId);
      if (!project) throw notFound("project " + projectId + " is not registered");
      return { status: 200, body: { project } };
    },
  });

  routes.push({
    method: "POST",
    pattern: "/api/v1/projects",
    async handler(ctx) {
      auth.requireRole(ctx.auth, "admin");
      const id = requireString(ctx.body.id, "id", { maxLength: 64 });
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) throw badRequest("id must match [a-z0-9][a-z0-9._-]{1,63}");
      const name = typeof ctx.body.name === "string" ? ctx.body.name : id;
      const project = await store.ensureProject(id, name);
      await audit(ctx, { projectId: id, action: "project.create", entity: "project", entityId: id, after: project });
      return { status: 201, body: { project } };
    },
  });

  // ── bugs ──────────────────────────────────────────────────────────────────
  routes.push({
    method: "GET",
    pattern: "/api/v1/bugs",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const filter = {
        limit: queryInt(ctx.url, "limit", 50),
        offset: queryInt(ctx.url, "offset", 0),
        status: ctx.url.searchParams.get("status") || undefined,
        legacyId: ctx.url.searchParams.get("legacy_id") || undefined,
        includeDeleted: boolParam(ctx.url, "include_deleted"),
      };
      const result = await store.listBugs(projectId, filter);
      return { status: 200, body: { project: projectId, ...result, items: result.items.map(decorateBug) } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/bugs/by-legacy/:legacyId",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const bug = await store.getBugByLegacyId(projectId, ctx.params.legacyId);
      if (!bug) throw notFound("no bug with legacy_id " + ctx.params.legacyId + " in project " + projectId);
      return { status: 200, body: { project: projectId, bug: decorateBug(bug) } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/bugs/:id",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const bug = await store.getBug(projectId, requireUuid(ctx.params.id, "id"));
      if (!bug) throw notFound("bug not found");
      return { status: 200, body: { project: projectId, bug: decorateBug(bug) } };
    },
  });

  routes.push({
    method: "POST",
    pattern: "/api/v1/bugs",
    async handler(ctx) {
      auth.requireRole(ctx.auth, "writer");
      const projectId = resolve(ctx);
      const input = validateBugInput(ctx.body);
      if (input.legacyId) {
        const existing = await store.getBugByLegacyId(projectId, input.legacyId);
        if (existing) {
          await audit(ctx, { projectId, action: "bug.create.idempotent", entity: "bug", entityId: existing.id, details: { legacyId: input.legacyId } });
          return { status: 200, body: { project: projectId, created: false, idempotent: true, bug: decorateBug(existing) } };
        }
      }
      const result = await store.createBug(projectId, input, ctx.auth.author);
      if (result.legacyConflict && result.legacyConflict.existingBugId) {
        const existing = await store.getBug(projectId, result.legacyConflict.existingBugId);
        if (existing) {
          await audit(ctx, { projectId, action: "bug.create.idempotent", entity: "bug", entityId: existing.id, details: { legacyId: input.legacyId, race: true } });
          return { status: 200, body: { project: projectId, created: false, idempotent: true, bug: decorateBug(existing) } };
        }
      }
      await audit(ctx, {
        projectId,
        action: "bug.create",
        entity: "bug",
        entityId: result.bug.id,
        after: result.bug,
        details: result.legacyConflict ? { legacyConflict: result.legacyConflict } : {},
      });
      return { status: 201, body: { project: projectId, created: true, bug: decorateBug(result.bug) } };
    },
  });

  routes.push({
    method: "PATCH",
    pattern: "/api/v1/bugs/:id",
    async handler(ctx) {
      auth.requireRole(ctx.auth, "writer");
      const projectId = resolve(ctx);
      const id = requireUuid(ctx.params.id, "id");
      const ifMatchHeader = ctx.req.headers["if-match"];
      const versionHeader = ifMatchHeader ? String(ifMatchHeader).replace(/^W\//, "").replace(/"/g, "") : null;
      const expectedVersion =
        ctx.body.ifVersion !== undefined
          ? Number(ctx.body.ifVersion)
          : versionHeader !== null && versionHeader !== ""
            ? Number(versionHeader)
            : undefined;
      if (expectedVersion !== undefined && !Number.isFinite(expectedVersion)) throw badRequest("ifVersion must be a number");
      const current = await store.getBug(projectId, id);
      if (!current) throw notFound("bug not found");
      const patch = validateBugInput(ctx.body);
      const statusChanged = patch.status !== undefined && patch.status !== current.status;
      const historyNote = optionalString(ctx.body.historyNote, "historyNote", { maxLength: 400 }) || "";
      if (Object.prototype.hasOwnProperty.call(patch, "payload")) {
        patch.payload = mergePayload(current.payload, patch.payload);
      }
      if (statusChanged || historyNote) {
        const basePayload = isPlainObject(patch.payload) ? patch.payload : (isPlainObject(current.payload) ? { ...current.payload } : {});
        const history = Array.isArray(basePayload.history) ? basePayload.history.slice() : [];
        const note = historyNote || (patch.resolution || "");
        history.push("- [" + nowIso() + "] " + (patch.status || current.status) + (note ? ": " + note : ""));
        patch.payload = { ...basePayload, history };
      }
      const result = await store.updateBug(projectId, id, patch, expectedVersion, ctx.auth.author);
      if (result.found === false) throw notFound("bug not found");
      if (result.conflict) {
        await audit(ctx, {
          projectId,
          action: "bug.update",
          entity: "bug",
          entityId: id,
          outcome: "conflict",
          statusCode: 409,
          before: result.current,
          details: { expectedVersion: expectedVersion === undefined ? null : expectedVersion },
        });
        return {
          status: 409,
          body: {
            error: {
              code: "version_conflict",
              message: "bug version does not match (optimistic lock)",
              request_id: ctx.requestId,
              current: decorateBug(result.current),
            },
          },
        };
      }
      await audit(ctx, { projectId, action: "bug.update", entity: "bug", entityId: id, before: result.before, after: result.bug });
      if (statusChanged) {
        await audit(ctx, {
          projectId,
          action: "bug.status_change",
          entity: "bug",
          entityId: id,
          details: { from: result.before.status, to: result.bug.status },
        });
      }
      return { status: 200, body: { project: projectId, bug: decorateBug(result.bug) } };
    },
  });

  // ── reports / links ───────────────────────────────────────────────────────
  routes.push({
    method: "GET",
    pattern: "/api/v1/reports",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const result = await store.listReports(projectId, {
        kind: ctx.url.searchParams.get("kind") || undefined,
        limit: queryInt(ctx.url, "limit", 50),
        offset: queryInt(ctx.url, "offset", 0),
      });
      return { status: 200, body: { project: projectId, ...result } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/reports/:id",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const result = await store.getReport(projectId, requireUuid(ctx.params.id, "id"));
      if (!result) throw notFound("report not found");
      return { status: 200, body: { project: projectId, ...result } };
    },
  });

  routes.push({
    method: "POST",
    pattern: "/api/v1/reports",
    async handler(ctx) {
      auth.requireRole(ctx.auth, "writer");
      const projectId = resolve(ctx);
      const files = Array.isArray(ctx.body.files) ? ctx.body.files : [];
      for (const file of files) {
        requireString(file.path, "files[].path", { maxLength: 512 });
        const sha = requireString(file.sha256, "files[].sha256", { maxLength: 64 });
        if (!/^[0-9a-f]{64}$/i.test(sha)) throw badRequest("files[].sha256 must be a 64-char hex digest");
      }
      const result = await store.createReport(
        projectId,
        {
          id: ctx.body.id === undefined ? undefined : requireUuid(ctx.body.id, "id"),
          ifAbsent: ctx.req.headers["if-none-match"] === "*" && ctx.body.id !== undefined,
          kind: optionalString(ctx.body.kind, "kind", { maxLength: 64 }) || "report",
          title: optionalString(ctx.body.title, "title", { maxLength: 400 }),
          payload: ctx.body.payload && typeof ctx.body.payload === "object" ? ctx.body.payload : {},
          files: files.map((file) => ({
            path: file.path,
            sha256: String(file.sha256).toLowerCase(),
            sizeBytes: Number(file.sizeBytes || file.size || 0),
            role: REPO_RELS.has(file.role) ? file.role : "evidence",
          })),
        },
        ctx.auth.author,
      );
      if (result.conflict) throw new ApiError(409, "report_identity_conflict", "report identity already exists");
      await audit(ctx, { projectId, action: "report.create", entity: "report", entityId: result.report.id, after: result.report, details: { files: result.files.length } });
      return { status: 201, body: { project: projectId, ...result } };
    },
  });

  routes.push({
    method: "PUT",
    pattern: "/api/v1/reports/:id/files",
    rawBody: true,
    async handler(ctx) {
      auth.requireRole(ctx.auth, "writer");
      const projectId = resolve(ctx);
      const reportId = requireUuid(ctx.params.id, "id");
      const report = await store.getReport(projectId, reportId);
      if (!report) throw notFound("report not found");
      const relPath = normalizeReportPath(ctx.url.searchParams.get("path"));
      const roleParam = ctx.url.searchParams.get("role");
      const role = REPO_RELS.has(roleParam) ? roleParam : inferReportRole(relPath);
      const buffer = ctx.rawBody || Buffer.alloc(0);
      if (buffer.length === 0) throw badRequest("empty upload body: send raw file bytes as the request body");
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      if (report.report.kind === "performance-run") {
        const expected = report.report.payload?.files?.find((file) => file.path === relPath);
        if (!expected || expected.sha256 !== sha256 || expected.size !== buffer.length) {
          throw new ApiError(409, "artifact_manifest_conflict", "performance bytes must match the immutable manifest");
        }
      }
      const existing = (await store.listReportFiles(reportId)).find((file) => file.path === relPath);
      const objectStore = await env.getObjectStore();
      // Idempotent metadata also needs durable bytes (for example after restoring
      // a database ahead of its object-store backup). A repeat PUT repairs a
      // missing object while retaining the original file identity and refcount.
      await objectStore.putBuffer(sha256, buffer);
      if (existing && existing.sha256 === sha256 && Number(existing.sizeBytes) === buffer.length) {
        await audit(ctx, { projectId, action: "report.file.upload", entity: "report_file", entityId: reportId + ":" + relPath, details: { path: relPath, sha256, created: false } });
        return { status: 200, body: { project: projectId, reportId, file: existing, created: false } };
      }
      const bucket = objectStore.driver === "fs" ? "vault-fs" : "vault";
      await store.upsertBlob({ sha256, sizeBytes: buffer.length, bucket, objectKey: objectStore.keyFor(sha256), contentType: mimeForPath(relPath) });
      const file = await store.addReportFile(reportId, { path: relPath, sha256, sizeBytes: buffer.length, role });
      await audit(ctx, { projectId, action: "report.file.upload", entity: "report_file", entityId: reportId + ":" + relPath, details: { path: relPath, sha256, sizeBytes: buffer.length, role, created: true } });
      return { status: 201, body: { project: projectId, reportId, file, created: true } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/reports/:id/file",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const reportId = requireUuid(ctx.params.id, "id");
      const report = await store.getReport(projectId, reportId);
      if (!report) throw notFound("report not found");
      const relPath = normalizeReportPath(ctx.url.searchParams.get("path"));
      const file = (report.files || []).find((entry) => entry.path === relPath);
      if (!file) throw notFound("report file not found");
      const blob = await store.getBlob(file.sha256);
      if (!blob) throw notFound("blob not found");
      const objectStore = await env.getObjectStore();
      const buffer = await objectStore.readBuffer(file.sha256);
      if (createHash("sha256").update(buffer).digest("hex") !== file.sha256) {
        throw new ApiError(503, "object_checksum_mismatch", "stored object failed integrity verification");
      }
      return {
        status: 200,
        rawBody: buffer,
        contentType: mimeForPath(relPath),
        headers: { "x-vault-content-sha256": file.sha256, "cache-control": "no-store" },
      };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/links",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const bugId = ctx.url.searchParams.get("bug_id");
      const reportId = ctx.url.searchParams.get("report_id");
      const links = await store.listLinks(projectId, {
        bugId: bugId ? requireUuid(bugId, "bug_id") : undefined,
        reportId: reportId ? requireUuid(reportId, "report_id") : undefined,
      });
      return { status: 200, body: { project: projectId, items: links, total: links.length } };
    },
  });

  routes.push({
    method: "POST",
    pattern: "/api/v1/links",
    async handler(ctx) {
      auth.requireRole(ctx.auth, "writer");
      const projectId = resolve(ctx);
      const input = {
        reportId: requireUuid(ctx.body.reportId, "reportId"),
        bugId: requireUuid(ctx.body.bugId, "bugId"),
        role: REPO_RELS.has(ctx.body.role) ? ctx.body.role : "evidence",
      };
      const result = await store.createLink(projectId, input);
      await audit(ctx, {
        projectId,
        action: "report.link",
        entity: "report_link",
        entityId: input.reportId + "->" + input.bugId,
        after: result.link,
        details: { created: result.created },
      });
      return { status: result.created ? 201 : 200, body: { project: projectId, ...result } };
    },
  });

  routes.push({
    method: "DELETE",
    pattern: "/api/v1/links",
    async handler(ctx) {
      auth.requireRole(ctx.auth, "writer");
      const projectId = resolve(ctx);
      const input = {
        reportId: requireUuid(ctx.body.reportId, "reportId"),
        bugId: requireUuid(ctx.body.bugId, "bugId"),
        role: REPO_RELS.has(ctx.body.role) ? ctx.body.role : "evidence",
      };
      const removed = await store.deleteLink(input);
      if (removed) await audit(ctx, { projectId, action: "report.unlink", entity: "report_link", entityId: input.reportId + "->" + input.bugId });
      return { status: removed ? 200 : 404, body: { project: projectId, removed } };
    },
  });

  // ── ingest jobs ───────────────────────────────────────────────────────────
  routes.push({
    method: "POST",
    pattern: "/api/v1/ingest",
    async handler(ctx) {
      auth.requireRole(ctx.auth, "writer");
      const projectId = resolve(ctx);
      const input = {
        kind: optionalString(ctx.body.kind, "kind", { maxLength: 64 }) || "report",
        sourcePath: requireString(ctx.body.sourcePath, "sourcePath", { maxLength: 1024 }),
        contentSha256: requireString(ctx.body.contentSha256, "contentSha256", { maxLength: 64 }),
        bytesTotal: Number(ctx.body.bytesTotal || 0),
        filesTotal: Number(ctx.body.filesTotal || 0),
      };
      if (!/^[0-9a-f]{64}$/i.test(input.contentSha256)) throw badRequest("contentSha256 must be a 64-char hex digest");
      const result = await store.createIngestJob(projectId, input);
      await audit(ctx, {
        projectId,
        action: "ingest.create",
        entity: "ingest_job",
        entityId: result.job.id,
        details: { created: result.created, sourcePath: input.sourcePath },
      });
      return { status: result.created ? 201 : 200, body: { project: projectId, ...result } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/ingest/:id",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const job = await store.getIngestJob(requireUuid(ctx.params.id, "id"));
      if (!job || job.projectId !== projectId) throw notFound("ingest job not found");
      return { status: 200, body: { project: projectId, job } };
    },
  });

  // ── audit (docs/DATABASE.md §audit) ───────────────────────────────────────
  routes.push({
    method: "GET",
    pattern: "/api/v1/audit",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const result = await store.queryAudit(projectId, {
        limit: queryInt(ctx.url, "limit", 50),
        offset: queryInt(ctx.url, "offset", 0),
        action: ctx.url.searchParams.get("action") || undefined,
        actor: ctx.url.searchParams.get("actor") || undefined,
        entity: ctx.url.searchParams.get("entity") || undefined,
        entityId: ctx.url.searchParams.get("entity_id") || undefined,
        outcome: ctx.url.searchParams.get("outcome") || undefined,
        since: ctx.url.searchParams.get("since") || undefined,
        until: ctx.url.searchParams.get("until") || undefined,
        selfActor: ctx.auth.author,
      });
      return { status: 200, body: { project: projectId, ...result } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/audit/summary",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const summary = await store.auditSummary(projectId, {
        action: ctx.url.searchParams.get("action") || undefined,
        actor: ctx.url.searchParams.get("actor") || undefined,
        outcome: ctx.url.searchParams.get("outcome") || undefined,
        since: ctx.url.searchParams.get("since") || undefined,
        until: ctx.url.searchParams.get("until") || undefined,
        selfActor: ctx.auth.author,
      });
      return { status: 200, body: { project: projectId, ...summary } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/audit/:eventId",
    async handler(ctx) {
      const event = await store.getAuditEvent(requireUuid(ctx.params.eventId, "eventId"));
      if (!event) throw notFound("audit event not found");
      const actorMatch = event.actor === ctx.auth.author;
      const projectMatch = event.projectId ? ctx.auth.projects.includes(event.projectId) : false;
      if (!actorMatch && !projectMatch) throw notFound("audit event not found");
      return { status: 200, body: { event } };
    },
  });

  // ── migration ledger (docs/DATABASE.md §migration-ledger) ─────────────────
  routes.push({
    method: "GET",
    pattern: "/api/v1/migrations/status",
    async handler() {
      const status = await store.migrationStatusSnapshot();
      return { status: 200, body: { migrations: status } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/migrations/runs",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const result = await store.queryMigrationRuns({
        projectId,
        limit: queryInt(ctx.url, "limit", 20),
        offset: queryInt(ctx.url, "offset", 0),
        status: ctx.url.searchParams.get("status") || undefined,
        kind: ctx.url.searchParams.get("kind") || undefined,
      });
      return { status: 200, body: { project: projectId, ...result } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/migrations/runs/:id/items",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const run = await store.getMigrationRun(requireUuid(ctx.params.id, "id"));
      if (!run || run.projectId !== projectId) throw notFound("migration run not found");
      const items = await store.listMigrationItems(run.id);
      const limit = Math.min(Math.max(queryInt(ctx.url, "limit", 100), 1), 1000);
      const offset = Math.max(queryInt(ctx.url, "offset", 0), 0);
      return { status: 200, body: { project: projectId, runId: run.id, total: items.length, limit, offset, items: items.slice(offset, offset + limit) } };
    },
  });

  routes.push({
    method: "GET",
    pattern: "/api/v1/migrations/runs/:id",
    async handler(ctx) {
      const projectId = resolve(ctx);
      const run = await store.getMigrationRun(requireUuid(ctx.params.id, "id"));
      if (!run || run.projectId !== projectId) throw notFound("migration run not found");
      const itemCounters = await store.migrationItemCounters(run.id);
      const kindCounts = await store.migrationItemKindCounts(run.id);
      return { status: 200, body: { project: projectId, run, itemCounters, kindCounts } };
    },
  });

  // ── tokens (admin only) ───────────────────────────────────────────────────
  routes.push({
    method: "GET",
    pattern: "/api/v1/tokens",
    async handler(ctx) {
      auth.requireRole(ctx.auth, "admin");
      const tokens = await store.listTokens();
      return { status: 200, body: { items: tokens.map((token) => ({ ...token, tokenHash: undefined })), total: tokens.length } };
    },
  });

  routes.push({
    method: "POST",
    pattern: "/api/v1/tokens",
    async handler(ctx) {
      auth.requireRole(ctx.auth, "admin");
      const id = newTokenId();
      const secret = newSecret();
      const projects = Array.isArray(ctx.body.projects) ? ctx.body.projects : [];
      if (projects.length === 0) throw badRequest("projects must be a non-empty array");
      for (const project of projects) requireString(project, "projects[]", { maxLength: 64 });
      const role = ctx.body.role || "writer";
      if (!ROLES[role]) throw badRequest("role must be one of reader, writer, admin");
      const label = requireString(ctx.body.label, "label", { maxLength: 120 });
      const token = await store.createToken({
        id,
        label,
        tokenHash: sha256Hex(secret),
        projects,
        role,
        metadata: ctx.body.metadata && typeof ctx.body.metadata === "object" ? ctx.body.metadata : {},
      });
      await audit(ctx, { projectId: projects[0], action: "token.create", entity: "token", entityId: id, after: { id, label, projects, role } });
      return {
        status: 201,
        body: { token: formatToken(id, secret), id, label, projects: token.projects, role: token.role },
      };
    },
  });

  routes.push({
    method: "DELETE",
    pattern: "/api/v1/tokens/:id",
    async handler(ctx) {
      auth.requireRole(ctx.auth, "admin");
      const token = await store.revokeToken(requireString(ctx.params.id, "id", { maxLength: 64 }));
      if (!token) throw notFound("token not found");
      await audit(ctx, { action: "token.revoke", entity: "token", entityId: token.id });
      return { status: 200, body: { revoked: true, id: token.id, revokedAt: token.revokedAt } };
    },
  });

  return routes;
}

function matchRoute(routes, method, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const patternParts = route.pattern.split("/").filter(Boolean);
    if (patternParts.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      const pattern = patternParts[i];
      if (pattern.startsWith(":")) {
        params[pattern.slice(1)] = decodeURIComponent(parts[i]);
      } else if (pattern !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

export function createApp({ config, store, logger }) {
  const log = logger || createLogger({ level: config.logLevel, name: "vault" });
  const auth = createAuth({ store });
  const metrics = createMetrics();
  const startedAt = nowIso();
  let objectStorePromise = null;
  const getObjectStore = () => {
    if (!objectStorePromise) objectStorePromise = createObjectStore(config);
    return objectStorePromise;
  };
  const routes = buildRoutes(auth, store, config, metrics, log, { getObjectStore });

  const server = http.createServer(async (req, res) => {
    const requestId = req.headers["x-request-id"] ? String(req.headers["x-request-id"]) : newRequestId();
    const started = process.hrtime.bigint();
    let status = 500;
    let routeKey = req.method + " " + (req.url || "/");
    let ctx = null;
    try {
      if (req.method === "OPTIONS") {
        status = 204;
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
          "access-control-allow-headers": "authorization,x-vault-token,x-vault-project,x-request-id,content-type,if-match",
          "access-control-max-age": "600",
        });
        res.end();
        return;
      }
      const url = new URL(req.url || "/", "http://" + (req.headers.host || "vault.local"));
      const matched = matchRoute(routes, req.method, url.pathname);
      if (!matched) throw notFound("no route for " + req.method + " " + url.pathname);
      routeKey = req.method + " " + matched.route.pattern;
      let body = {};
      let rawBody = null;
      if (matched.route.rawBody) {
        rawBody = await readRawBody(req, { limit: config.maxUploadBytes });
      } else if (req.method === "DELETE") {
        body = await readJsonBody(req, { limit: config.maxBodyBytes }).catch(() => ({}));
      } else if (req.method !== "GET") {
        body = await readJsonBody(req, { limit: config.maxBodyBytes });
      }
      const authState = matched.route.public ? null : await auth.authenticate(req);
      if (authState) {
        const forged = detectForgedAuthor(req, body);
        if (forged) {
          await store
            .appendAudit({
              projectId: null,
              actor: authState.author,
              action: "auth.forged_author_rejected",
              outcome: "denied",
              statusCode: 403,
              details: { forgedBy: forged, path: url.pathname },
              requestId,
              remoteAddr: clientIp(req),
            })
            .catch(() => {});
          throw forbidden("author_forged", "author is derived from the token; client supplied " + forged);
        }
      }
      ctx = {
        req,
        res,
        url,
        params: matched.params,
        body,
        rawBody,
        requestId,
        auth: authState,
        store,
        config,
        metrics,
        logger: log,
        startedAt,
        projectHint: req.headers["x-vault-project"] ? String(req.headers["x-vault-project"]) : url.searchParams.get("project") || null,
      };
      const result = await matched.route.handler(ctx);
      status = result.status || 200;
      if (result.rawBody !== undefined) {
        res.writeHead(status, {
          "content-type": result.contentType || "application/octet-stream",
          "content-length": result.rawBody.length,
          ...(result.headers || {}),
        });
        res.end(result.rawBody);
      } else if (result.text !== undefined) {
        sendText(res, status, result.text, { "content-type": result.contentType || "text/plain; charset=utf-8" });
      } else {
        sendJson(res, status, result.body === undefined ? {} : result.body, result.headers || {});
      }
    } catch (error) {
      const apiError = error instanceof ApiError ? error : error;
      status = error instanceof ApiError ? error.status : 500;
      if (status === 500) log.error("request failed", { requestId, route: routeKey, error: String(error && error.stack ? error.stack : error) });
      if (status === 401 || status === 403) {
        try {
          await store.appendAudit({
            projectId: ctx ? ctx.projectHint || (ctx.params && ctx.params.project) || null : (matched && matched.params ? matched.params.project || null : null),
            actor: ctx && ctx.auth ? ctx.auth.author : "anonymous",
            action: "auth.denied",
            outcome: "denied",
            statusCode: status,
            details: { code: error instanceof ApiError ? error.code : "internal_error", path: req.url },
            requestId,
            remoteAddr: clientIp(req),
          });
        } catch {
          // audit is best effort on auth failures
        }
      }
      sendApiError(res, apiError, requestId);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      metrics.record(req.method, routeKey, status, durationMs);
      log.debug("request", { requestId, method: req.method, route: routeKey, status, durationMs: Number(durationMs.toFixed(2)) });
    }
  });

  return {
    server,
    store,
    metrics,
    routes,
    auth,
    startedAt,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.bind, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
