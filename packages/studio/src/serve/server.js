import { watch, readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, extname, sep, isAbsolute } from 'path';
import { createServer } from 'http';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { handlePulseRequest, invalidatePulseCache } from './pulse.js';
import { handlePerformanceRequest } from './performance.js';
import { patchBugReadme } from './bug-status.js';
import { vaultWriteEnabled, patchVaultByLegacy } from './vault-write.js';
import { createTransition } from './transition.js';
import { resolveBind, isLoopbackAddress, isWriteMethod, bindWarningLines, bindLoopbackLine, portSweepCommand, pickListenerPids } from './server-net.js';
import {
  defaultRoots, listCatalog, filePayload, entryPayload, patchEntry, spriteFile,
} from './data.js';

const PORT = 3456;
// 监听面策略（t-0915-305 硬化 A）：默认只绑回环；SPECVIEWER_BIND / SPECVIEWER_ALLOW_LAN=1 才开 LAN。
// SPECVIEWER_PORT 仅供测试/多实例使用（默认仍是 3456）。
const BIND = resolveBind(process.env);
const LISTEN_PORT = Number(process.env.SPECVIEWER_PORT || 0) || PORT;
const READONLY = process.env.SPECVIEWER_READONLY === '1';
const specsDir = resolve('specs');
const briefsDir = resolve('docs/briefs');
const bugsDir = resolve('game/reports/bugs');
const dataRoots = defaultRoots(resolve('.'));
const dataWatchDir = resolve('game/src/data');

function isInside(root, full) {
  const r = resolve(root).replace(/[/\\]+$/, '').toLowerCase();
  const f = resolve(full).toLowerCase();
  return f === r || f.startsWith(r + sep) || f.startsWith(r + '/');
}

function isMainModule() {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
  } catch {
    return false;
  }
}

const requiredTrackDocs = ['INPUT.md','PRD.md','TECH.md','TASK.md','TRACE.md','REVIEW.md','TEST.md','BUG.md'];
const requiredPackageDocs = ['SPEC.md','ARCH.md','GLOSSARY.md'];

function unquoteYaml(s) {
  const t = (s || '').trim();
  if (t === '[]') return [];
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Constrained parser for domains/_index.yml (same subset as scripts/domain_lib.py). */
function parseDomainIndex(text) {
  const domains = [];
  let current = null;
  let listKey = null;
  let pkg = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.split('#')[0].replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const stripped = line.trim();
    if (indent === 0 && stripped.includes(':') && !stripped.startsWith('-')) {
      const i = stripped.indexOf(':');
      const key = stripped.slice(0, i).trim();
      const val = stripped.slice(i + 1).trim();
      if (key === 'package' && val) pkg = unquoteYaml(val);
      current = null;
      listKey = null;
      continue;
    }
    if (stripped.startsWith('- id:') && indent <= 2) {
      current = { id: unquoteYaml(stripped.slice('- id:'.length)) };
      domains.push(current);
      listKey = null;
      continue;
    }
    if (!current) continue;
    if (indent >= 6 && stripped.startsWith('- ')) {
      if (!listKey) continue;
      if (!Array.isArray(current[listKey])) current[listKey] = [];
      current[listKey].push(unquoteYaml(stripped.slice(2)));
      continue;
    }
    if (indent === 4 && stripped.endsWith(':') && !stripped.startsWith('-') && !stripped.slice(0, -1).includes(':')) {
      listKey = stripped.slice(0, -1).trim();
      current[listKey] = [];
      continue;
    }
    if (indent === 4 && stripped.includes(':')) {
      const i = stripped.indexOf(':');
      const key = stripped.slice(0, i).trim();
      const val = stripped.slice(i + 1).trim();
      listKey = null;
      current[key] = val === '[]' || val === '' ? [] : unquoteYaml(val);
    }
  }
  return { package: pkg, domains };
}

function scanDomains() {
  const out = [];
  let pkgs;
  try { pkgs = readdirSync(specsDir); } catch { return out; }
  for (const name of pkgs) {
    const indexPath = join(specsDir, name, 'domains', '_index.yml');
    if (!exists(indexPath)) continue;
    let text = '';
    try { text = readFileSync(indexPath, 'utf-8'); } catch { continue; }
    const parsed = parseDomainIndex(text);
    const pkg = parsed.package || name;
    for (const d of parsed.domains || []) {
      if (!d || !d.id) continue;
      const currentRel = `${pkg}/domains/${d.id}/CURRENT.md`;
      const currentFull = join(specsDir, currentRel);
      out.push({
        package: pkg,
        id: d.id,
        title: d.title || d.id,
        tracks: Array.isArray(d.tracks) ? d.tracks : [],
        gut: Array.isArray(d.gut) ? d.gut : [],
        e2e: Array.isArray(d.e2e) ? d.e2e : [],
        code: Array.isArray(d.code) ? d.code : [],
        current: exists(currentFull) ? `specs/${currentRel}` : null,
      });
    }
  }
  return out;
}

function exists(f) { try { return statSync(f).isFile(); } catch { return false; } }

