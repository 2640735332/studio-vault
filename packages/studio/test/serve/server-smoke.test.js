/**
 * End-to-end smoke test for the Studio viewer server (packages/studio/src/serve/server.js).
 *
 * Zero npm dependencies (node:test + global fetch). Works on Windows / Linux / macOS:
 *   - fixture lives in a throw-away OS temp dir, so the server's cwd is platform neutral;
 *   - the server listens on a random high port (30000-39999) via SPECVIEWER_PORT;
 *   - the child process is always killed and the temp dir removed in t.after().
 *
 * Covered:
 *   1. cold start on an empty workspace (directories already self-heal, see ensureRuntimeDirs);
 *   2. GET / , /api/data , /api/bugs respond 200;
 *   3. legacy imagegen / dsh-bridge endpoints are gone (404);
 *   4. POST /api/specviewer/transition bug start_fix rewrites the bug Readme status.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'packages', 'studio', 'src', 'serve', 'server.js');
const BUG_ID = '90010001';
const BUG_FOLDER = 'bug-20261107-120000-' + BUG_ID;
const READY_TIMEOUT_MS = 30000;
const PORT_MIN = 30000;
const PORT_MAX = 39999;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pickPort() {
  return PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
}

/** Minimal workspace layout the viewer server expects. */
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-serve-smoke-'));
  for (const rel of ['specs', path.join('docs', 'briefs'), path.join('game', 'reports', 'bugs', BUG_FOLDER), path.join('game', 'src', 'data')]) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, 'game', 'src', 'data', 'buildings.json'),
    JSON.stringify({ buildings: [{ id: 'demo-house', name: 'Demo House' }] }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(root, 'game', 'reports', 'bugs', BUG_FOLDER, 'Readme.md'),
    [
      'ID: ' + BUG_ID,
      '标题: smoke fixture bug',
      '类型: bug',
      '状态: 新',
      '优先级: P2',
      '严重度: low',
      '',
      '历史变更:',
      '- [2026-11-07 12:00:00] 创建',
      '',
    ].join('\n'),
  );
  return root;
}

/** Environment for the server child: strip viewer overrides, inject our random port. */
function childEnv(port) {
  const env = { ...process.env, SPECVIEWER_PORT: String(port) };
  delete env.SPECVIEWER_BIND;
  delete env.SPECVIEWER_ALLOW_LAN;
  delete env.SPECVIEWER_ALLOW_LAN_WRITE;
  delete env.SPECVIEWER_READONLY;
  delete env.SPECVIEWER_VAULT_WRITE;
  return env;
}

function startServer(root, port) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: root,
    env: childEnv(port),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { logs.stdout += String(d); });
  child.stderr.on('data', (d) => { logs.stderr += String(d); });
  let spawnError = null;
  child.on('error', (err) => { spawnError = err; });
  return { child, logs, spawnError: () => spawnError };
}

function describeLogs(logs) {
  const stdout = logs.stdout.trim();
  const stderr = logs.stderr.trim();
  return '--- server stdout ---\n' + stdout + '\n--- server stderr ---\n' + stderr;
}

/** Poll an HTTP endpoint until the listener answers (or the child dies / timeout). */
async function waitUntilReady(child, baseUrl, logs, isSpawnError) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    const spawnErr = isSpawnError();
    if (spawnErr) throw new Error('server failed to spawn: ' + spawnErr.message + '\n' + describeLogs(logs));
    if (child.exitCode !== null) {
      throw new Error('server exited before becoming ready (code ' + child.exitCode + ')\n' + describeLogs(logs));
    }
    try {
      const res = await fetch(baseUrl + '/api/data');
      await res.text();
      if (res.ok) return;
      lastError = new Error('HTTP ' + res.status);
    } catch (err) {
      lastError = err;
    }
    await delay(100);
  }
  throw new Error('server did not become ready within ' + READY_TIMEOUT_MS + 'ms (' + (lastError && lastError.message) + ')\n' + describeLogs(logs));
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 3000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    try {
      child.kill();
    } catch {
      clearTimeout(killTimer);
      resolve();
    }
  });
}

async function getRaw(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type') || '', text };
}

function parseJson(body) {
  return JSON.parse(body);
}

test('viewer server cold start + legacy endpoint removal + bug status transition', { timeout: 90000 }, async (t) => {
  const root = createFixture();
  const port = pickPort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const { child, logs, spawnError } = startServer(root, port);

  t.after(async () => {
    await stopChild(child);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* best effort on Windows (observer handles may linger briefly) */ }
  });

  await waitUntilReady(child, baseUrl, logs, spawnError);

  // 1. Viewer page (static shell) is served.
  const page = await getRaw(baseUrl + '/');
  assert.equal(page.status, 200, 'GET / should be 200');
  assert.match(page.contentType, /text\/html/i);
  assert.match(page.text, /Studio/, 'page should contain the Studio shell');

  // 2. Data catalog + bug list.
  const data = await getRaw(baseUrl + '/api/data');
  assert.equal(data.status, 200, 'GET /api/data should be 200');
  const catalog = parseJson(data.text);
  assert.ok(Array.isArray(catalog), '/api/data should return an array');
  assert.ok(catalog.length > 0, '/api/data should list known data files');
  const buildings = catalog.find((item) => item && item.stem === 'buildings');
  assert.ok(buildings, 'catalog should include buildings');
  assert.equal(buildings.count, 1, 'fixture buildings.json should be counted');

  const bugs = await getRaw(baseUrl + '/api/bugs');
  assert.equal(bugs.status, 200, 'GET /api/bugs should be 200');
  const bugList = parseJson(bugs.text);
  assert.ok(Array.isArray(bugList), '/api/bugs should return an array');
  assert.equal(bugList.length, 1, 'fixture should expose exactly one bug');
  assert.equal(bugList[0].id, BUG_FOLDER);
  assert.equal(bugList[0].bugId, BUG_ID);
  assert.equal(bugList[0].status, '新');

  // 3. Removed features (imagegen / dsh-bridge) must not leave routes behind.
  const imagegen = await getRaw(baseUrl + '/api/imagegen/state');
  assert.equal(imagegen.status, 404, 'GET /api/imagegen/state should be 404 (feature removed)');
  const dsh = await getRaw(baseUrl + '/api/dsh/sessions');
  assert.equal(dsh.status, 404, 'GET /api/dsh/sessions should be 404 (feature removed)');

  // 4. Bug status transition writes back to Markdown.
  const transition = await fetch(baseUrl + '/api/specviewer/transition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'bug', itemId: BUG_FOLDER, action: 'start_fix' }),
  });
  const transitionText = await transition.text();
  assert.equal(transition.status, 200, 'POST transition should be 200, body: ' + transitionText);
  const transitionBody = parseJson(transitionText);
  assert.equal(transitionBody.ok, true);
  assert.equal(transitionBody.from, '新');
  assert.equal(transitionBody.to, '修复中');
  assert.notEqual(transitionBody.statusWritten, false, 'transition should report the status was written');

  const readme = fs.readFileSync(path.join(root, 'game', 'reports', 'bugs', BUG_FOLDER, 'Readme.md'), 'utf8');
  assert.match(readme, /^状态[:：]\s*修复中\s*$/m, 'bug Readme status line should become 修复中');

  // The API reflects the rewritten status on the next scan.
  const bugsAfter = await getRaw(baseUrl + '/api/bugs');
  assert.equal(bugsAfter.status, 200);
  assert.equal(parseJson(bugsAfter.text)[0].status, '修复中');
});
