import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startTestApp, silentLogger, TOKEN_A } from "./helpers.mjs";
import { MemoryVaultStore } from "../src/store/memory.mjs";
import { MinioObjectStore, buildCanonicalRequest, signRequest } from "../src/store/minio.mjs";

const MIGRATIONS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "migrations");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

// AWS SigV4 reference vectors (AWS docs "Signature Version 4 test suite": GET object + PUT object).
const AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const AWS_DATE = new Date("2013-05-24T00:00:00.000Z");

test("MinIO/S3 SigV4 matches the AWS reference vectors", () => {
  const getSigned = signRequest({
    method: "GET",
    path: "/test.txt",
    headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9" },
    payloadHash: EMPTY_SHA256,
    accessKey: AWS_ACCESS_KEY,
    secretKey: AWS_SECRET_KEY,
    region: "us-east-1",
    service: "s3",
    now: AWS_DATE,
  });
  assert.equal(getSigned.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(getSigned.scope, "20130524/us-east-1/s3/aws4_request");
  assert.equal(
    getSigned.canonicalRequest,
    [
      "GET",
      "/test.txt",
      "",
      "host:examplebucket.s3.amazonaws.com",
      "range:bytes=0-9",
      "x-amz-content-sha256:" + EMPTY_SHA256,
      "x-amz-date:20130524T000000Z",
      "",
      "host;range;x-amz-content-sha256;x-amz-date",
      EMPTY_SHA256,
    ].join("\n"),
  );
  assert.equal(
    getSigned.stringToSign,
    [
      "AWS4-HMAC-SHA256",
      "20130524T000000Z",
      "20130524/us-east-1/s3/aws4_request",
      "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
    ].join("\n"),
  );

  const body = Buffer.from("Welcome to Amazon S3.");
  const putSigned = signRequest({
    method: "PUT",
    path: "/test$file.text",
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      date: "Fri, 24 May 2013 00:00:00 GMT",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
    payloadHash: sha(body),
    accessKey: AWS_ACCESS_KEY,
    secretKey: AWS_SECRET_KEY,
    region: "us-east-1",
    service: "s3",
    now: AWS_DATE,
  });
  assert.equal(sha(body), "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  assert.equal(putSigned.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  assert.match(putSigned.canonicalUri, /%24/);
  assert.ok(putSigned.headers.authorization.startsWith("AWS4-HMAC-SHA256 Credential=" + AWS_ACCESS_KEY + "/20130524/us-east-1/s3/aws4_request"));
});

test("MinIO driver builds path-style content-addressed keys without network", () => {
  const store = new MinioObjectStore({
    minio: { endpoint: "http://127.0.0.1:9000", bucket: "vault", user: "vault", password: "secret", prefix: "objects" },
  });
  assert.equal(store.driver, "minio");
  const hash = "ab".repeat(32);
  assert.equal(store.keyFor(hash), "objects/ab/ab/" + hash);
  assert.equal(store.objectPath(store.keyFor(hash)), "/vault/objects/ab/ab/" + hash);
  const unsigned = buildCanonicalRequest({
    method: "GET",
    path: "/vault/objects/ab/ab/" + hash,
    query: { "list-type": "2", prefix: "ab/" },
    headers: { host: "127.0.0.1:9000" },
    payloadHash: EMPTY_SHA256,
  });
  assert.match(unsigned.canonicalRequest, /^GET\n\/vault\/objects\/ab\/ab\//);
  assert.equal(unsigned.canonicalQuery, "list-type=2&prefix=ab%2F");
});

test("audit query API supports filters, pagination, summary and per-event lookup", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const ids = [];
  for (const action of ["bug.create", "bug.update", "bug.update", "report.create"]) {
    const entry = await app.store.appendAudit({ projectId: "demo-project", actor: "token:dev-a", action, entity: "bug", entityId: "x", outcome: "ok" });
    ids.push(entry.eventId);
  }
  await app.store.appendAudit({ projectId: "demo-b", actor: "token:dev-b", action: "bug.create", entity: "bug", outcome: "ok" });

  const filtered = await app.request("GET", "/api/v1/audit?action=bug.update&limit=1&offset=0", { token: TOKEN_A });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.json.items.length, 1);
  assert.equal(filtered.json.total, 2);
  assert.ok(filtered.json.items.every((item) => item.action === "bug.update"));
  const secondPage = await app.request("GET", "/api/v1/audit?action=bug.update&limit=1&offset=1", { token: TOKEN_A });
  assert.equal(secondPage.json.items.length, 1);
  assert.notEqual(secondPage.json.items[0].eventId, filtered.json.items[0].eventId);

  const summary = await app.request("GET", "/api/v1/audit/summary", { token: TOKEN_A });
  assert.equal(summary.status, 200);
  assert.equal(summary.json.total, 4);
  assert.equal(summary.json.byAction.find((row) => row.action === "bug.update").count, 2);

  const detail = await app.request("GET", "/api/v1/audit/" + ids[0], { token: TOKEN_A });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.event.eventId, ids[0]);

  const crossProject = await app.request("GET", "/api/v1/audit/" + (await app.store.appendAudit({ projectId: "demo-b", actor: "token:dev-b", action: "x" })).eventId, { token: TOKEN_A });
  assert.equal(crossProject.status, 404);
});