function readPkgDesc(specPath) {
  try {
    const c = readFileSync(specPath, 'utf-8');
    const m = c.match(/##\s*概述\s*\n+(.+?)(?=\n##|\n---|$)/s);
    return m ? m[1].trim().replace(/\s+/g, ' ') : '';
  } catch { return ''; }
}

function scan() {
  const packages = [];
  for (const entry of readdirSync(specsDir)) {
    const pkgDir = join(specsDir, entry);
    if (!statSync(pkgDir).isDirectory() || entry.startsWith('.') || ['schema.json','STANDARDS.md','node_modules'].includes(entry)) continue;
    const pkg = { name: entry, path: entry, packageDocs: {}, tracks: [], description: readPkgDesc(join(pkgDir, 'SPEC.md')) };
    for (const doc of requiredPackageDocs) pkg.packageDocs[doc] = exists(join(pkgDir, doc));
    for (const te of readdirSync(pkgDir)) {
      const trackDir = join(pkgDir, te);
      if (!statSync(trackDir).isDirectory() || te.startsWith('.') || te === 'domains') continue;
      const track = { name: te, path: join(entry, te), docs: {} };
      for (const doc of requiredTrackDocs) track.docs[doc] = exists(join(trackDir, doc));
      pkg.tracks.push(track);
    }
    packages.push(pkg);
  }
  return packages;
}

function getFileContent(relPath) {
  const full = resolve(join(specsDir, relPath));
  if (!isInside(specsDir, full)) return null;
  try { return stripBom(readFileSync(full, 'utf-8')); } catch { return null; }
}

function stripBom(s) {
  return typeof s === 'string' ? s.replace(/^\uFEFF/, '') : s;
}

function parseBriefMeta(md) {
  md = stripBom(md);
  const title = (md.match(/^#\s+(.+)$/m) || [])[1] || '未命名';
  const status = (md.match(/(?:Status|状态):\s*\*?\*?([^*\n|]+)/i) || [])[1]?.trim() || '草稿';
  return {
    title: title.replace(/^Brief:\s*/i, '').replace(/^简报[：:]\s*/, '').trim(),
    status,
  };
}

function scanBriefs() {
  const out = [];
  let entries;
  try { entries = readdirSync(briefsDir); } catch { return out; }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'INDEX.md') continue;
    const dir = join(briefsDir, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const briefPath = join(dir, 'BRIEF.md');
    if (!exists(briefPath)) continue;
    let md = '';
    try { md = readFileSync(briefPath, 'utf-8'); } catch { continue; }
    const meta = parseBriefMeta(md);
    const date = (name.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    out.push({
      id: name,
      folder: name,
      title: meta.title,
      status: meta.status,
      date,
      month: date ? date.slice(0, 7) : '',
      hasPreview: exists(join(dir, 'preview.html')),
    });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1));
  return out;
}

function getBriefContent(relPath) {
  const full = resolve(join(briefsDir, relPath));
  if (!isInside(briefsDir, full)) return null;
  try { return stripBom(readFileSync(full, 'utf-8')); } catch { return null; }
}

function parseBugReadme(md) {
  md = stripBom(md);
  const pick = (key) => {
    const m = md.match(new RegExp('^' + key + '[:：][ \\t]*(.*)$', 'm'));
    return m ? m[1].trim() : '';
  };
  const pickJson = (key) => {
    const value = pick(key);
    if (!value) return null;
    try { return JSON.parse(value); } catch { return null; }
  };
  const gaps = pick('数据缺口');
  return {
    bugId: pick('ID'),
    title: pick('标题') || '未命名',
    description: pick('描述'),
    recTime: pick('复现时间'),
    log: pick('日志'),
    shotsField: pick('截图'),
    status: pick('状态') || '新',
    history: parseBugHistory(md),
    branch: pick('分支'),
    commitSha: pick('提交'),
    sourceTrack: pick('关联轨'),
    priority: pick('优先级'),
    severity: pick('严重度'),
    build: pickJson('构建'),
    env: pickJson('环境'),
    steps: pickJson('复现步骤'),
    worldState: pickJson('世界状态'),
    reproRate: pickJson('复现'),
    reporter: pickJson('上报者'),
    caseContext: pickJson('E2E上下文'),
    verification: pickJson('修复验证'),
    dataGaps: gaps ? gaps.split(/[,，]\s*/).filter(Boolean) : [],
    legacyCapture: pick('历史采集') === 'true',
    dataGapsReason: pick('数据缺口原因'),
    legacyCaptureInfo: pickJson('历史采集信息'),
  };
}

function parseBugHistory(md) {
  const lines = String(md || '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^历史变更[:：]/.test(l.trim()));
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (!t) continue;
    if (/^[-*]/.test(t)) out.push(t.replace(/^[-*]\s*/, ''));
    else break;
  }
  return out;
}

function scanBugs() {
  const out = [];
  let entries;
  try { entries = readdirSync(bugsDir); } catch { return out; }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = join(bugsDir, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const readmePath = join(dir, 'Readme.md');
    if (!exists(readmePath) && !exists(join(dir, 'README.md'))) continue;
    let md = '';
    try { md = readFileSync(exists(readmePath) ? readmePath : join(dir, 'README.md'), 'utf-8'); } catch { continue; }
    const meta = parseBugReadme(md);
    let files = [];
    try { files = readdirSync(dir); } catch { files = []; }
    const shots = files.filter((f) => /^screenshot-\d+\.(png|jpe?g|webp)$/i.test(f)).sort();
    const logs = files.filter((f) => /^log-.*\.jsonl$/i.test(f));
    const ts = (name.match(/^bug-(\d{8})-?(\d{6})/) || []);
    const date = ts[1] ? `${ts[1].slice(0, 4)}-${ts[1].slice(4, 6)}-${ts[1].slice(6, 8)}` : '';
    out.push({
      id: name,
      folder: name,
      bugId: meta.bugId,
      title: meta.title,
      description: meta.description,
      recTime: meta.recTime,
      status: meta.status,
      date,
      month: date ? date.slice(0, 7) : '',
      shots,
      logs,
      history: meta.history || [],
      branch: meta.branch || '',
      commitSha: meta.commitSha || '',
      sourceTrack: meta.sourceTrack || '',
      priority: meta.priority || '',
      severity: meta.severity || '',
      build: meta.build || null,
      env: meta.env || null,
      steps: meta.steps || null,
      worldState: meta.worldState || null,
      reproRate: meta.reproRate || null,
      reporter: meta.reporter || null,
      caseContext: meta.caseContext || null,
      verification: meta.verification || null,
      dataGaps: meta.dataGaps || [],
      legacyCapture: !!meta.legacyCapture,
      dataGapsReason: meta.dataGapsReason || '',
      legacyCaptureInfo: meta.legacyCaptureInfo || null,
      hasReadme: true,
    });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : -1));
  return out;
}

function mimeFor(name) {
  const e = extname(name).toLowerCase();
  return ({
    '.html': 'text/html;charset=utf-8',
    '.htm': 'text/html;charset=utf-8',
    '.md': 'text/plain;charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.css': 'text/css;charset=utf-8',
    '.jsonl': 'text/plain;charset=utf-8',
    '.json': 'application/json;charset=utf-8',
    '.txt': 'text/plain;charset=utf-8',
  })[e] || 'application/octet-stream';
}

function injectBase(html, baseHref) {
  if (/<base\s/i.test(html)) return html;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
  return `<head><base href="${baseHref}"></head>` + html;
}

function readUnder(root, rel, asText) {
  if (!rel || rel.includes('..')) return null;
  const full = resolve(join(root, rel));
  if (!isInside(root, full)) return null;
  try {
    const st = statSync(full);
    if (!st.isFile()) return null;
    return asText ? stripBom(readFileSync(full, 'utf-8')) : readFileSync(full);
  } catch { return null; }
}

// --- ChangeHub: in-process snapshot + ring + unified diff ---
const RING_MAX = 32;
const SNAP_MAX = 512 * 1024;
const DEBOUNCE_MS = 120;
const DIFF_LINE_CAP = 1500;
const snapshots = new Map();
const lastUnified = new Map();
const recentChanges = [];
const pendingTimers = new Map();

function normRel(fn) {
  return String(fn || '').replace(/\\/g, '/');
}

function walkSeed(dir, base = '') {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkSeed(full, rel);
    else if (st.isFile() && st.size <= SNAP_MAX) {
      try { snapshots.set(rel.replace(/\\/g, '/'), readFileSync(full, 'utf-8')); } catch {}
    }
  }
}

