/**
 * Pulse KPI / trends assembly. Scanner results are injected — no second walker.
 * Git via injectable exec (child_process.execFileSync by default).
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { briefSegment } from './inbox.js';
import {
  parsePulseWindow,
  resolveBucket,
  parseNumstatText,
  parseNameStatusText,
  volumeFromFiles,
  pieSlices,
  countBy,
  briefPieKey,
  countOpenTaskRows,
  inWindow,
  groupAddedByDay,
  eachBucket,
  bucketKey,
  jsonHasSubjectArrays,
  todayStr,
  classifyNumstatPath,
  parseLessonStatus,
  lessonDayFromName,
  businessSubdir,
  specsPackageKey,
  e2eDomainKey,
  emptyPrefixCounts,
  extractSubmittedBugId,
  classifyPulseBugKind,
} from './pulse-lib.js';

let gitCache = { key: '', data: null, ts: 0 };
let headMixCache = { ts: 0, data: null };
const GIT_TTL_MS = 15_000;

export function invalidatePulseCache() {
  gitCache = { key: '', data: null, ts: 0 };
  headMixCache = { ts: 0, data: null };
}

export function defaultExecGit(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: opts.timeout || 45_000,
    maxBuffer: 32 * 1024 * 1024,
    cwd: opts.cwd,
    windowsHide: true,
  });
}

function runGit(execGit, args, cwd) {
  try {
    return { ok: true, text: String(execGit(args, { cwd }) || '') };
  } catch {
    return { ok: false, text: '' };
  }
}

export function countOpenTasks(packages, specsDir, readFile = readFileSync) {
  let n = 0;
  for (const pkg of packages || []) {
    for (const t of pkg.tracks || []) {
      const p = join(specsDir, t.path, 'TASK.md');
      let md = '';
      try { md = readFile(p, 'utf8'); } catch { continue; }
      n += countOpenTaskRows(md);
    }
  }
  return n;
}

export function readGateStatus(latestPath, readFile = readFileSync, exists = existsSync) {
  if (!latestPath || !exists(latestPath)) {
    return { gate: 'missing', degraded: true };
  }
  let ptr = '';
  try { ptr = String(readFile(latestPath, 'utf8')).trim(); } catch {
    return { gate: 'missing', degraded: true };
  }
  if (!ptr) return { gate: 'missing', degraded: true };
  const jsonPath = join(ptr, 'gate_report.json');
  const mdPath = join(ptr, 'gate_report.md');
  try {
    const raw = readFile(jsonPath, 'utf8');
    const j = JSON.parse(raw);
    const v = String(j.verdict || j.status || '').toUpperCase();
    if (v === 'PASS' || v === 'GREEN' || v === 'OK') return { gate: 'green', degraded: false };
    if (v === 'FAIL' || v === 'RED') return { gate: 'red', degraded: false };
  } catch {}
  try {
    const md = String(readFile(mdPath, 'utf8'));
    if (/VERDICT\s+PASS/i.test(md) || /\*\*PASS\*\*/.test(md)) return { gate: 'green', degraded: false };
    if (/VERDICT\s+FAIL/i.test(md) || /\*\*FAIL\*\*/.test(md)) return { gate: 'red', degraded: false };
  } catch {}
  return { gate: 'missing', degraded: true };
}

function parseWorktrees(text) {
  const porcelain = String(text || '').split(/\r?\n/).filter((l) => /^worktree /i.test(l));
  if (porcelain.length) return porcelain.length;
  return String(text || '').split(/\r?\n/).filter((l) => l.trim()).length;
}

function parsePorcelainCount(text) {
  return String(text || '').split(/\r?\n/).filter((l) => l.trim()).length;
}

export function firstTrackDaysFromAdds(nameStatusText, packages) {
  const earliest = new Map();
  let date = null;
  for (const line of String(nameStatusText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      date = trimmed;
      continue;
    }
    const m = line.match(/^A\t(.+)$/);
    if (!m || !date) continue;
    const p = m[1].replace(/\\/g, '/');
    const parts = p.split('/');
    if (parts[0] !== 'specs' || parts.length < 3) continue;
    const key = `${parts[1]}/${parts[2]}`;
    if (!earliest.has(key) || date < earliest.get(key)) earliest.set(key, date);
  }
  const out = new Map();
  for (const pkg of packages || []) {
    for (const t of pkg.tracks || []) {
      const k = `${pkg.name}/${t.name}`.replace(/\\/g, '/');
      const path = String(t.path || k).replace(/\\/g, '/');
      if (earliest.has(path) || earliest.has(k)) {
        out.set(t.path, earliest.get(path) || earliest.get(k));
      }
    }
  }
  return out;
}

