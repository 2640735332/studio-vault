/**
 * Tests for "studio init [--demo]" scaffolding (packages/studio/src/commands/init.js),
 * exercised through the real CLI entry point in a throw-away temp directory.
 *
 * Zero npm dependencies. The CLI is spawned with the current Node binary, so the test
 * is independent of PATH / shell state and works on Windows, Linux and macOS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'studio-cli.js');

const SKELETON_DIRS = [
  'specs',
  path.join('docs', 'briefs'),
  path.join('game', 'reports', 'bugs'),
  path.join('game', 'src', 'data'),
];

function runInit(cwd, extraArgs = []) {
  return spawnSync(process.execPath, [CLI_ENTRY, 'init', ...extraArgs], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: process.env,
  });
}

/** All files below root as { relativePath: contents } — used to prove idempotency. */
function snapshotFiles(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out[rel] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}

test('studio init --demo scaffolds a workspace and is idempotent', { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-init-'));
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const projectId = path.basename(root);
  const first = runInit(root, ['--demo']);
  assert.equal(first.status, 0, 'first init should exit 0\nstdout: ' + first.stdout + '\nstderr: ' + first.stderr);
  assert.match(first.stdout, /\[studio\] init ok/);

  // 1. studio.config.json is valid and carries the project id.
  const configPath = path.join(root, 'studio.config.json');
  assert.ok(fs.existsSync(configPath), 'studio.config.json should be created');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.version, 1);
  assert.equal(config.project.id, projectId);
  assert.equal(typeof config.vault.url, 'string');
  assert.equal(typeof config.studio.port, 'number');

  // 2. The four skeleton directories exist.
  for (const rel of SKELETON_DIRS) {
    const stat = fs.statSync(path.join(root, rel));
    assert.ok(stat.isDirectory(), rel + ' should be a directory');
  }

  // 3. Demo files: one brief, one bug report (状态: 新) and one data sample.
  const briefDirs = fs.readdirSync(path.join(root, 'docs', 'briefs'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-demo-brief$/.test(e.name));
  assert.equal(briefDirs.length, 1, '--demo should create exactly one demo brief directory');
  const briefPath = path.join(root, 'docs', 'briefs', briefDirs[0].name, 'BRIEF.md');
  const brief = fs.readFileSync(briefPath, 'utf8');
  assert.match(brief, /^状态[:：]/m, 'demo BRIEF.md should have a status line');
  assert.match(brief, /草稿/, 'demo BRIEF.md should start as 草稿');

  const bugDirs = fs.readdirSync(path.join(root, 'game', 'reports', 'bugs'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^bug-\d{8}-000000-9001$/.test(e.name));
  assert.equal(bugDirs.length, 1, '--demo should create exactly one demo bug directory');
  const bugReadme = fs.readFileSync(path.join(root, 'game', 'reports', 'bugs', bugDirs[0].name, 'Readme.md'), 'utf8');
  assert.match(bugReadme, /^状态[:：]\s*新\s*$/m, 'demo bug Readme.md should start with 状态: 新');

  const buildingsPath = path.join(root, 'game', 'src', 'data', 'buildings.json');
  const buildings = JSON.parse(fs.readFileSync(buildingsPath, 'utf8'));
  assert.ok(buildings && typeof buildings === 'object', 'demo buildings.json should be valid JSON');

  // 4. Second run is idempotent and never clobbers user edits.
  // Expected generated files: config + demo brief + demo bug Readme + demo data sample.
  const beforeFiles = snapshotFiles(root);
  assert.equal(Object.keys(beforeFiles).length, 4, 'expected exactly 4 generated files, got: ' + Object.keys(beforeFiles).join(', '));
  const bugReadmePath = path.join(root, 'game', 'reports', 'bugs', bugDirs[0].name, 'Readme.md');
  const bugReadmeBefore = fs.readFileSync(bugReadmePath, 'utf8');

  const briefSentinel = '\n<!-- locally edited: keep me -->\n';
  fs.appendFileSync(briefPath, briefSentinel);
  fs.writeFileSync(buildingsPath, '{"buildings":[{"id":"user-edited"}]}\n');
  const configBeforeSecondRun = fs.readFileSync(configPath, 'utf8');

  const second = runInit(root, ['--demo']);
  assert.equal(second.status, 0, 'second init should exit 0\nstdout: ' + second.stdout + '\nstderr: ' + second.stderr);
  assert.match(second.stdout, /config: kept/i, 'second init should report the existing config was kept');
  assert.match(second.stdout, /demo: created 0/);

  assert.equal(fs.readFileSync(configPath, 'utf8'), configBeforeSecondRun, 'second init must not overwrite studio.config.json');
  assert.ok(fs.readFileSync(briefPath, 'utf8').endsWith(briefSentinel), 'second init must not overwrite an edited BRIEF.md');
  assert.equal(fs.readFileSync(buildingsPath, 'utf8'), '{"buildings":[{"id":"user-edited"}]}\n', 'second init must not overwrite an edited data file');

  const afterFiles = snapshotFiles(root);
  assert.deepEqual(Object.keys(afterFiles).sort(), Object.keys(beforeFiles).sort(), 'second init must not create extra files');
  assert.equal(fs.readFileSync(bugReadmePath, 'utf8'), bugReadmeBefore, 'second init must leave the demo bug Readme.md untouched');
});