function pushRing(entry) {
  const i = recentChanges.findIndex(c => c.path === entry.path);
  if (i >= 0) recentChanges.splice(i, 1);
  recentChanges.unshift(entry);
  while (recentChanges.length > RING_MAX) recentChanges.pop();
}

/** ponytail: O(n·m) LCS line diff — ceiling ~DIFF_LINE_CAP²; upgrade: Myers / rolling hash */
function unifiedDiff(oldText, newText, path) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) {
    return `--- a/${path}\n+++ b/${path}\n@@ file too large for line diff (${a.length}→${b.length} lines) @@\n`;
  }
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { ops.push({ t: ' ', s: a[i - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { ops.push({ t: '+', s: b[j - 1] }); j--; }
    else { ops.push({ t: '-', s: a[i - 1] }); i--; }
  }
  ops.reverse();
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let bi = 0;
  while (bi < ops.length) {
    while (bi < ops.length && ops[bi].t === ' ') bi++;
    if (bi >= ops.length) break;
    let s = bi, e = bi;
    while (e < ops.length) {
      if (ops[e].t !== ' ') { e++; continue; }
      let run = 0;
      while (e + run < ops.length && ops[e + run].t === ' ') run++;
      if (run >= 6) break;
      e += run;
    }
    const ctx0 = Math.max(0, s - 3);
    const ctx1 = Math.min(ops.length, e + 3);
    let oldStart = 1, newStart = 1, oc = 0, nc = 0;
    for (let k = 0; k < ctx0; k++) {
      if (ops[k].t !== '+') oldStart++;
      if (ops[k].t !== '-') newStart++;
    }
    const chunk = [];
    for (let k = ctx0; k < ctx1; k++) {
      const o = ops[k];
      chunk.push(o.t + o.s);
      if (o.t !== '+') oc++;
      if (o.t !== '-') nc++;
    }
    out.push(`@@ -${oldStart},${oc} +${newStart},${nc} @@`);
    out.push(...chunk);
    bi = ctx1;
  }
  return out.length <= 2 ? '' : out.join('\n') + '\n';
}

function handleFsChange(fn) {
  const path = normRel(fn);
  if (!path || path.includes('.viewer') || path.endsWith('~')) return;
  if (pendingTimers.has(path)) clearTimeout(pendingTimers.get(path));
  pendingTimers.set(path, setTimeout(() => {
    pendingTimers.delete(path);
    const full = join(specsDir, path);
    let st, content;
    try {
      st = statSync(full);
      if (!st.isFile()) return;
      if (st.size > SNAP_MAX) {
        snapshots.delete(path);
        lastUnified.set(path, null);
        pushRing({ path, mtime: st.mtimeMs, ts: Date.now() });
        notify({ op: 'change', path, mtime: st.mtimeMs });
        return;
      }
      content = readFileSync(full, 'utf-8');
    } catch { return; }
    const old = snapshots.get(path);
    if (old === content) return;
    let unified = null;
    if (old !== undefined) unified = unifiedDiff(old, content, path) || null;
    snapshots.set(path, content);
    lastUnified.set(path, unified);
    pushRing({ path, mtime: st.mtimeMs, ts: Date.now() });
    notify({ op: 'change', path, mtime: st.mtimeMs });
  }, DEBOUNCE_MS));
}

const staticDir = fileURLToPath(new URL('../../templates/viewer/', import.meta.url));

// Cache-busting: version = source file mtime (ms), re-evaluated on every request so
// a touch/edit is visible on the next page load without restarting the server.
function staticVersion(name) {
  try { return Math.trunc(statSync(join(staticDir, name)).mtimeMs); } catch { return 0; }
}
function staticUrl(name) { return `/static/${name}?v=${staticVersion(name)}`; }

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light dark">
<title>Studio</title>
<link rel="icon" type="image/svg+xml" href="/static/studio-favicon.svg">
<script>(function(){try{var t=localStorage.getItem('sv-theme');if(t!=='dark'&&t!=='light')t='light';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t}catch(e){}})();</script>
<link rel="stylesheet" href="/static/viewer.css">
</head><body>
<header id="appbar">
  <svg class="brand-logo" viewBox="0 0 64 64" width="22" height="22" aria-hidden="true" style="vertical-align:middle;margin-right:6px"><rect x="2" y="2" width="60" height="60" rx="14" fill="#1a1a1a"/><rect x="2.75" y="2.75" width="58.5" height="58.5" rx="13.25" fill="none" stroke="#e07b3a" stroke-width="1.5" opacity="0.65"/><rect x="14" y="14" width="24" height="24" rx="4" fill="none" stroke="#e07b3a" stroke-width="3"/><rect x="22" y="22" width="24" height="24" rx="4" fill="none" stroke="#f2f2f2" stroke-width="3" opacity="0.9"/><circle cx="49" cy="49" r="4" fill="#e07b3a"/></svg><span class="brand">Studio · 工程台</span>
  <button type="button" id="sideToggle" title="展开侧栏" aria-label="展开侧栏" hidden>»</button>
  <nav id="apps" aria-label="应用">
    <button type="button" data-mode="pulse" aria-current="page">指挥台</button>
    <button type="button" data-mode="briefs">简报<span class="badge" hidden>0</span></button>
    <button type="button" data-mode="specs">规格<span class="badge" hidden>0</span></button>
    <button type="button" data-mode="domains">域<span class="badge" hidden>0</span></button>
    <button type="button" data-mode="bugs">上报<span class="badge" hidden>0</span></button>
    <button type="button" data-mode="performance">性能</button>
    <button type="button" data-mode="data">数据<span class="badge" hidden>0</span></button>
    <button type="button" data-mode="uikit">UI 控件库<span class="badge" hidden>0</span></button>
  </nav>
  <div id="appbar-end">
    <input id="q" type="text" placeholder="搜索…" spellcheck="false" autocomplete="off">
    <button type="button" id="toggleTheme" title="深色主题" aria-label="深色主题"><svg class="icon-moon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.2 1.05a.75.75 0 0 1 .22 1.04 6 6 0 1 0 7.49 7.49.75.75 0 0 1 1.26.8A7.5 7.5 0 1 1 5.16.83a.75.75 0 0 1 1.04.22Z"/></svg><svg class="icon-sun" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 3.25a.75.75 0 0 1 .75.75v.75a.75.75 0 0 1-1.5 0V4A.75.75 0 0 1 8 3.25Zm0 7.25a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.75-2.5a.75.75 0 0 1-.75.75h-.75a.75.75 0 0 1 0-1.5H13a.75.75 0 0 1 .75.75ZM4.5 8a.75.75 0 0 1-.75.75H3a.75.75 0 0 1 0-1.5h.75A.75.75 0 0 1 4.5 8Zm7.78 3.78a.75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 1 1 1.06-1.06l.53.53a.75.75 0 0 1 0 1.06ZM5.31 5.31a.75.75 0 0 1-1.06 0l-.53-.53A.75.75 0 0 1 4.78 3.72l.53.53a.75.75 0 0 1 0 1.06Zm6.38-1.06a.75.75 0 0 1 0 1.06l-.53.53A.75.75 0 1 1 10.1 4.78l.53-.53a.75.75 0 0 1 1.06 0ZM4.78 10.1a.75.75 0 0 1 1.06 1.06l-.53.53a.75.75 0 1 1-1.06-1.06l.53-.53ZM8 12.25a.75.75 0 0 1 .75.75v.75a.75.75 0 0 1-1.5 0V13a.75.75 0 0 1 .75-.75Z"/></svg></button>
  </div>
</header>
<div id="workspace">
<aside id="side"><div id="facet-head"><span>分类</span><button type="button" class="btn" id="toggleSide" title="折叠分类" aria-label="折叠分类">«</button></div><div id="tree"></div></aside>
<div id="main"><div id="chrome"><div id="bar"></div><div id="inbox-tools" hidden><button type="button" id="facetToggle" hidden>分类</button><div id="segs" class="seg" hidden></div></div></div><div id="content"></div></div>
</div>
<div id="drawer" hidden>
  <div id="drawer-mask" data-drawer-close></div>
  <div id="drawer-panel" role="dialog" aria-modal="true">
    <div id="drawer-bar"></div>
    <div id="drawer-scroll">
      <div id="drawer-body"></div>
      <iframe id="preview" title="预览" hidden></iframe>
    </div>
  </div>
</div>
<script type="module" src="/static/viewer.js"></script>
</body></html>`;

function renderPackages(packages) {
  return PAGE
    .replace('/static/viewer.css', staticUrl('viewer.css'))
    .replace('/static/viewer.js', staticUrl('viewer.js'));
}

function renderPackage(pkg) {
  const pkgOk = Object.values(pkg.packageDocs).filter(Boolean).length;
  let h = `<h1>${pkg.name}</h1><div class="file-meta"><span>Package docs: ${pkgOk}/${requiredPackageDocs.length}</span><span>Tracks: ${pkg.tracks.length}</span></div>`;
  h += `<h2>Package Documents</h2><table><tr><th>Document</th><th>Status</th><th>Standard</th></tr>`;
  for (const d of requiredPackageDocs) {
    const refs = { 'SPEC.md': '—', 'ARCH.md': 'IEEE 1016-2009', 'GLOSSARY.md': '—' };
    h += `<tr><td><a href="/file/${pkg.name}/${d}">${d}</a></td><td>${pkg.packageDocs[d]?'✅':'❌'}</td><td>${refs[d]||'—'}</td></tr>`;
  }
  h += '</table>';
  for (const t of pkg.tracks) {
    const ok = Object.values(t.docs).filter(Boolean).length;
    h += `<h2>${t.name}</h2><div class="file-meta"><span>Documents: ${ok}/${requiredTrackDocs.length}</span></div>`;
    h += `<table><tr><th>Document</th><th>Status</th><th>Standard</th></tr>`;
    const refs2 = { 'INPUT.md':'—','PRD.md':'IEEE 830-1998','TECH.md':'IEEE 1016-2009','TASK.md':'TASK State Machine','TRACE.md':'ISO/IEC/IEEE 29148:2018','REVIEW.md':'IEEE 1028-2008','TEST.md':'ISO/IEC/IEEE 29119-3','BUG.md':'IEEE 1044' };
    for (const d of requiredTrackDocs) {
      h += `<tr><td><a href="/file/${pkg.name}/${t.name}/${d}">${d}</a></td><td>${t.docs[d]?'✅':'❌'}</td><td>${refs2[d]}</td></tr>`;
    }
    h += '</table>';
  }
  return h;
}

function renderFile(path, content) {
  const ext = extname(path);
  if (ext === '.md') return renderMarkdown(path, content);
  return `<pre><code>${escapeHtml(content)}</code></pre>`;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderMarkdown(path, md) {
  const lines = md.split('\n');
  let html = '<div class="file-meta">';
  const fileName = path.split('/').pop();
  html += `<span>${fileName}</span><span>${lines.length} lines</span></div>`;
  let inTable = false, inCode = false, inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (inCode) { html += '</code></pre>'; inCode = false; }
      else { html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += escapeHtml(line) + '\n'; continue; }

    if (trimmed.startsWith('# ')) { html += `<h1>${escapeHtml(trimmed.slice(2))}</h1>`; continue; }
    if (trimmed.startsWith('## ')) { html += `<h2>${escapeHtml(trimmed.slice(3))}</h2>`; continue; }
    if (trimmed.startsWith('### ')) { html += `<h3>${escapeHtml(trimmed.slice(4))}</h3>`; continue; }

    if (trimmed.startsWith('> ')) {
      if (!inBlock) { html += '<blockquote>'; inBlock = true; }
      html += escapeHtml(trimmed.slice(2)) + '<br>';
      continue;
    }
    if (inBlock) { if (trimmed === '') { html += '</blockquote>'; inBlock = false; } else { html += escapeHtml(trimmed) + '<br>'; } continue; }

    if (trimmed.startsWith('---')) { html += '<hr>'; continue; }

    if (trimmed.startsWith('|')) {
      if (!inTable) { html += '<table>'; inTable = true; }
      const cells = trimmed.split('|').filter(c => c !== '').map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c))) continue;
      const tag = lines[i-1] && lines[i-1].trim().startsWith('|') && !/^[-:]+$/.test(lines[i-1]) ? 'td' : 'th';
      html += '<tr>' + cells.map(c => `<${tag}>${escapeHtml(c)}</${tag}>`).join('') + '</tr>';
      continue;
    }
    if (inTable && !trimmed.startsWith('|')) { html += '</table>'; inTable = false; }

    if (trimmed.startsWith('- ')) {
      html += `<li>${renderInline(trimmed.slice(2))}</li>`;
      while (i+1 < lines.length && lines[i+1].trim().startsWith('- ')) { i++; html += `<li>${renderInline(lines[i].trim().slice(2))}</li>`; }
      continue;
    }
    if (/^\d+\.\s/.test(trimmed)) {
      html += `<li>${renderInline(trimmed.replace(/^\d+\.\s/,''))}</li>`;
      continue;
    }

    if (trimmed === '') { html += '<p> </p>'; continue; }

    html += `<p>${renderInline(trimmed)}</p>`;
  }
  if (inCode) html += '</code></pre>';
  if (inBlock) html += '</blockquote>';
  if (inTable) html += '</table>';
  return html;
}

function renderInline(t) {
  return escapeHtml(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>');
}

const clients = [];
function notify(payload) {
  invalidatePulseCache();
  const data = JSON.stringify(payload || { op: 'reload' });
  for (const res of clients) {
    try { res.write(`data: ${data}\n\n`); } catch {}
  }
}

function restartForPulse(changedPath) {
  console.log(`  ↻  Restarting after ${changedPath}`);
  notify({ op: 'reload', path: 'src/serve/pulse.js' });
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    console.error('  ✗  Pulse restart spawn failed', err);
    return;
  }
  setTimeout(() => process.exit(0), 200);
}

function watchPulseModules() {
  const files = [fileURLToPath(new URL('./pulse.js', import.meta.url)), fileURLToPath(new URL('./pulse-lib.js', import.meta.url))];
  let timer = null;
  const kick = (fn) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => restartForPulse(fn), 400);
  };
  for (const f of files) {
    try { watch(f, () => kick(f)); } catch {}
  }
}

function pulseDeps() {
  return {
    packages: scan(),
    briefs: scanBriefs(),
    domains: scanDomains(),
    bugs: scanBugs(),
    specsDir,
    rootDir: resolve('.'),
    gateLatestPath: resolve('game/reports/merge-gate/latest_run.txt'),
  };
}

const STATIC_PATHS = {
  'viewer.css': join(staticDir, 'viewer.css'),
  'viewer.js': join(staticDir, 'viewer.js'),
  'performance-app.js': join(staticDir, 'performance-app.js'),
  'performance.css': join(staticDir, 'performance.css'),
  'spec-inbox.js': fileURLToPath(new URL('./inbox.js', import.meta.url)),
  'data-app.js': join(staticDir, 'data-app.js'),
  'data-studio.js': join(staticDir, 'data-studio.js'),
  'i18n/fields.zh.json': join(staticDir, 'i18n/fields.zh.json'),
  'ui-kit-app.js': join(staticDir, 'ui-kit-app.js'),
  'studio-favicon.svg': join(staticDir, 'studio-favicon.svg'),
};

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { resolveBody({}); return; }
      try { resolveBody(JSON.parse(raw)); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

const transition = createTransition();

const server = createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  // 常驻服务只读模式（SPECVIEWER_READONLY=1）：数据/上报写方法一律 403 read_only。
  // 本地工作树 serve 不设该变量，保留 PATCH /api/data/<stem>/<id> 表单编辑能力。
  if (READONLY && isWriteMethod(req.method) && (p === '/api/data' || p.startsWith('/api/data/') || p === '/api/bugs' || (p.startsWith('/api/bugs/') && !vaultWriteEnabled()))) {
    res.writeHead(403, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'read_only', hint: '编辑请在本机工作树启动 studio serve' }));
    return;
  }

  // 写路由来源闸（t-0915-305 硬化 B）：只读浏览（GET/HEAD）不受限，写请求必须来自回环。
  const allowLanWrite = (() => {
    if (String(process.env.SPECVIEWER_ALLOW_LAN_WRITE || '') !== '1') return false;
    return p === '/api/sync' || p === '/api/specviewer/transition' || p.startsWith('/api/bugs/');
  })();
  if (isWriteMethod(req.method) && !isLoopbackAddress(req.socket && req.socket.remoteAddress) && !allowLanWrite) {
    const from = String((req.socket && req.socket.remoteAddress) || '');
    res.writeHead(403, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not_local', message: `写路由只接受回环来源（收到 ${from || '未知'}）；只读浏览仍可访问`, from: null, to: null }));
    return;
  }

  // --- 状态流转（brief / bug）：矩阵校验 + Markdown 写回 ---
  if (req.method === 'POST' && p === '/api/specviewer/transition') {
    readJsonBody(req).then(async (body) => {
      const result = await transition.runTransition(body || {});
      res.writeHead(result.http, { 'Content-Type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify(result.body));
    }).catch((e) => {
      const invalid = e && e.message === 'invalid_json';
      res.writeHead(invalid ? 400 : 500, { 'Content-Type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: invalid ? 'invalid_json' : 'transition_error', message: String((e && e.message) || e) }));
    });
    return;
  }

  // 手动/轮询触发 vault-sync，缩短上报→Studio 可见窗口（默认 60s 内跳过；force 强制）。
  if (req.method === 'POST' && p === '/api/sync') {
    readJsonBody(req).then(async (body) => {
      const force = !!(body && body.force);
      const statusPath = resolve('game', 'reports', 'vault-sync.json');
      let lastAt = 0;
      try { lastAt = statSync(statusPath).mtimeMs; } catch { lastAt = 0; }
      const ageMs = Date.now() - lastAt;
      if (!force && lastAt > 0 && ageMs < 60000) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, skipped: true, reason: 'fresh', age_ms: ageMs }));
        return;
      }
      const syncScript = fileURLToPath(new URL('./vault-sync.js', import.meta.url));
      const started = Date.now();
      const child = spawn(process.execPath, [syncScript], { cwd: process.cwd(), env: process.env, windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += String(d); if (out.length > 8000) out = out.slice(-8000); });
      child.stderr.on('data', (d) => { err += String(d); if (err.length > 4000) err = err.slice(-4000); });
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, 120000);
      child.on('close', (code) => {
        clearTimeout(timer);
        let syncStatus = null;
        try { syncStatus = JSON.parse(readFileSync(statusPath, 'utf8')); } catch {}
        const written = syncStatus && typeof syncStatus.written === 'number' ? syncStatus.written : null;
        const ok = code === 0;
        res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok, code, duration_ms: Date.now() - started, written, skipped: false, sync: syncStatus ? { at: syncStatus.at, bugs: syncStatus.bugs, written: syncStatus.written } : null, stderr_tail: err.slice(-1200), stdout_tail: out.slice(-1200) }));
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'spawn_failed', detail: String((e && e.message) || e) }));
      });
    }).catch(() => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
    });
    return;
  }

  if (req.method === 'PATCH') {
    const mPatch = p.match(/^\/api\/bugs\/([^/]+)$/);
    if (mPatch) {
      let folder;
      try { folder = decodeURIComponent(mPatch[1]); } catch { folder = ''; }
      readJsonBody(req).then(async (body) => {
        let vault = null;
        if (vaultWriteEnabled()) {
          const b = body || {};
          const kindMap = { false_red: '已关闭 · 非缺陷', duplicate: '已关闭 · 重复', start_fix: '修复中', fixed: '已关闭', reopen: '新', cannot_reproduce: '已关闭 · 未复现' };
          const statusZh = String(b.status || (b.kind && kindMap[b.kind]) || '');
          vault = await patchVaultByLegacy({ bugsDir, folder, bugId: b.bugId || '', statusZh, reason: b.reason || b.historyNote || 'Studio 状态流转' });
          if (!vault.ok) {
            res.writeHead(vault.http || 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'vault_write_failed', vault, hint: 'Vault 权威未更新，展示缓存保持原状' }));
            return;
          }
        }
        const result = patchBugReadme(bugsDir, folder, body);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...(result.json || {}), vault: vault || { skipped: true } }));
      }).catch(() => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
      });
      return;
    }
    const mDataPatch = p.match(/^\/api\/data\/([^/]+)\/([^/]+)$/);
    if (mDataPatch) {
      let stem = '';
      let id = '';
      try {
        stem = decodeURIComponent(mDataPatch[1]);
        id = decodeURIComponent(mDataPatch[2]);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
        return;
      }
      readJsonBody(req).then((body) => {
        const result = patchEntry(dataRoots, {
          stem,
          id,
          collection: body.collection,
          entry: body.entry,
          expectedMtime: body.expectedMtime,
        });
        const status = result.status || (result.ok ? 200 : 500);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: !!result.ok,
          error: result.error || undefined,
          errors: result.errors,
          mtime: result.mtime,
          entry: result.entry,
        }));
      }).catch(() => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
      });
      return;
    }
  }

  if (p === '/ui-kit' || p.startsWith('/ui-kit/')) {
    const kitDir = resolve('docs/briefs/_shared/ui-kit');
    const rel = p === '/ui-kit' || p === '/ui-kit/' ? 'catalog.html' : decodeURIComponent(p.slice('/ui-kit/'.length));
    if (rel.includes('..') || isAbsolute(rel)) { res.writeHead(403); res.end('forbidden'); return; }
    const file = join(kitDir, rel);
    const full = resolve(file);
    if (!isInside(kitDir, full) || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return; }
    const ext = file.split('.').pop().toLowerCase();
    const types = { html:'text/html;charset=utf-8', css:'text/css;charset=utf-8', js:'text/javascript;charset=utf-8', json:'application/json;charset=utf-8', md:'text/markdown;charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(readFileSync(full));
    return;
  }
  if (p.startsWith('/static/')) {
    const name = p.slice('/static/'.length);
    const file = STATIC_PATHS[name];
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const body = readFileSync(file);
      const mime = name.endsWith('.css') ? 'text/css;charset=utf-8'
        : name.endsWith('.json') ? 'application/json;charset=utf-8'
          : name.endsWith('.svg') ? 'image/svg+xml'
            : 'text/javascript;charset=utf-8';
      // no-store (not bare no-cache): there is no ETag/Last-Modified, so no-cache cannot
      // revalidate and webviews may reuse a stale copy. no-store also covers viewer.js's
      // plain-child imports (spec-inbox.js / data-app.js / ui-kit-app.js).
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404); res.end('Not found'); }
    return;
  }

  if (req.url === '/events' || req.url.startsWith('/events?')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    clients.push(res);
    req.on('close', () => { const i = clients.indexOf(res); if (i >= 0) clients.splice(i, 1); });
    return;
  }

  // 仅 pulse 端点才装配扫描结果：旧写法对所有请求先求值 pulseDeps()，
  // 首页冷启动会白付 scan/scanBugs 的全量 fs 成本（首请求 17s）。
  if (p.startsWith('/api/performance/')) {
    handlePerformanceRequest(req, res, u).catch(() => { if (!res.headersSent) res.writeHead(503); res.end(); });
    return;
  }

  if ((p === '/api/pulse' || p === '/api/pulse/trends') && handlePulseRequest(u, res, pulseDeps())) return;

  if (p === '/api/packages') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scan()));
    return;
  }
  if (p === '/api/briefs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scanBriefs()));
    return;
  }
  if (p === '/api/bugs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scanBugs()));
    return;
  }
  if (p === '/api/domains') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scanDomains()));
    return;
  }
  if (p === '/api/ui-kit') {
    const kitDir = resolve('docs/briefs/_shared/ui-kit');
    const controlsPath = join(kitDir, 'controls.json');
    try {
      const raw = JSON.parse(readFileSync(controlsPath, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...raw, kitPath: 'docs/briefs/_shared/ui-kit' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: String(e && e.message || e) }));
    }
    return;
  }
  if (p === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listCatalog(dataRoots)));
    return;
  }
  if (p === '/api/sprite') {
    const r = spriteFile(dataRoots, u.searchParams.get('path') || '');
    if (!r.ok) {
      res.writeHead(r.status || 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: r.error }));
      return;
    }
    try {
      const buf = readFileSync(r.full);
      res.writeHead(200, { 'Content-Type': r.mime || 'image/png', 'Cache-Control': 'no-cache' });
      res.end(buf);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }
  const mDataEntry = p.match(/^\/api\/data\/([^/]+)\/([^/]+)$/);
  if (mDataEntry && req.method === 'GET') {
    let stem = '';
    let id = '';
    try { stem = decodeURIComponent(mDataEntry[1]); id = decodeURIComponent(mDataEntry[2]); } catch { stem = ''; }
    const col = u.searchParams.get('collection') || u.searchParams.get('col') || '';
    const payload = entryPayload(dataRoots, stem, id, col);
    const status = payload.status || (payload.ok ? 200 : 404);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  const mDataFile = p.match(/^\/api\/data\/([^/]+)$/);
  if (mDataFile && req.method === 'GET') {
    let stem = '';
    try { stem = decodeURIComponent(mDataFile[1]); } catch { stem = ''; }
    const col = u.searchParams.get('collection') || u.searchParams.get('col') || '';
    const payload = filePayload(dataRoots, stem, col);
    const status = payload.status || (payload.ok ? 200 : 404);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  if (p === '/api/changes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ changes: recentChanges }));
    return;
  }
  if (p === '/api/diff') {
    const rel = normRel(u.searchParams.get('path') || '');
    if (!rel || rel.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad path' }));
      return;
    }
    const ring = recentChanges.find(c => c.path === rel);
    const hasSnap = snapshots.has(rel);
    const unified = lastUnified.has(rel) ? lastUnified.get(rel) : null;
    const baseline = unified ? 'snapshot' : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      path: rel,
      mtime: ring ? ring.mtime : (hasSnap ? null : null),
      ts: ring ? ring.ts : null,
      baseline,
      unified,
      seen: !!ring || lastUnified.has(rel)
    }));
    return;
  }

  // 首页只返回静态 PAGE（renderPackages 不消费扫描结果）；packages 扫描推迟到
  // 真正需要的 /pkg 路由，避免首页冷启动全量 stat/read。
  let data = null;
  const scanned = () => (data || (data = scan()));
  const dash = (c, h) => { res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end(c ? renderPackages() : h); };
  if (p === '/') { dash(false, renderPackages()); return; }
  const mPkg = p.match(/^\/pkg\/([^/]+)$/);
  if (mPkg) {
    const pkg = scanned().find(x => x.name === mPkg[1]);
    if (pkg) { dash(false, renderPackage(pkg)); return; }
  }
  const mFile = p.match(/^\/file\/(.+)$/);
  if (mFile) {
    const content = getFileContent(mFile[1]);
    if (content !== null) { dash(false, renderFile(mFile[1], content)); return; }
  }
  const mBriefFile = p.match(/^\/brief-file\/(.+)$/);
  if (mBriefFile) {
    let rel;
    try { rel = decodeURIComponent(mBriefFile[1]); } catch { res.writeHead(400); res.end('bad path'); return; }
    if (rel.includes('..')) { res.writeHead(400); res.end('bad path'); return; }
    const content = getBriefContent(rel);
    if (content === null) { res.writeHead(404); res.end('Not found'); return; }
    const html = extname(rel) === '.md' ? renderMarkdown(rel, content) : `<pre>${escapeHtml(content)}</pre>`;
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    res.end(html);
    return;
  }
  const mBriefStatic = p.match(/^\/brief-static\/(.+)$/);
  if (mBriefStatic) {
    let rel;
    try { rel = decodeURIComponent(mBriefStatic[1]); } catch { res.writeHead(400); res.end('bad path'); return; }
    if (rel.includes('..')) { res.writeHead(400); res.end('bad path'); return; }
    const folder = rel.split('/')[0] || '';
    const ext = extname(rel).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      const content = getBriefContent(rel);
      if (content === null) { res.writeHead(404); res.end('Not found'); return; }
      const base = `/brief-static/${encodeURI(folder)}/`;
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Content-Security-Policy': 'sandbox allow-same-origin allow-scripts allow-popups' });
      res.end(injectBase(content, base));
      return;
    }
    const buf = readUnder(briefsDir, rel, false);
    if (buf === null) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeFor(rel), 'Cache-Control': 'no-cache' });
    res.end(buf);
    return;
  }
  const mBugFile = p.match(/^\/bug-file\/(.+)$/);
  if (mBugFile) {
    let rel;
    try { rel = decodeURIComponent(mBugFile[1]); } catch { res.writeHead(400); res.end('bad path'); return; }
    if (rel.includes('..')) { res.writeHead(400); res.end('bad path'); return; }
    const ext = extname(rel).toLowerCase();
    if (ext === '.md') {
      const content = readUnder(bugsDir, rel, true);
      if (content === null) { res.writeHead(404); res.end('Not found'); return; }
      if (u.searchParams.get('raw') === '1') {
        res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(content);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end(renderMarkdown(rel, content));
      return;
    }
    const buf = readUnder(bugsDir, rel, false);
    if (buf === null) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeFor(rel), 'Cache-Control': 'no-cache' });
    res.end(buf);
    return;
  }
  res.writeHead(404); res.end('Not found');
});

export { scan, scanBriefs, scanBugs, scanDomains, parseBugReadme, PORT, PAGE, bugsDir, startServer };

/** 开源 / 新克隆场景自愈：Git 不跟踪空目录，运行所需目录可能尚不存在。
 *  启动时 mkdir -p，否则 recursive watch 会因 ENOENT 直接崩掉服务。 */
function ensureRuntimeDirs() {
  for (const dir of [specsDir, briefsDir, bugsDir, dataWatchDir]) {
    if (existsSync(dir)) continue;
    try {
      mkdirSync(dir, { recursive: true });
      console.log(`  + 创建缺失目录 ${dir}`);
    } catch (e) {
      console.error(`  ✗ 创建目录失败 ${dir}: ${(e && e.message) || e}`);
    }
  }
}

function startServer() {
  ensureRuntimeDirs();
  try {
    const out = execSync(portSweepCommand(LISTEN_PORT), { shell: true, stdio: 'pipe', timeout: 3000 });
    // 只清扫真正 LISTENING 的占用者（别杀连过来的客户端，也别自杀/弑父）—— 2026-09-18 事故回归。
    for (const pid of pickListenerPids(out.toString())) {
      try { process.kill(pid); } catch {}
    }
  } catch {}

  (function tryListen(n) {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && n < 20) {
        setTimeout(() => tryListen(n + 1), 250);
        return;
      }
      if (err.code === 'EADDRINUSE') {
        console.error(`  ✗  Port ${LISTEN_PORT} already in use. Stop the other Spec Viewer and retry.`);
        process.exit(1);
      }
      console.error(err);
      process.exit(1);
    });
    server.listen(LISTEN_PORT, BIND.host, () => {
      console.log(`  📋 Studio viewer at http://localhost:${LISTEN_PORT}`);
      console.log('    打开浏览器访问，或按 Ctrl+C 退出');
      if (BIND.allowLan) {
        for (const line of bindWarningLines(BIND.host, LISTEN_PORT)) console.log(line);
      } else {
        console.log(bindLoopbackLine(BIND.host, LISTEN_PORT));
      }
    });
  })(0);

  walkSeed(specsDir);
  try {
    watch(specsDir, { recursive: true }, (ev, fn) => { if (fn) handleFsChange(fn); });
  } catch (e) {
    console.error('  ✗ watch specs 失败（变更检测不可用）:', (e && e.message) || e);
  }
  try {
    watch(briefsDir, { recursive: true }, (ev, fn) => {
      if (fn) notify({ op: 'reload', path: 'briefs/' + String(fn).replace(/\\/g, '/') });
    });
  } catch {}
  try {
    watch(bugsDir, { recursive: true }, (ev, fn) => {
      if (fn) notify({ op: 'reload', path: 'bugs/' + String(fn).replace(/\\/g, '/') });
    });
  } catch {}
  try {
    watch(dataWatchDir, { recursive: true }, (ev, fn) => {
      if (fn) notify({ op: 'reload', path: 'game/src/data/' + String(fn).replace(/\\/g, '/') });
    });
  } catch {}
  watchPulseModules();
}

if (isMainModule()) startServer();