function mtimeDay(filePath) {
  try {
    const st = statSync(filePath);
    const d = st.mtime;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return null;
  }
}

export function buildPulseKpis(deps = {}) {
  const packages = deps.packages || [];
  const briefs = deps.briefs || [];
  const specsDir = deps.specsDir;
  const execGit = deps.execGit || defaultExecGit;
  const cwd = deps.rootDir;
  const readFile = deps.readFile || readFileSync;
  const exists = deps.exists || existsSync;

  const briefsDraft = briefs.filter((b) => briefSegment(b.status) === 'draft').length;
  const briefsReady = briefs.filter((b) => briefSegment(b.status) === 'ready').length;
  const openTasks = countOpenTasks(packages, specsDir, readFile);

  const gateInfo = readGateStatus(deps.gateLatestPath, readFile, exists);
  const degraded = {};
  if (gateInfo.degraded) degraded.gate = true;

  const kpis = {
    openTasks,
    briefsDraft,
    briefsReady,
    gate: gateInfo.gate,
  };

  const st = runGit(execGit, ['status', '--porcelain'], cwd);
  const wt = runGit(execGit, ['worktree', 'list', '--porcelain'], cwd);
  if (!st.ok && !wt.ok) {
    degraded.git = true;
  } else {
    if (st.ok) kpis.dirtyFiles = parsePorcelainCount(st.text);
    else { degraded.git = true; }
    if (wt.ok) kpis.worktrees = parseWorktrees(wt.text) || 1;
    else {
      degraded.git = true;
      if (kpis.dirtyFiles == null) { /* omit */ }
    }
  }

  const body = { ok: true, kpis, degraded };
  return { status: 200, body };
}

function repoEarliestDay(execGit, cwd) {
  const roots = runGit(execGit, ['rev-list', '--max-parents=0', 'HEAD'], cwd);
  if (roots.ok) {
    const sha = String(roots.text).trim().split(/\s+/)[0];
    if (sha) {
      const d = runGit(execGit, ['log', '-1', '--format=%cs', sha], cwd);
      if (d.ok) {
        const day = String(d.text).trim().split(/\r?\n/)[0];
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
      }
    }
  }
  const log = runGit(execGit, ['log', '--format=%cs', '--reverse'], cwd);
  if (log.ok) {
    const day = String(log.text).trim().split(/\r?\n/)[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  }
  return null;
}

function loadGitWindow(execGit, cwd, from, to, detailFiles) {
  const key = `${from}|${to}|${detailFiles ? 1 : 0}`;
  if (gitCache.key === key && gitCache.data && Date.now() - gitCache.ts < GIT_TTL_MS) {
    return gitCache.data;
  }
  const until = `${to}T23:59:59`;
  const since = `${from}T00:00:00`;
  const num = runGit(execGit, [
    'log', '--numstat', '--format=%H%x09%cs%x09%s',
    `--since=${since}`, `--until=${until}`,
  ], cwd);
  const adds = runGit(execGit, [
    'log', '--diff-filter=A', '--name-status', '--format=%cs',
    '--', 'specs',
  ], cwd);
  const names = runGit(execGit, [
    'log', '--name-status', '--format=%H%x09%cs',
    `--since=${since}`, `--until=${until}`,
  ], cwd);
  const earliest = repoEarliestDay(execGit, cwd);
  const data = {
    gitOk: num.ok,
    addsOk: adds.ok,
    numstat: num.ok ? parseNumstatText(num.text) : new Map(),
    addsText: adds.ok ? adds.text : '',
    nameEvents: names.ok ? parseNameStatusText(names.text) : [],
    earliest,
  };
  gitCache = { key, data, ts: Date.now() };
  return data;
}

function collectWindowFiles(byDay, from, to) {
  const files = [];
  for (const [day, rec] of byDay) {
    if (!inWindow(day, from, to)) continue;
    for (const f of rec.files || []) files.push(f);
  }
  return files;
}

function walkRel(rootDir, rel, acc, filter) {
  const abs = rel ? join(rootDir, ...rel.split('/')) : rootDir;
  let ents;
  try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.godot' || e.name === '.mcp') continue;
    const norm = (rel ? `${rel}/${e.name}` : e.name).replace(/\\/g, '/');
    if (e.isDirectory()) walkRel(rootDir, norm, acc, filter);
    else if (!filter || filter(norm)) acc.push(norm);
  }
}

