#!/usr/bin/env node
/** 独立仓自检：三包 tarball 可解包、可 import、CLI 可执行（不依赖 registry）。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-verify-'));
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd || root, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, shell: !!opts.shell });
  return { rc: r.status === null ? 1 : r.status, out: r.stdout || '', err: (r.stderr || '').toString() };
}
const results = [];
for (const name of ['shared', 'studio', 'cli']) {
  const dir = path.join(root, 'packages', name);
  const pack = sh('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: dir, shell: true });
  let info = null;
  try { info = JSON.parse(pack.out); } catch { const m = /\[[\s\S]*\]/.exec(pack.out); if (m) { try { info = JSON.parse(m[0]); } catch { info = null; } } }
  const entry = Array.isArray(info) ? info[0] : info;
  results.push({ package: path.basename(dir), rc: pack.rc, tarball: entry ? entry.filename : null, files: entry ? entry.entryCount : null });
}
const nm = path.join(tmp, 'node_modules');
for (const name of ['shared', 'studio', 'cli']) {
  const dir = path.join(root, 'packages', name);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const rec = results.find((r) => r.package === name);
  if (!rec || !rec.tarball) continue;
  const dest = path.join(nm, ...pj.name.split('/'));
  fs.mkdirSync(dest, { recursive: true });
  const ex = sh('tar', ['-xzf', path.join(tmp, rec.tarball), '-C', dest, '--strip-components=1']);
  results.push({ package: pj.name, extract_rc: ex.rc });
}
const imp = sh(process.execPath, ['--input-type=module', '-e', "const m = await import('@studio/local'); const s = await import('@studio/shared'); console.log('IMPORT-OK', typeof m.main, s.SHARED_VERSION);"], { cwd: tmp });
const bin = sh(process.execPath, [path.join(nm, '@studio', 'local', 'bin', 'studio.js'), '--version'], { cwd: tmp });
const ok = results.filter((r) => r.rc === 0 || r.extract_rc === 0).length >= 6 && imp.rc === 0 && bin.rc === 0;
console.log(JSON.stringify({ ok, packages: results, import: { rc: imp.rc, out: (imp.out || '').trim().slice(0, 120) }, bin: { rc: bin.rc, out: (bin.out || '').trim().slice(0, 80) } }, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
