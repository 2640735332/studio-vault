import assert from "node:assert/strict";
import test from "node:test";
import { startTestApp, TOKEN_A } from "./helpers.mjs";

test("bug create/update with optimistic lock and 409 conflict", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const created = await app.request("POST", "/api/v1/bugs", {
    token: TOKEN_A,
    body: { legacyId: "12345678", title: "bug", status: "new", severity: "high", payload: { a: 1 } },
  });
  assert.equal(created.status, 201);
  const bug = created.json.bug;
  assert.equal(bug.version, 1);
  assert.equal(bug.projectId, "demo-project");
  assert.equal(bug.author, "token:dev-a");

  const updated = await app.request("PATCH", "/api/v1/bugs/" + bug.id, { token: TOKEN_A, body: { status: "triaged", ifVersion: 1 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.bug.version, 2);
  assert.equal(updated.json.bug.status, "triaged");
  assert.equal(updated.json.bug.updatedBy, "token:dev-a");

  const stale = await app.request("PATCH", "/api/v1/bugs/" + bug.id, { token: TOKEN_A, body: { status: "closed", ifVersion: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "version_conflict");
  assert.equal(stale.json.error.current.version, 2);

  const ifMatch = await app.request("PATCH", "/api/v1/bugs/" + bug.id, { token: TOKEN_A, body: { severity: "blocker" }, headers: { "if-match": "\"2\"" } });
  assert.equal(ifMatch.status, 200);
  assert.equal(ifMatch.json.bug.version, 3);

  const byLegacy = await app.request("GET", "/api/v1/bugs/by-legacy/12345678", { token: TOKEN_A });
  assert.equal(byLegacy.status, 200);
  assert.equal(byLegacy.json.bug.id, bug.id);

  const list = await app.request("GET", "/api/v1/bugs?status=fixed", { token: TOKEN_A });
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 0);

  const audit = await app.request("GET", "/api/v1/audit?limit=100", { token: TOKEN_A });
  const actions = audit.json.items.map((event) => event.action);
  assert.ok(actions.includes("bug.create"));
  assert.ok(actions.includes("bug.update"));
  const conflictEvent = audit.json.items.find((event) => event.action === "bug.update" && event.outcome === "conflict");
  assert.ok(conflictEvent, "409 must be audited");
  assert.equal(conflictEvent.statusCode, 409);
});

test("duplicate 8-digit legacy id is idempotent (200 existing bug, no duplicate row)", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const first = await app.request("POST", "/api/v1/bugs", { token: TOKEN_A, body: { legacyId: "87654321", title: "first" } });
  assert.equal(first.status, 201);
  assert.equal(first.json.created, true);
  const second = await app.request("POST", "/api/v1/bugs", { token: TOKEN_A, body: { legacyId: "87654321", title: "second" } });
  assert.equal(second.status, 200);
  assert.equal(second.json.created, false);
  assert.equal(second.json.idempotent, true);
  assert.equal(second.json.bug.id, first.json.bug.id);
  assert.equal(second.json.bug.title, "first");
  const lookup = await app.request("GET", "/api/v1/bugs/by-legacy/87654321", { token: TOKEN_A });
  assert.equal(lookup.json.bug.id, first.json.bug.id);
  const audit = await app.request("GET", "/api/v1/audit?limit=50", { token: TOKEN_A });
  const actions = audit.json.items.map((event) => event.action);
  assert.ok(actions.includes("bug.create"));
  assert.ok(actions.includes("bug.create.idempotent"));
});

test("reports, links and ingest idempotency", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const bug = await app.request("POST", "/api/v1/bugs", { token: TOKEN_A, body: { legacyId: "11112222", title: "bug" } });
  const sha = "a".repeat(64);
  const report = await app.request("POST", "/api/v1/reports", {
    token: TOKEN_A,
    body: { kind: "e2e", title: "run", files: [{ path: "run/report.md", sha256: sha, sizeBytes: 10 }] },
  });
  assert.equal(report.status, 201);
  assert.equal(report.json.files.length, 1);
  assert.equal(report.json.files[0].sha256, sha);
  const fetched = await app.request("GET", "/api/v1/reports/" + report.json.report.id, { token: TOKEN_A });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.files.length, 1);

  const link = await app.request("POST", "/api/v1/links", { token: TOKEN_A, body: { reportId: report.json.report.id, bugId: bug.json.bug.id, role: "evidence" } });
  assert.equal(link.status, 201);
  const links = await app.request("GET", "/api/v1/links?bug_id=" + bug.json.bug.id, { token: TOKEN_A });
  assert.equal(links.json.total, 1);

  const contentSha = "b".repeat(64);
  const ingest1 = await app.request("POST", "/api/v1/ingest", { token: TOKEN_A, body: { sourcePath: "game/reports/bugs/11112222", contentSha256: contentSha, kind: "bug" } });
  assert.equal(ingest1.status, 201);
  assert.equal(ingest1.json.created, true);
  const ingest2 = await app.request("POST", "/api/v1/ingest", { token: TOKEN_A, body: { sourcePath: "game/reports/bugs/11112222", contentSha256: contentSha, kind: "bug" } });
  assert.equal(ingest2.status, 200);
  assert.equal(ingest2.json.created, false);
  assert.equal(ingest2.json.job.id, ingest1.json.job.id);
  const job = await app.request("GET", "/api/v1/ingest/" + ingest1.json.job.id, { token: TOKEN_A });
  assert.equal(job.status, 200);
});

test("unknown routes are 404 and bad payloads are 400", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const notFound = await app.request("GET", "/api/v1/nope", { token: TOKEN_A });
  assert.equal(notFound.status, 404);
  const badSeverity = await app.request("POST", "/api/v1/bugs", { token: TOKEN_A, body: { severity: "apocalyptic" } });
  assert.equal(badSeverity.status, 400);
  const badJson = await fetch(app.baseUrl + "/api/v1/bugs", {
    method: "POST",
    headers: { authorization: "Bearer " + TOKEN_A, "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(badJson.status, 400);
});