function readUtf(rootDir, rel, readFile) {
  try {
    return String(readFile(join(rootDir, ...rel.split('/')), 'utf8'));
  } catch {
    return '';
  }
}

function countGutFuncs(rootDir, readFile) {
  const files = [];
  walkRel(rootDir, 'game/tests', files, (p) => /\.gd$/i.test(p));
  let n = 0;
  for (const p of files) {
    const md = readUtf(rootDir, p, readFile);
    const hits = md.match(/^\s*func\s+test_/gm);
    if (hits) n += hits.length;
  }
  return n;
}

function listE2eJson(rootDir) {
  const files = [];
  walkRel(rootDir, 'specs', files, (p) => /\/e2e\/[^/]+\.json$/i.test(p));
  return files;
}

function scanLessons(rootDir, readFile) {
  const files = [];
  walkRel(rootDir, 'docs/lessons', files, (p) => {
    if (!/\.md$/i.test(p)) return false;
    const base = p.split('/').pop();
    return base !== 'INDEX.md' && base !== 'proposals.md' && base !== 'README.md';
  });
  return files.map((p) => {
    const base = p.split('/').pop();
    return {
      path: p,
      day: lessonDayFromName(base),
      status: parseLessonStatus(readUtf(rootDir, p, readFile)),
    };
  });
}

function countFilesBy(rootDir, rel, keyFn, filter) {
  const files = [];
  walkRel(rootDir, rel, files, filter);
  const map = new Map();
  for (const p of files) {
    const key = keyFn(p);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([key, count]) => ({ key, label: key, count }));
}

function gameMixPie(rootDir) {
  const src = [];
  const tests = [];
  const other = [];
  walkRel(rootDir, 'game/src', src);
  walkRel(rootDir, 'game/tests', tests);
  walkRel(rootDir, 'game', other, (p) => {
    const n = String(p || '').replace(/\\/g, '/');
    if (n.startsWith('game/src/') || n === 'game/src') return false;
    if (n.startsWith('game/tests/') || n === 'game/tests') return false;
    if (n.startsWith('game/reports/') || n.startsWith('game/.mcp/')) return false;
    return true;
  });
  return [
    { key: 'src', label: 'game/src 业务', count: src.length },
    { key: 'tests', label: 'game/tests 测试', count: tests.length },
    { key: 'other', label: 'game 其它', count: other.length },
  ].filter((x) => x.count > 0);
}

function scanHeadMix(deps) {
  if (deps.headMix) return deps.headMix;
  if (headMixCache.data && Date.now() - headMixCache.ts < GIT_TTL_MS && !deps.skipHeadCache) {
    return headMixCache.data;
  }
  const rootDir = deps.rootDir;
  const readFile = deps.readFile || readFileSync;
  if (!rootDir) {
    return {
      businessPie: [], jsonPie: [], testsPie: [], specsPie: [], toolchainPie: [], gamePie: [],
      lessons: [], e2eJson: [], gutFuncs: 0,
    };
  }
  const businessPie = countFilesBy(rootDir, 'game/src', (p) => businessSubdir(p), (p) => {
    const kind = classifyNumstatPath(p);
    return kind === 'business';
  });
  const jsonPie = countFilesBy(rootDir, 'game/src', (p) => {
    const n = p.replace(/\\/g, '/');
    if (n.startsWith('game/src/data/')) return 'data';
    if (n.startsWith('game/src/schemas/')) return 'schemas';
    return null;
  }, (p) => classifyNumstatPath(p) === 'json');
  const testsPie = countFilesBy(rootDir, 'game/tests', (p) => {
    const parts = p.replace(/\\/g, '/').split('/');
    return parts[2] || 'tests';
  }, (p) => classifyNumstatPath(p) === 'tests');
  const specsPie = countFilesBy(rootDir, 'specs', (p) => specsPackageKey(p), (p) => classifyNumstatPath(p) === 'specs');
  const toolchainPie = [
    ...countFilesBy(rootDir, 'scripts', () => 'scripts', () => true),
    ...countFilesBy(rootDir, 'tools/test', () => 'tools-test', () => true),
  ];
  const gamePie = gameMixPie(rootDir);
  const data = {
    businessPie,
    jsonPie,
    testsPie,
    specsPie,
    toolchainPie,
    gamePie,
    lessons: scanLessons(rootDir, readFile),
    e2eJson: listE2eJson(rootDir),
    gutFuncs: countGutFuncs(rootDir, readFile),
  };
  headMixCache = { ts: Date.now(), data };
  return data;
}

