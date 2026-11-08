import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { startTestApp, TOKEN_A, TOKEN_B } from "./helpers.mjs";

async function uploadFile(app, reportId, relPath, bytes, token, role) {
  const query = "?path=" + encodeURIComponent(relPath) + (role ? "&role=" + encodeURIComponent(role) : "");
  const response = await fetch(app.baseUrl + "/api/v1/reports/" + reportId + "/files" + query, {
    method: "PUT",
    headers: { authorization: "Bearer " + token, "content-type": "application/octet-stream" },
    body: bytes,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text };
}

async function downloadFile(app, reportId, relPath, token) {
  const response = await fetch(app.baseUrl + "/api/v1/reports/" + reportId + "/file?path=" + encodeURIComponent(relPath), {
    headers: { authorization: "Bearer " + token },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, buffer, headers: response.headers };
}

test("repeat PUT restores missing object bytes and GET rejects corrupt storage",async t=>{
  const app=await startTestApp();t.after(()=>app.close());
  const created=await app.request('POST','/api/v1/reports',{token:TOKEN_A,body:{kind:'workspace-archive',title:'durability'}});
  const id=created.json.report.id,bytes=crypto.randomBytes(30000),sha=crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal((await uploadFile(app,id,'data.bin',bytes,TOKEN_A)).status,201);
  const filename=path.join(app.config.objectsDir,sha.slice(0,2),sha.slice(2,4),sha);
  fs.unlinkSync(filename);
  assert.equal((await uploadFile(app,id,'data.bin',bytes,TOKEN_A)).status,200);
  assert.deepEqual((await downloadFile(app,id,'data.bin',TOKEN_A)).buffer,bytes);
  assert.equal((await app.store.listReportFiles(id)).length,1);
  fs.writeFileSync(filename,Buffer.alloc(bytes.length));
  assert.equal((await downloadFile(app,id,'data.bin',TOKEN_A)).status,503);
});

test("direct report: extended payload round-trips and dataGaps are computed", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const payload = {
    description: "演示界面位置偏移",
    build: { commit: "33ed4e9a6", branch: "feat/game-001", version: "0.1.0", engine: { name: "Godot", version: "4.5-stable" }, os: { name: "Windows", version: "10.0" }, hw: { gpu: "GPU-0", driver: "610.88" } },
    steps: [{ id: "1", text: "打开菜单", expect: "菜单出现" }],
    worldState: { seed: "123456", slot: "save_01", chunk: { x: 61, y: 26 }, time: { hour: 9.2 } },
    reproRate: { frequency: "always", attempts: 3 },
    reporter: { id: "tester-01", source: "f3" },
    caseContext: { case_id: "demo-case-1", checkpoint: true, assertions: ["ok=True"], expected: { fr: "REQ-01", ac: "PASS" } },
    domain: "demo",
  };
  const created = await app.request("POST", "/api/v1/bugs", {
    token: TOKEN_A,
    body: {
      legacyId: "99001122",
      title: "演示界面位置偏移",
      status: "new",
      severity: "medium",
      priority: "P2",
      branch: "feat/demo-001",
      commitSha: "33ed4e9a6",
      sourceTrack: "track-demo-1",
      payload,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.created, true);
  const bug = created.json.bug;
  assert.equal(bug.priority, "P2");
  assert.equal(bug.branch, "feat/demo-001");
  assert.equal(bug.commitSha, "33ed4e9a6");
  assert.equal(bug.sourceTrack, "track-demo-1");
  assert.equal(bug.payload.build.commit, "33ed4e9a6");
  assert.deepEqual(bug.dataGaps, []);
  const fetched = await app.request("GET", "/api/v1/bugs/by-legacy/99001122", { token: TOKEN_A });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.bug.payload.reproRate.frequency, "always");
  assert.equal(fetched.json.bug.payload.caseContext.checkpoint, true);
  assert.deepEqual(fetched.json.bug.dataGaps, []);
  const list = await app.request("GET", "/api/v1/bugs?status=new", { token: TOKEN_A });
  assert.equal(list.json.items[0].dataGaps.length, 0);
  const badPriority = await app.request("POST", "/api/v1/bugs", { token: TOKEN_A, body: { legacyId: "99001123", title: "bad", priority: "P9" } });
  assert.equal(badPriority.status, 400);
  const badCommit = await app.request("POST", "/api/v1/bugs", { token: TOKEN_A, body: { legacyId: "99001124", title: "bad", commitSha: "not-a-sha" } });
  assert.equal(badCommit.status, 400);
});

test("direct report: sparse bug exposes dataGaps for missing fields", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const created = await app.request("POST", "/api/v1/bugs", { token: TOKEN_A, body: { legacyId: "99002211", title: "sparse", payload: { description: "only text" } } });
  assert.equal(created.status, 201);
  const gaps = created.json.bug.dataGaps;
  for (const key of ["branch", "commitSha", "build", "steps", "worldState", "reproRate", "reporter", "caseContext", "sourceTrack", "priority"]) {
    assert.ok(gaps.includes(key), "expected dataGap " + key + " in " + JSON.stringify(gaps));
  }
});

test("direct report: PATCH merges payload shallowly, change status + verification, keeps history", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const created = await app.request("POST", "/api/v1/bugs", {
    token: TOKEN_A,
    body: { legacyId: "99003311", title: "patch me", payload: { description: "d", build: { commit: "abc1234" } } },
  });
  const bug = created.json.bug;
  const patched = await app.request("PATCH", "/api/v1/bugs/" + bug.id, {
    token: TOKEN_A,
    body: {
      status: "fixed",
      priority: "P1",
      assignee: "dev-a",
      historyNote: "fixed by abc1234",
      payload: { verification: { result: "fixed", commit: "abc1234", commands: ["node --test"] } },
      ifVersion: 1,
    },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.bug.status, "fixed");
  assert.equal(patched.json.bug.priority, "P1");
  assert.equal(patched.json.bug.payload.build.commit, "abc1234", "shallow merge keeps build");
  assert.equal(patched.json.bug.payload.verification.result, "fixed");
  assert.ok(patched.json.bug.payload.history.some((line) => line.includes("fixed")), "history appended");
  assert.equal(patched.json.bug.version, 2);
  const conflict = await app.request("PATCH", "/api/v1/bugs/" + bug.id, { token: TOKEN_A, body: { status: "closed", ifVersion: 1 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "version_conflict");
  assert.equal(conflict.json.error.current.version, 2);
  const audit = await app.request("GET", "/api/v1/audit?limit=100", { token: TOKEN_A });
  assert.ok(audit.json.items.some((event) => event.action === "bug.status_change"));
});

test("direct report: evidence upload + download + idempotent re-upload + audit", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const bug = await app.request("POST", "/api/v1/bugs", { token: TOKEN_A, body: { legacyId: "99004411", title: "evidence" } });
  const report = await app.request("POST", "/api/v1/reports", {
    token: TOKEN_A,
    body: { kind: "bug-package", title: "evidence", payload: { legacyId: "99004411" } },
  });
  assert.equal(report.status, 201);
  const reportId = report.json.report.id;
  const bytes = Buffer.from("ID: 99004411\n标题: evidence\n", "utf8");
  const expectedSha = crypto.createHash("sha256").update(bytes).digest("hex");
  const uploaded = await uploadFile(app, reportId, "Readme.md", bytes, TOKEN_A);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.json.created, true);
  assert.equal(uploaded.json.file.path, "Readme.md");
  assert.equal(uploaded.json.file.sha256, expectedSha);
  assert.equal(uploaded.json.file.role, "readme");
  const again = await uploadFile(app, reportId, "Readme.md", bytes, TOKEN_A);
  assert.equal(again.status, 200);
  assert.equal(again.json.created, false);
  const downloaded = await downloadFile(app, reportId, "Readme.md", TOKEN_A);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.buffer.toString("utf8"), bytes.toString("utf8"));
  assert.equal(downloaded.headers.get("x-vault-content-sha256"), expectedSha);
  const detail = await app.request("GET", "/api/v1/reports/" + reportId, { token: TOKEN_A });
  assert.equal(detail.json.files.length, 1);
  const link = await app.request("POST", "/api/v1/links", { token: TOKEN_A, body: { reportId, bugId: bug.json.bug.id, role: "evidence" } });
  assert.equal(link.status, 201);
  const audit = await app.request("GET", "/api/v1/audit?limit=100", { token: TOKEN_A });
  assert.ok(audit.json.items.some((event) => event.action === "report.file.upload"));
  const crossProject = await uploadFile(app, reportId, "Readme.md", bytes, TOKEN_B);
  assert.equal(crossProject.status, 404, "cross-project report id is not visible (404)");
  const missing = await downloadFile(app, reportId, "nope.png", TOKEN_A);
  assert.equal(missing.status, 404);
  const traversal = await app.request("GET", "/api/v1/reports/" + reportId + "/file?path=" + encodeURIComponent("../x"), { token: TOKEN_A });
  assert.equal(traversal.status, 400);
});
