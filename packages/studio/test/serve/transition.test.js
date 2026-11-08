import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// transition.js —— 状态流转核心（brief/bug 状态矩阵 + Markdown 写回）的零依赖单测。
// 覆盖：brief 自包含直接写 BRIEF.md、bug 流转/requires/非法输入、轨 BUG.md best-effort 同步。
const TRANSITION_URL = new URL('../../src/serve/transition.js', import.meta.url).href;
const { createTransition, buildTransition, normalizeWhitespace, findTrackBugRow } = await import(TRANSITION_URL);

function mkRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-transition-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, 'docs', 'briefs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'game', 'reports', 'bugs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  return root;
}

function transitionFor(root) {
  return createTransition({
    repoRoot: root,
    briefsDir: path.join(root, 'docs', 'briefs'),
    bugsDir: path.join(root, 'game', 'reports', 'bugs'),
    specsDir: path.join(root, 'specs'),
  });
}

function writeBrief(root, folder, body) {
  const dir = path.join(root, 'docs', 'briefs', folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'BRIEF.md');
  fs.writeFileSync(file, body);
  return file;
}

function writeBug(root, folder, bugId, status) {
  const dir = path.join(root, 'game', 'reports', 'bugs', folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Readme.md');
  fs.writeFileSync(file, [
    '# fixture bug', '', 'ID: ' + bugId, '标题: fixture', '状态: ' + status, '描述: fixture', '',
    '历史变更:', '- [2026-11-01T12:00:00] ' + status + ': 入库', '',
  ].join('\n'));
  return file;
}

function statusOf(file) {
  const md = fs.readFileSync(file, 'utf8');
  const m = md.match(/^状态[:：]\s*(.*)$/m);
  return m ? m[1].replace(/\*/g, '').trim() : '';
}

function demoBriefBody(statusLine) {
  return [
    '# 简报：demo 演示简报', '', '日期: 2026-11-01', '包提示: demo', '轨提示: *(无)*', statusLine, '',
    '## 1. 问题', '演示内容。', '', '## 9. 变更记录', '| 版本 | 日期 | 说明 |', '|------|------|------|',
    '| v0.1 | 2026-11-01 | init --demo |', '',
  ].join('\n');
}

test('brief 状态写回自包含：直接改 BRIEF.md，不 spawn 目标仓脚本', async (t) => {
  const root = mkRoot(t);
  const briefId = '2026-11-01-demo-brief';
  const file = writeBrief(root, briefId, demoBriefBody('状态: **草稿**'));
  // 放一个「被调用就会落标记」的假脚本：证明 brief 路径根本不会 spawn 它。
  const scriptDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  const marker = path.join(scriptDir, 'brief-script-called.txt');
  fs.writeFileSync(path.join(scriptDir, 'brief-set-status.js'),
    "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'called'); process.exit(1);\n");

  const tr = transitionFor(root);
  // MATRIX：草稿 --mark_ready--> 可交 spec-engine --start_impl--> 实现中（不跳「可交」闸门）。
  let r = await tr.runTransition({ kind: 'brief', id: briefId, action: 'mark_ready' });
  assert.equal(r.http, 200);
  assert.equal(r.body.from, '草稿');
  assert.equal(r.body.to, '可交 spec-engine');
  r = await tr.runTransition({ kind: 'brief', id: briefId, action: 'start_impl' });
  assert.equal(r.http, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.from, '可交 spec-engine');
  assert.equal(r.body.to, '实现中');
  assert.equal(r.body.skipped, false);
  assert.equal(r.body.statusWritten, true);
  assert.equal(r.body.trackRow, null);
  assert.equal(r.body.vault, null);
  // 状态行被改写且保留加粗写法与其他内容
  assert.equal(statusOf(file), '实现中');
  const md = fs.readFileSync(file, 'utf8');
  assert.match(md, /^状态: \*\*实现中\*\*$/m);
  assert.match(md, /^# 简报：demo 演示简报$/m);
  assert.match(md, /^## 9\. 变更记录$/m);
  assert.equal(fs.existsSync(marker), false, 'brief 写回不得再依赖 scripts/brief-set-status.js');
});

test('brief：缺失状态行自动追加；非加粗行保持非加粗；非法迁移/已到目标', async (t) => {
  const root = mkRoot(t);
  const tr = transitionFor(root);

  const noLine = writeBrief(root, 'b-no-line', '# 简报：无状态行\n\n正文。\n');
  let r = await tr.runTransition({ kind: 'brief', id: 'b-no-line', action: 'mark_ready' });
  assert.equal(r.http, 200);
  assert.equal(r.body.from, '草稿', '缺状态行按草稿处理（与 Viewer 展示默认一致）');
  assert.equal(r.body.to, '可交 spec-engine');
  assert.equal(statusOf(noLine), '可交 spec-engine');
  assert.match(fs.readFileSync(noLine, 'utf8'), /^状态: 可交 spec-engine$/m);

  const plain = writeBrief(root, 'b-plain', '# 简报：非加粗\n\n状态: 可交 spec-engine\n');
  r = await tr.runTransition({ kind: 'brief', id: 'b-plain', action: 'start_impl' });
  assert.equal(r.http, 200);
  assert.equal(r.body.from, '可交 spec-engine');
  assert.equal(r.body.to, '实现中');
  assert.match(fs.readFileSync(plain, 'utf8'), /^状态: 实现中$/m);

  // 非法迁移：草稿不能直接 mark_done
  const draft = writeBrief(root, 'b-draft', '# 简报：草稿\n\n状态: 草稿\n');
  r = await tr.runTransition({ kind: 'brief', id: 'b-draft', action: 'mark_done' });
  assert.equal(r.http, 409);
  assert.equal(r.body.error, 'illegal_transition');
  assert.equal(statusOf(draft), '草稿');

  // 已到目标 → skipped（不重复写）
  r = await tr.runTransition({ kind: 'brief', id: 'b-no-line', action: 'mark_ready' });
  assert.equal(r.http, 200);
  assert.equal(r.body.skipped, true);
  assert.equal(r.body.reason, 'already_at_target');
});

test('bug：Readme 状态写回全链路（无轨行 trackRow=absent）', async (t) => {
  const root = mkRoot(t);
  const file = writeBug(root, 'bug-20261101-120000-87654321', '87654321', '新');
  const tr = transitionFor(root);

  let r = await tr.runTransition({ kind: 'bug', itemId: 'bug-20261101-120000-87654321', action: 'start_fix' });
  assert.equal(r.http, 200);
  assert.equal(r.body.from, '新');
  assert.equal(r.body.to, '修复中');
  assert.equal(r.body.statusWritten, true);
  assert.equal(r.body.trackRow, 'absent');
  assert.deepEqual(r.body.vault, { skipped: true });
  assert.equal(statusOf(file), '修复中');

  r = await tr.runTransition({ kind: 'bug', itemId: 'bug-20261101-120000-87654321', action: 'mark_done' });
  assert.equal(r.http, 200);
  assert.equal(r.body.to, '已关闭');
  assert.equal(statusOf(file), '已关闭');

  r = await tr.runTransition({ kind: 'bug', itemId: 'bug-20261101-120000-87654321', action: 'reopen' });
  assert.equal(r.http, 200);
  assert.equal(r.body.to, '新');
  assert.equal(statusOf(file), '新');
});

test('bug：requires / 非法输入 / 已到目标', async (t) => {
  const root = mkRoot(t);
  const folder = 'bug-20261101-120001-87654322';
  const file = writeBug(root, folder, '87654322', '新');
  const tr = transitionFor(root);

  let r = await tr.runTransition({ kind: 'bug', itemId: folder, action: 'close_false_red' });
  assert.equal(r.http, 400);
  assert.equal(r.body.error, 'reason_required');

  r = await tr.runTransition({ kind: 'bug', itemId: folder, action: 'close_false_red', reason: '用例假红' });
  assert.equal(r.http, 200);
  assert.equal(r.body.to, '已关闭 · 非缺陷');
  assert.equal(statusOf(file), '已关闭 · 非缺陷');

  r = await tr.runTransition({ kind: 'bug', itemId: folder, action: 'reopen' });
  assert.equal(r.http, 200);
  r = await tr.runTransition({ kind: 'bug', itemId: folder, action: 'close_duplicate' });
  assert.equal(r.http, 400);
  assert.equal(r.body.error, 'duplicate_requires_target');
  r = await tr.runTransition({ kind: 'bug', itemId: folder, action: 'close_duplicate', masterId: '87654321' });
  assert.equal(r.http, 200);
  assert.equal(r.body.to, '已关闭 · 重复');

  // start_fix 在「修复中」→ skipped already_at_target
  const fixing = 'bug-20261101-120005-87654326';
  writeBug(root, fixing, '87654326', '修复中');
  r = await tr.runTransition({ kind: 'bug', itemId: fixing, action: 'start_fix' });
  assert.equal(r.http, 200);
  assert.equal(r.body.skipped, true);
  assert.equal(r.body.reason, 'already_at_target');

  r = await tr.runTransition({ kind: 'bug', itemId: folder, action: 'no_such_action' });
  assert.equal(r.http, 400);
  assert.equal(r.body.error, 'unknown_action');
  r = await tr.runTransition({ kind: 'nope', itemId: folder, action: 'start_fix' });
  assert.equal(r.http, 400);
  assert.equal(r.body.error, 'unknown_kind');
  r = await tr.runTransition({ kind: 'bug', itemId: '../escape', action: 'start_fix' });
  assert.equal(r.http, 400);
  assert.equal(r.body.error, 'invalid_id');
  r = await tr.runTransition({ kind: 'bug', itemId: 'missing-bug', action: 'start_fix' });
  assert.equal(r.http, 404);
  assert.equal(r.body.error, 'not_found');
});

function writeTrackRow(root, pkg, track, bugId) {
  const dir = path.join(root, 'specs', pkg, track);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'BUG.md'), [
    '# BUG 轨', '', '## 缺陷总览', '', '| ID | 标题 | 状态 |', '|----|------|------|',
    '| ' + bugId + ' | fixture | 新 |', '',
  ].join('\n'));
}

test('轨 BUG.md 同步 best-effort：无 spec-track.js → skipped_no_script 且 HTTP 200', async (t) => {
  const root = mkRoot(t);
  writeTrackRow(root, 'demo-pkg', 'track-001', '87654323');
  const file = writeBug(root, 'bug-20261101-120002-87654323', '87654323', '新');
  const tr = transitionFor(root);

  const r = await tr.runTransition({ kind: 'bug', itemId: 'bug-20261101-120002-87654323', action: 'start_fix' });
  assert.equal(r.http, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.statusWritten, true);
  assert.equal(r.body.trackRow, 'skipped_no_script');
  assert.equal(statusOf(file), '修复中', 'Readme 必须照常写回');
  // 轨 BUG.md 保持原状（best-effort 不写）
  assert.match(fs.readFileSync(path.join(root, 'specs', 'demo-pkg', 'track-001', 'BUG.md'), 'utf8'), /\| 新 \|/);
});

test('轨 BUG.md 同步：spec-track.js 存在时行为不变（调用 + 失败回滚）', async (t) => {
  const root = mkRoot(t);
  writeTrackRow(root, 'demo-pkg', 'track-002', '87654324');
  const bugFolder = 'bug-20261101-120003-87654324';
  const file = writeBug(root, bugFolder, '87654324', '新');
  const scriptDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  const argsFile = path.join(scriptDir, 'track-args.json');
  fs.writeFileSync(path.join(scriptDir, 'spec-track.js'), [
    "const fs = require('fs');",
    "const path = require('path');",
    'fs.writeFileSync(path.join(__dirname, \'track-args.json\'), JSON.stringify(process.argv.slice(2)));',
    'process.exit(0);',
    '',
  ].join('\n'));
  const tr = transitionFor(root);

  let r = await tr.runTransition({ kind: 'bug', itemId: bugFolder, action: 'start_fix' });
  assert.equal(r.http, 200);
  assert.equal(r.body.trackRow, 'updated');
  assert.equal(statusOf(file), '修复中');
  const argv = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.deepEqual(argv, ['bug', 'set', '--package', 'demo-pkg', '--track', 'track-002', '--id', '87654324', '--status', '修复中']);

  // 脚本存在但失败 → 保持旧行为：500 + Readme 回滚（不静默）
  fs.writeFileSync(path.join(scriptDir, 'spec-track.js'), 'process.exit(1);\n');
  const bug2 = 'bug-20261101-120004-87654325';
  const file2 = writeBug(root, bug2, '87654325', '新');
  writeTrackRow(root, 'demo-pkg', 'track-003', '87654325');
  r = await tr.runTransition({ kind: 'bug', itemId: bug2, action: 'start_fix' });
  assert.equal(r.http, 500);
  assert.equal(r.body.error.code, 'status_write_failed');
  assert.equal(r.body.error.detail.error, 'track_status_write_failed');
  assert.equal(r.body.error.detail.readmeRolledBack, true);
  assert.equal(statusOf(file2), '新', '轨写失败要回滚 Readme');
});

test('纯函数：状态矩阵 / 空白归一 / 轨行定位', () => {
  assert.equal(normalizeWhitespace('  a\r\n b\t '), 'a b');
  assert.equal(buildTransition('bug', '新', 'start_fix').to, '修复中');
  assert.equal(buildTransition('bug', '修复中', 'start_fix').skipped, true);
  assert.equal(buildTransition('bug', '新', 'no_such').error, 'unknown_action');
  assert.equal(buildTransition('brief', '草稿', 'start_impl').error, 'illegal_transition');
  assert.equal(buildTransition('nope', '中', 'start_fix').error, 'unknown_kind');
  assert.equal(findTrackBugRow('## 缺陷总览\n| 12345678 | x |\n', '12345678'), true);
  assert.equal(findTrackBugRow('## 其他\n| 12345678 | x |\n', '12345678'), false);
  assert.equal(findTrackBugRow('## 缺陷总览\n| 12345678 | x |\n', 'not-an-id'), false);
});