function churnByKind(byDay, from, to, bucket, kind) {
  const keys = eachBucket(from, to, bucket);
  const map = new Map(keys.map((k) => [k, { day: k, plus: 0, minus: 0 }]));
  for (const [day, rec] of byDay) {
    if (!inWindow(day, from, to)) continue;
    const k = bucketKey(day, bucket);
    const acc = map.get(k);
    if (!acc) continue;
    for (const f of rec.files || []) {
      if (f.binary) continue;
      if (classifyNumstatPath(f.path) !== kind) continue;
      acc.plus += Number(f.plus) || 0;
      acc.minus += Number(f.minus) || 0;
    }
  }
  return keys.map((d) => map.get(d));
}

function commitTypesByDay(byDay, from, to, bucket) {
  const keys = eachBucket(from, to, bucket);
  const map = new Map(keys.map((k) => [k, { day: k, ...emptyPrefixCounts() }]));
  for (const [day, rec] of byDay) {
    if (!inWindow(day, from, to)) continue;
    const k = bucketKey(day, bucket);
    const acc = map.get(k);
    if (!acc) continue;
    const p = rec.prefixes || emptyPrefixCounts();
    acc.feat += p.feat || 0;
    acc.fix += p.fix || 0;
    acc.test += p.test || 0;
    acc.docs += p.docs || 0;
    acc.other += p.other || 0;
  }
  return keys.map((d) => map.get(d));
}

function casesByDay(nameEvents, byDay, from, to, bucket) {
  const keys = eachBucket(from, to, bucket);
  const map = new Map(keys.map((k) => [k, {
    day: k, gutAdded: 0, gutDeleted: 0, e2eAdded: 0, e2eDeleted: 0,
  }]));
  const events = nameEvents || [];
  if (events.length) {
    for (const ev of events) {
      if (!inWindow(ev.day, from, to)) continue;
      const k = bucketKey(ev.day, bucket);
      const acc = map.get(k);
      if (!acc) continue;
      const kind = classifyNumstatPath(ev.path);
      if (kind === 'tests') {
        if (ev.status === 'A') acc.gutAdded += 1;
        if (ev.status === 'D') acc.gutDeleted += 1;
      } else if (kind === 'cases') {
        if (ev.status === 'A') acc.e2eAdded += 1;
        if (ev.status === 'D') acc.e2eDeleted += 1;
      }
    }
  } else {
    for (const [day, rec] of byDay) {
      if (!inWindow(day, from, to)) continue;
      const k = bucketKey(day, bucket);
      const acc = map.get(k);
      if (!acc) continue;
      const seen = new Set();
      for (const f of rec.files || []) {
        const kind = classifyNumstatPath(f.path);
        if (kind !== 'tests' && kind !== 'cases') continue;
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        if (kind === 'tests') acc.gutAdded += 1;
        else acc.e2eAdded += 1;
      }
    }
  }
  return keys.map((d) => map.get(d));
}

function lessonsByDay(lessons, from, to, bucket) {
  const dates = (lessons || []).map((l) => l.day).filter(Boolean);
  return groupAddedByDay(dates, from, to, bucket);
}

function readJsonSafe(abs, readFile) {
  try {
    return JSON.parse(String(readFile(abs, 'utf8')));
  } catch {
    return null;
  }
}