test("migration ledger API lists runs, status, items and counters", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const run = await app.store.createMigrationRun({ projectId: "demo-project", kind: "bug-package-import", source: "test", mode: "execute", status: "running", notes: {} });
  await app.store.insertMigrationItem({ runId: run.id, projectId: "demo-project", kind: "package", entityId: crypto.randomUUID(), sourcePath: "w/game/reports/bugs/a", contentSha256: "a".repeat(64), legacyId: "12345678", extra: { filesTotal: 2, bytesTotal: 100 } });
  await app.store.insertMigrationItem({ runId: run.id, projectId: "demo-project", kind: "package", entityId: crypto.randomUUID(), sourcePath: "w/game/reports/bugs/b", contentSha256: "b".repeat(64), legacyId: null, extra: { filesTotal: 1, bytesTotal: 50 } });
  await app.store.finishMigrationRun(run.id, { status: "completed", counters: { imported: 2 } });

  const status = await app.request("GET", "/api/v1/migrations/status", { token: TOKEN_A });
  assert.equal(status.status, 200);
  assert.equal(status.json.migrations.applied, 8);
  assert.equal(status.json.migrations.pending, 0);

  const runs = await app.request("GET", "/api/v1/migrations/runs", { token: TOKEN_A });
  assert.equal(runs.status, 200);
  assert.equal(runs.json.total, 1);
  assert.equal(runs.json.items[0].id, run.id);
  assert.equal(runs.json.items[0].status, "completed");

  const detail = await app.request("GET", "/api/v1/migrations/runs/" + run.id, { token: TOKEN_A });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.itemCounters.items, 2);
  assert.equal(detail.json.itemCounters.files, 3);
  assert.deepEqual(detail.json.kindCounts, [{ kind: "package", count: 2 }]);

  const items = await app.request("GET", "/api/v1/migrations/runs/" + run.id + "/items?limit=1&offset=1", { token: TOKEN_A });
  assert.equal(items.status, 200);
  assert.equal(items.json.total, 2);
  assert.equal(items.json.items.length, 1);

  const cross = await app.request("GET", "/api/v1/migrations/runs/" + (await app.store.createMigrationRun({ projectId: "demo-b", kind: "x", source: "t", mode: "execute", status: "running" })).id, { token: TOKEN_A });
  assert.equal(cross.status, 404);
});

test("retention policy: archive, expire with open-bug exemption, audit/ingest cleanup, blob GC", async () => {
  const config = { migrationsDir: MIGRATIONS_DIR, devSeed: false, devProjects: [], devTokens: [] };
  const store = new MemoryVaultStore(config, silentLogger);
  await store.init();
  await store.ensureProject("p", "p");
  const daysAgo = (days) => new Date(Date.now() - days * 86400 * 1000).toISOString();

  const oldLinked = await store.createReport("p", { kind: "bug-package", title: "old-linked", files: [] }, "token:t");
  const oldFree = await store.createReport("p", { kind: "bug-package", title: "old-free", files: [] }, "token:t");
  const recent = await store.createReport("p", { kind: "bug-package", title: "recent", files: [] }, "token:t");
  store.reports.get(oldLinked.report.id).createdAt = daysAgo(800);
  store.reports.get(oldFree.report.id).createdAt = daysAgo(400);
  store.reports.get(recent.report.id).createdAt = daysAgo(10);

  const openBug = await store.createBug("p", { legacyId: "11112222", title: "open bug", status: "new" }, "token:t");
  await store.createLink("p", { reportId: oldLinked.report.id, bugId: openBug.bug.id, role: "evidence" });

  const candidates = await store.retentionCandidates({ projectId: "p", reportArchiveDays: 365, reportRetainDays: 365, auditDays: 180, ingestDays: 90 });
  assert.equal(candidates.archiveReports, 2);
  assert.equal(candidates.expireReports, 1, "old report linked to an open bug must be exempt");

  const blobSha = "c".repeat(64);
  // Simulate a blob row left behind at refcount 0 (PG keeps the row until GC; the fs driver
  // deletes the object file only through this retention job).
  store.blobs.set(blobSha, {
    sha256: blobSha,
    sizeBytes: 10,
    bucket: "vault-fs",
    objectKey: "cc/cc/" + blobSha,
    refcount: 0,
    storageTier: "hot",
    contentType: null,
    createdAt: daysAgo(2),
  });
  const garbage = await store.listGarbageBlobs({ blobGraceHours: 1 });
  assert.equal(garbage.length, 1);
  assert.equal(await store.deleteBlobRow(blobSha), true);

  await store.appendAudit({ projectId: "p", actor: "token:t", action: "old.event" });
  store.auditEvents[store.auditEvents.length - 1].createdAt = daysAgo(200);
  await store.appendAudit({ projectId: "p", actor: "token:t", action: "new.event" });
  const ingest = await store.createIngestJob("p", { kind: "report", sourcePath: "a", contentSha256: "d".repeat(64) });
  await store.updateIngestJob(ingest.job.id, { status: "succeeded" });
  store.ingestJobs.get(ingest.job.id).updatedAt = daysAgo(100);

  assert.equal(await store.applyArchiveReports({ projectId: "p", reportArchiveDays: 365 }), 2);
  assert.equal(store.reports.get(oldFree.report.id).storageTier, "cold");
  assert.equal(store.reports.get(recent.report.id).storageTier, "hot");
  assert.equal(await store.applyExpireReports({ projectId: "p", reportRetainDays: 365 }), 1);
  assert.ok(store.reports.get(oldFree.report.id).deletedAt, "expired report soft-deleted");
  assert.equal(store.reports.get(oldLinked.report.id).deletedAt, null, "open-bug-linked report stays");
  const audit = await store.applyExpireAudit({ projectId: "p", auditDays: 180 });
  assert.equal(audit.deletedRows, 1);
  assert.equal(await store.applyExpireIngestJobs({ projectId: "p", ingestDays: 90 }), 1);
  await store.close();
});
