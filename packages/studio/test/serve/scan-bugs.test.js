import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scanBugs parses the bug folder name into date/month. Two naming schemes exist:
//   legacy:  bug-YYYYMMDD-HHMMSS-<id>   (e.g. bug-20261101-153628-88067018)
//   current: bug-YYYYMMDDHHMMSS-<id>    (vault-sync writes bug-<14 digits>-<id>)
// Both must yield date=YYYY-MM-DD and month=YYYY-MM.
const SERVER_URL = new URL('../../src/serve/server.js', import.meta.url).href;

test('scanBugs parses date/month for legacy and compact bug folder names', async (t) => {
  const originalCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scanbugs-'));
  const bugsDir = path.join(root, 'game', 'reports', 'bugs');
  const legacyFolder = 'bug-20261101-153628-88067018';
  const compactFolder = 'bug-20261025091011-88067019';
  t.after(() => {
    try { process.chdir(originalCwd); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });
  for (const folder of [legacyFolder, compactFolder]) {
    const dir = path.join(bugsDir, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Readme.md'), [
      '# fixture',
      '',
      'ID: 88067018',
      '标题: fixture',
      '状态: 新',
      '分支: feat/demo-001',
      '提交: 33ed4e9a6',
      '关联轨: track-demo-1',
      '优先级: P1',
      '严重度: high',
      '构建: {"version":"0.1.0","engine":{"name":"Godot","version":"4.5-stable"}}',
      '环境: {"os":"Windows","hw":{"gpu":"GPU-0"}}',
      '复现步骤: [{"id":"1","text":"打开菜单"}]',
      '复现: {"frequency":"always","attempts":3}',
      '世界状态: {"seed":"123456","chunk":{"x":61,"y":26}}',
      '上报者: {"id":"tester-01","source":"f3"}',
      'E2E上下文: {"case_id":"demo-case-1","checkpoint":true}',
      '数据缺口: branch, build',
      '',
    ].join('\n'));
  }
  process.chdir(root);
  const { scanBugs } = await import(SERVER_URL);
  const bugs = scanBugs();
  assert.equal(bugs.length, 2);
  const legacy = bugs.find((b) => b.folder === legacyFolder);
  const compact = bugs.find((b) => b.folder === compactFolder);
  assert.ok(legacy, 'legacy folder scanned');
  assert.ok(compact, 'compact folder scanned');
  assert.equal(legacy.date, '2026-11-01');
  assert.equal(legacy.month, '2026-11');
  assert.equal(compact.date, '2026-10-25');
  assert.equal(compact.month, '2026-10');
  assert.ok(legacy.date && legacy.month && compact.date && compact.month, 'date/month non-empty for both naming schemes');
  assert.equal(legacy.title, 'fixture');
  assert.equal(legacy.branch, 'feat/demo-001');
  assert.equal(legacy.commitSha, '33ed4e9a6');
  assert.equal(legacy.sourceTrack, 'track-demo-1');
  assert.equal(legacy.priority, 'P1');
  assert.equal(legacy.severity, 'high');
  assert.equal(legacy.build.version, '0.1.0');
  assert.equal(legacy.env.os, 'Windows');
  assert.equal(legacy.steps.length, 1);
  assert.equal(legacy.reproRate.frequency, 'always');
  assert.equal(legacy.worldState.seed, '123456');
  assert.equal(legacy.reporter.id, 'tester-01');
  assert.equal(legacy.caseContext.case_id, 'demo-case-1');
  assert.deepEqual(legacy.dataGaps, ['branch', 'build']);
});