function listDirNames(abs, exists) {
  if (!exists(abs)) return [];
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function readLocalRuns(deps = {}) {
  if (deps.runs) return deps.runs;
  const rootDir = deps.rootDir;
  const readFile = deps.readFile || readFileSync;
  const exists = deps.exists || existsSync;
  if (!rootDir) return { empty: true, bars: [], latestE2e: null, latestGate: null, bugs: 0, bugsValid: 0, bugsFalseRed: 0 };
  const statusById = new Map();
  for (const b of deps.bugs || []) {
    if (b && b.bugId) statusById.set(String(b.bugId), b.status);
  }
  const barsMap = new Map();
  let latestE2e = null;
  const vlmRoot = join(rootDir, 'game', '.mcp', 'e2e', 'vlm');
  for (const name of listDirNames(vlmRoot, exists)) {
    const reportPath = join(vlmRoot, name, 'report.json');
    if (!exists(reportPath)) continue;
    const j = readJsonSafe(reportPath, readFile);
    if (!j || typeof j !== 'object') continue;
    const passed = Number(j.passed) || 0;
    const total = Number(j.total_ran) || 0;
    const failed = Math.max(0, total - passed);
    const started = String(j.started_at || '').slice(0, 10);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(started) ? started : null;
    const bugId = extractSubmittedBugId(j.bug_report);
    let bugs = 0;
    let bugsValid = 0;
    let bugsFalseRed = 0;
    if (bugId) {
      bugs = 1;
      if (classifyPulseBugKind(statusById.get(bugId)) === 'false_red') bugsFalseRed = 1;
      else bugsValid = 1;
    }
    const rec = {
      id: name,
      passed,
      failed,
      total,
      ok: !!j.ok,
      started_at: j.started_at || null,
      bugId,
      bugs,
      bugsValid,
      bugsFalseRed,
    };
    if (!latestE2e || String(j.started_at || '') > String(latestE2e.started_at || '')) {
      latestE2e = rec;
    }
    if (day) {
      const acc = barsMap.get(day) || {
        day, passed: 0, failed: 0, bugs: 0, bugsValid: 0, bugsFalseRed: 0,
      };
      acc.passed += passed;
      acc.failed += failed;
      acc.bugs += bugs;
      acc.bugsValid += bugsValid;
      acc.bugsFalseRed += bugsFalseRed;
      barsMap.set(day, acc);
    }
  }
  const gateInfo = readGateStatus(deps.gateLatestPath, readFile, exists);
  const latestGate = { gate: gateInfo.gate, degraded: gateInfo.degraded };
  const bars = [...barsMap.values()].sort((a, b) => a.day.localeCompare(b.day));
  const tot = bars.reduce((s, r) => {
    s.bugs += r.bugs || 0;
    s.bugsValid += r.bugsValid || 0;
    s.bugsFalseRed += r.bugsFalseRed || 0;
    return s;
  }, { bugs: 0, bugsValid: 0, bugsFalseRed: 0 });
  return {
    empty: bars.length === 0 && !latestE2e,
    bars,
    latestE2e,
    latestGate,
    bugs: tot.bugs,
    bugsValid: tot.bugsValid,
    bugsFalseRed: tot.bugsFalseRed,
  };
}

function filterRunBars(runs, from, to, bucket) {
  const keys = eachBucket(from, to, bucket);
  const map = new Map(keys.map((k) => [k, {
    day: k, passed: 0, failed: 0, bugs: 0, bugsValid: 0, bugsFalseRed: 0,
  }]));
  let any = false;
  for (const row of runs.bars || []) {
    if (!inWindow(row.day, from, to)) continue;
    const k = bucketKey(row.day, bucket);
    const acc = map.get(k);
    if (!acc) continue;
    acc.passed += row.passed || 0;
    acc.failed += row.failed || 0;
    acc.bugs += row.bugs || 0;
    acc.bugsValid += row.bugsValid || 0;
    acc.bugsFalseRed += row.bugsFalseRed || 0;
    if (acc.passed || acc.failed || acc.bugs) any = true;
  }
  const bars = keys.map((d) => map.get(d));
  const tot = bars.reduce((s, r) => {
    s.bugs += r.bugs || 0;
    s.bugsValid += r.bugsValid || 0;
    s.bugsFalseRed += r.bugsFalseRed || 0;
    return s;
  }, { bugs: 0, bugsValid: 0, bugsFalseRed: 0 });
  return {
    empty: !!(runs.empty && !any),
    bars,
    latestE2e: runs.latestE2e || null,
    latestGate: runs.latestGate || null,
    bugs: tot.bugs,
    bugsValid: tot.bugsValid,
    bugsFalseRed: tot.bugsFalseRed,
  };
}

function emptyCodeRhythm() {
  const emptyTrend = [];
  return {
    code: {
      business: { byDay: emptyTrend, pie: [] },
      json: { byDay: emptyTrend, pie: [] },
      tests: { byDay: emptyTrend, pie: [] },
      cases: { byDay: emptyTrend, pie: [], gutFuncs: 0 },
      runs: { empty: true, bars: [], latestE2e: null, latestGate: null, bugs: 0, bugsValid: 0, bugsFalseRed: 0 },
      game: { pie: [] },
    },
    rhythm: {
      commitTypes: { byDay: emptyTrend, pie: [] },
      lessons: { byDay: emptyTrend, pie: [] },
      specs: { byDay: emptyTrend, pie: [] },
      toolchain: { byDay: emptyTrend, pie: [] },
    },
  };
}

function dailyRows(byDay, from, to, bucket) {
  const keys = eachBucket(from, to, 'day');
  const out = keys.map((day) => {
    const rec = byDay.get(day);
    if (!rec) return { day, commits: 0, plus: 0, minus: 0, textFiles: 0, binaries: 0 };
    return {
      day,
      commits: rec.commits,
      plus: rec.plus,
      minus: rec.minus,
      textFiles: rec.textFiles.size,
      binaries: rec.binaries.size,
    };
  });
  if (bucket !== 'day') {
    const map = new Map();
    for (const row of out) {
      const k = bucketKey(row.day, bucket);
      const acc = map.get(k) || { day: k, commits: 0, plus: 0, minus: 0, textFiles: 0, binaries: 0 };
      acc.commits += row.commits;
      acc.plus += row.plus;
      acc.minus += row.minus;
      acc.textFiles += row.textFiles;
      acc.binaries += row.binaries;
      map.set(k, acc);
    }
    return eachBucket(from, to, bucket).map((day) => map.get(day) || {
      day, commits: 0, plus: 0, minus: 0, textFiles: 0, binaries: 0,
    });
  }
  return out;
}

function gitSeries(daily) {
  const activity = daily.map((d) => ({
    day: d.day,
    commits: d.commits,
    plus: d.plus,
    minus: d.minus,
  }));
  let c = 0, p = 0;
  const cumulative = daily.map((d) => {
    c += d.commits;
    p += d.plus;
    return { day: d.day, commits: c, plus: p, briefs: 0 };
  });
  return { activity, cumulative };
}

function mergeBriefCumulative(cumulative, briefByDay) {
  const map = new Map((briefByDay || []).map((b) => [b.day, b.cumulative]));
  return cumulative.map((row) => ({
    ...row,
    briefs: map.has(row.day) ? map.get(row.day) : row.briefs,
  }));
}

export function buildPulseTrends(query, deps = {}) {
  const today = deps.today || todayStr();
  const execGit = deps.execGit || defaultExecGit;
  const cwd = deps.rootDir;
  const packages = deps.packages || [];
  const briefs = deps.briefs || [];
  const domains = deps.domains || [];
  const bugs = deps.bugs || [];
  const specsDir = deps.specsDir;
  const detailFiles = query.detail === 'files' || query.detail === '1';

  const preEarliest = deps.repoEarliest != null ? deps.repoEarliest : null;
  const parsed = parsePulseWindow({
    from: query.from,
    to: query.to,
    window: query.window,
    today,
    repoEarliest: preEarliest,
    maxDays: 730,
  });
  if (parsed.error) {
    return { status: 400, body: { ok: false, error: parsed.error } };
  }

  const git = loadGitWindow(execGit, cwd, parsed.from, parsed.to, detailFiles);
  let from = parsed.from;
  let to = parsed.to;
  let clipped = parsed.clipped;
  if (!preEarliest && git.earliest && query.window === 'all') {
    const again = parsePulseWindow({
      window: 'all',
      today,
      repoEarliest: git.earliest,
      maxDays: 730,
    });
    if (!again.error) {
      from = again.from;
      to = again.to;
      clipped = again.clipped || clipped;
    }
  }

  const bucket = resolveBucket(from, to, query.bucket);
  const degraded = {};
  if (!git.gitOk) degraded.git = true;

  const daily = dailyRows(git.numstat, from, to, 'day');
  const { activity, cumulative: cum0 } = gitSeries(daily);
  const briefDates = briefs.map((b) => b.date).filter(Boolean);
  const briefsTrend = groupAddedByDay(briefDates, from, to, bucket);
  const briefDayCum = groupAddedByDay(briefDates, from, to, 'day');
  const cumulative = mergeBriefCumulative(cum0, briefDayCum);

  const bucketDaily = dailyRows(git.numstat, from, to, bucket);
  const bucketActivity = bucketDaily.map((d) => ({
    day: d.day, commits: d.commits, plus: d.plus, minus: d.minus,
  }));
  let bc = 0, bp = 0, bb = 0;
  const briefBucketMap = new Map(briefsTrend.map((x) => [x.day, x.cumulative]));
  const bucketCumulative = bucketDaily.map((d) => {
    bc += d.commits;
    bp += d.plus;
    bb = briefBucketMap.has(d.day) ? briefBucketMap.get(d.day) : bb;
    return { day: d.day, commits: bc, plus: bp, briefs: bb };
  });

  const files = collectWindowFiles(git.numstat, from, to);
  const volume = volumeFromFiles(files, { detailFiles });

  const trackDays = firstTrackDaysFromAdds(git.addsText, packages);
  let tracksDegraded = !git.addsOk;
  for (const pkg of packages) {
    for (const t of pkg.tracks || []) {
      if (trackDays.has(t.path)) continue;
      const md = mtimeDay(join(specsDir, t.path, 'TASK.md'))
        || mtimeDay(join(specsDir, t.path));
      if (md) {
        trackDays.set(t.path, md);
        tracksDegraded = true;
      }
    }
  }
  const trackDateList = [...trackDays.values()];
  const tracksTrend = groupAddedByDay(trackDateList, from, to, bucket);

  const trackPieSrc = countBy(packages.flatMap((p) => (p.tracks || []).map((t) => ({ pkg: p.name }))), (x) => ({
    key: x.pkg, label: x.pkg,
  }));

  const domainDates = [];
  let domainsTrendOk = true;
  for (const d of domains) {
    const tracks = d.tracks || [];
    for (const tn of tracks) {
      const pkg = packages.find((p) => p.name === d.package);
      const tr = pkg && (pkg.tracks || []).find((t) => t.name === tn);
      const day = tr ? trackDays.get(tr.path) : null;
      if (day) domainDates.push(day);
      else domainsTrendOk = false;
    }
  }
  if (!domains.length) domainsTrendOk = true;
  const domainsTrend = groupAddedByDay(domainDates, from, to, bucket);
  if (!domainsTrendOk && !domainDates.length) degraded.domainsTrend = true;

  const domainPieSrc = countBy(domains, (d) => ({ key: d.package || 'pkg', label: d.package || 'pkg' }));

  const bugDates = bugs.map((b) => b.date).filter(Boolean);
  const bugsTrend = groupAddedByDay(bugDates, from, to, bucket);
  const bugPieSrc = countBy(bugs, (b) => ({ key: b.status || '新', label: b.status || '新' }));

  const headMix = scanHeadMix(deps);
  const e2ePieSrc = countBy(headMix.e2eJson || [], (p) => {
    const key = e2eDomainKey(p);
    return { key, label: key };
  });
  const lessonPieSrc = countBy(headMix.lessons || [], (l) => ({
    key: l.status === 'promoted' ? 'promoted' : 'draft',
    label: l.status === 'promoted' ? 'promoted' : 'draft',
  }));
  const typeRows = commitTypesByDay(git.numstat, from, to, bucket);
  const typeTotals = typeRows.reduce((acc, r) => {
    acc.feat += r.feat; acc.fix += r.fix; acc.test += r.test; acc.docs += r.docs; acc.other += r.other;
    return acc;
  }, emptyPrefixCounts());
  const typePie = pieSlices([
    { key: 'feat', label: 'feat', count: typeTotals.feat },
    { key: 'fix', label: 'fix', count: typeTotals.fix },
    { key: 'test', label: 'test', count: typeTotals.test },
    { key: 'docs', label: 'docs', count: typeTotals.docs },
    { key: 'other', label: '其它', count: typeTotals.other },
  ].filter((x) => x.count > 0));
  const runsRaw = readLocalRuns(deps);
  const runs = filterRunBars(runsRaw, from, to, bucket);
  if (runsRaw.empty) runs.empty = true;

  const body = {
    from,
    to,
    bucket,
    git: {
      activity: bucket === 'day' ? activity : bucketActivity,
      cumulative: bucket === 'day' ? cumulative : bucketCumulative,
    },
    volume,
    daily,
    entities: {
      briefs: {
        byDay: briefsTrend,
        pie: pieSlices(countBy(briefs, (b) => briefPieKey(b.status))),
      },
      tracks: {
        byDay: tracksTrend,
        pie: pieSlices(trackPieSrc),
      },
      domains: {
        byDay: domainsTrend,
        pie: pieSlices(domainPieSrc),
        note: '归属=现行 index',
      },
      bugs: {
        byDay: bugsTrend,
        pie: pieSlices(bugPieSrc),
      },
    },
    code: {
      business: {
        byDay: churnByKind(git.numstat, from, to, bucket, 'business'),
        pie: pieSlices(headMix.businessPie || []),
      },
      json: {
        byDay: churnByKind(git.numstat, from, to, bucket, 'json'),
        pie: pieSlices(headMix.jsonPie || []),
      },
      tests: {
        byDay: churnByKind(git.numstat, from, to, bucket, 'tests'),
        pie: pieSlices(headMix.testsPie || []),
      },
      cases: {
        byDay: casesByDay(git.nameEvents, git.numstat, from, to, bucket),
        pie: pieSlices(e2ePieSrc),
        gutFuncs: headMix.gutFuncs || 0,
      },
      runs,
      game: {
        pie: pieSlices(headMix.gamePie || []),
      },
    },
    rhythm: {
      commitTypes: { byDay: typeRows, pie: typePie },
      lessons: {
        byDay: lessonsByDay(headMix.lessons, from, to, bucket),
        pie: pieSlices(lessonPieSrc),
      },
      specs: {
        byDay: churnByKind(git.numstat, from, to, bucket, 'specs'),
        pie: pieSlices(headMix.specsPie || []),
      },
      toolchain: {
        byDay: churnByKind(git.numstat, from, to, bucket, 'toolchain'),
        pie: pieSlices(headMix.toolchainPie || []),
      },
    },
  };
  if (clipped) body.clipped = true;
  if (tracksDegraded) body.degraded = { ...(body.degraded || {}), tracksTrend: true };
  if (Object.keys(degraded).length) {
    body.degraded = { ...(body.degraded || {}), ...degraded };
  }
  if (jsonHasSubjectArrays(body)) {
    throw new Error('pulse trends leaked subject array');
  }
  return { status: 200, body };
}

function queryFromUrl(u) {
  const q = {};
  for (const [k, v] of u.searchParams) q[k] = v;
  return q;
}

export function handlePulseRequest(u, res, deps) {
  const p = u.pathname;
  if (p === '/api/pulse') {
    let status = 200;
    let body;
    try {
      const out = buildPulseKpis(deps);
      status = out.status;
      body = out.body;
    } catch {
      status = 200;
      body = { ok: true, kpis: { openTasks: 0, briefsDraft: 0, briefsReady: 0, gate: 'missing' }, degraded: { git: true, gate: true } };
    }
    res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify(body));
    return true;
  }
  if (p === '/api/pulse/trends') {
    let status = 200;
    let body;
    try {
      const out = buildPulseTrends(queryFromUrl(u), deps);
      status = out.status;
      body = out.body;
    } catch {
      status = 200;
      body = {
        from: todayStr(),
        to: todayStr(),
        bucket: 'day',
        git: { activity: [], cumulative: [] },
        volume: { byDir: [], byExt: [], totals: { plus: 0, minus: 0 } },
        daily: [],
        entities: {
          briefs: { byDay: [], pie: [] },
          tracks: { byDay: [], pie: [] },
          domains: { byDay: [], pie: [], note: '归属=现行 index' },
          bugs: { byDay: [], pie: [] },
        },
        ...emptyCodeRhythm(),
        degraded: { git: true },
      };
    }
    res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify(body));
    return true;
  }
  return false;
}

export { parsePulseWindow, pieSlices, autoBucket } from './pulse-lib.js';
