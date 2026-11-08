import assert from "node:assert/strict";
import test from "node:test";
import { startTestApp, TOKEN_A, TOKEN_B, TOKEN_MULTI } from "./helpers.mjs";

test("health endpoint exposes version/projects/usage/queue and reports storage driver", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const response = await app.request("GET", "/api/v1/health");
  assert.equal(response.status, 200);
  assert.equal(response.json.service, "vault");
  assert.equal(response.json.apiVersion, "v1");
  assert.match(response.json.version, /^\d+\.\d+\.\d+$/);
  assert.equal(response.json.storage.driver, "memory");
  assert.equal(response.json.status, "degraded");
  assert.ok(response.json.degradedReasons.includes("non_durable_store"));
  assert.equal(typeof response.json.projects.total, "number");
  assert.equal(typeof response.json.usage.bugs, "number");
  assert.equal(typeof response.json.queue.total, "number");
  assert.ok(response.json.migrations.applied >= 5);
  assert.equal(response.json.migrations.pending, 0);
  const strict = await app.request("GET", "/api/v1/health?strict=1");
  assert.equal(strict.status, 503);
});

test("metrics endpoint is scrapeable without auth", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  await app.request("GET", "/api/v1/health");
  const response = await app.request("GET", "/api/v1/metrics");
  assert.equal(response.status, 200);
  assert.match(response.text, /vault_http_requests_total/);
  assert.match(response.text, /vault_process_uptime_seconds/);
});

test("missing/malformed tokens are 401", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const missing = await app.request("GET", "/api/v1/projects");
  assert.equal(missing.status, 401);
  const malformed = await app.request("GET", "/api/v1/projects", { token: "not-a-vault-token" });
  assert.equal(malformed.status, 401);
  const unknown = await app.request("GET", "/api/v1/projects", { token: "vt_unknown0_abcdefghijklmnop" });
  assert.equal(unknown.status, 401);
});

test("token scope: project A token cannot read project B (403) and audit records it", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const own = await app.request("GET", "/api/v1/projects", { token: TOKEN_A });
  assert.equal(own.status, 200);
  assert.deepEqual(own.json.items.map((project) => project.id), ["demo-project"]);

  const cross = await app.request("GET", "/api/v1/projects/demo-b", { token: TOKEN_A });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.code, "project_forbidden");

  const crossQuery = await app.request("GET", "/api/v1/bugs?project=demo-b", { token: TOKEN_A });
  assert.equal(crossQuery.status, 403);

  const reverse = await app.request("GET", "/api/v1/projects/demo-project", { token: TOKEN_B });
  assert.equal(reverse.status, 403);

  const audit = await app.request("GET", "/api/v1/audit?limit=100", { token: TOKEN_A });
  assert.equal(audit.status, 200);
  const denied = audit.json.items.filter((event) => event.action === "auth.denied");
  assert.ok(denied.length >= 3);
  // project-scoped denials from other tokens are visible in the project audit view,
  // while the caller's own denials are always visible (actor scope).
  assert.ok(denied.some((event) => event.actor === "token:dev-a"));
  assert.ok(denied.every((event) => String(event.actor).startsWith("token:")));
});

test("multi-project token must name the project; scoped project resolves implicitly", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const ambiguous = await app.request("GET", "/api/v1/bugs", { token: TOKEN_MULTI });
  assert.equal(ambiguous.status, 400);
  const explicit = await app.request("GET", "/api/v1/bugs", { token: TOKEN_MULTI, headers: { "x-vault-project": "demo-b" } });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.json.project, "demo-b");
});

test("client-supplied author is rejected and audited (author is derived from token)", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const body = await app.request("POST", "/api/v1/bugs", { token: TOKEN_A, body: { title: "x", author: "someone-else" } });
  assert.equal(body.status, 403);
  assert.equal(body.json.error.code, "author_forged");
  const header = await app.request("POST", "/api/v1/bugs", { token: TOKEN_A, headers: { "x-vault-author": "someone-else" }, body: { title: "x" } });
  assert.equal(header.status, 403);
  const audit = await app.request("GET", "/api/v1/audit?limit=100", { token: TOKEN_A });
  const forged = audit.json.items.filter((event) => event.action === "auth.forged_author_rejected");
  assert.ok(forged.length >= 2);
});

test("admin can issue a scoped token, and revoking it invalidates access", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const created = await app.request("POST", "/api/v1/tokens", { token: TOKEN_A, body: { label: "temp", projects: ["demo-b"], role: "writer" } });
  assert.equal(created.status, 201);
  const scoped = await app.request("GET", "/api/v1/projects", { token: created.json.token });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.json.items.map((project) => project.id), ["demo-b"]);
  const cross = await app.request("GET", "/api/v1/projects/demo-project", { token: created.json.token });
  assert.equal(cross.status, 403);
  const revoke = await app.request("DELETE", "/api/v1/tokens/" + created.json.id, { token: TOKEN_A });
  assert.equal(revoke.status, 200);
  const after = await app.request("GET", "/api/v1/projects", { token: created.json.token });
  assert.equal(after.status, 401);
});

test("readers cannot write", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const created = await app.request("POST", "/api/v1/tokens", { token: TOKEN_A, body: { label: "reader", projects: ["demo-project"], role: "reader" } });
  assert.equal(created.status, 201);
  const write = await app.request("POST", "/api/v1/bugs", { token: created.json.token, body: { title: "nope" } });
  assert.equal(write.status, 403);
  assert.equal(write.json.error.code, "insufficient_role");
  const read = await app.request("GET", "/api/v1/bugs", { token: created.json.token });
  assert.equal(read.status, 200);
});
