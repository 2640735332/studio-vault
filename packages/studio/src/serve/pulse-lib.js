/**
 * Pure Pulse helpers for Spec Viewer. Zero I/O, zero git.
 * node --test imports this module directly.
 */

import { briefSegment } from './inbox.js';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const WINDOWS = new Set(['7d', '30d', '90d', 'ytd', 'all']);
const OPEN_TASK = new Set(['todo', 'in progress', 'backlog']);

export function parseDay(s) {
  const m = ISO.exec(String(s || '').trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function fmtDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr(now) {
  const d = now instanceof Date ? now : new Date();
  return fmtDay(d);
}

export function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  return x;
}

/** Inclusive calendar-day count. */
export function inclusiveDays(from, to) {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

function expandWindow(window, today, repoEarliest) {
  const w = String(window || '');
  if (!WINDOWS.has(w)) return { error: 'invalid_range' };
  const t = parseDay(today);
  if (w === '7d') return { from: fmtDay(addDays(t, -6)), to: today };
  if (w === '30d') return { from: fmtDay(addDays(t, -29)), to: today };
  if (w === '90d') return { from: fmtDay(addDays(t, -89)), to: today };
  if (w === 'ytd') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  const start = ISO.test(repoEarliest) ? repoEarliest : fmtDay(addDays(t, -729));
  return { from: start, to: today };
}

/**
 * @param {{ from?: string, to?: string, window?: string, today?: string, repoEarliest?: string, maxDays?: number }} opts
 * @returns {{ from: string|null, to: string|null, swapped: boolean, clipped: boolean, error: string|null }}
 */
export function parsePulseWindow(opts = {}) {
  const maxDays = opts.maxDays == null ? 730 : Number(opts.maxDays);
  const today = ISO.test(opts.today) ? opts.today : todayStr();
  const repoEarliest = ISO.test(opts.repoEarliest) ? opts.repoEarliest : null;
  let swapped = false;
  let clipped = false;
  let from = opts.from;
  let to = opts.to;
  const window = opts.window ? String(opts.window) : '';

  if (maxDays < 1 || !Number.isFinite(maxDays)) {
    return { from: null, to: null, swapped: false, clipped: false, error: 'too_long' };
  }

  if (window) {
    const exp = expandWindow(window, today, repoEarliest);
    if (exp.error) return { from: null, to: null, swapped: false, clipped: false, error: exp.error };
    from = exp.from;
    to = exp.to;
  } else if (from != null || to != null) {
    if (!ISO.test(from || '') || !ISO.test(to || '')) {
      return { from: null, to: null, swapped: false, clipped: false, error: 'invalid_range' };
    }
  } else {
    const exp = expandWindow('30d', today, repoEarliest);
    from = exp.from;
    to = exp.to;
  }

  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
    swapped = true;
  }
  if (to > today) {
    to = today;
    clipped = true;
  }
  if (from > to) from = to;
  if (repoEarliest && from < repoEarliest) {
    from = repoEarliest;
    clipped = true;
    if (from > to) from = to;
  }
  const span = inclusiveDays(from, to);
  if (span > maxDays) {
    from = fmtDay(addDays(parseDay(to), -(maxDays - 1)));
    clipped = true;
    if (repoEarliest && from < repoEarliest) from = repoEarliest;
  }
  if (from > to) {
    return { from, to, swapped, clipped, error: 'invalid_range' };
  }
  return { from, to, swapped, clipped, error: null };
}

/** day if span≤45; week if span≤180; else month. span = inclusive days. */
export function autoBucket(from, to) {
  const span = inclusiveDays(from, to);
  if (span <= 45) return 'day';
  if (span <= 180) return 'week';
  return 'month';
}

export function resolveBucket(from, to, bucket) {
  const b = String(bucket || 'auto');
  if (b === 'day' || b === 'week' || b === 'month') return b;
  return autoBucket(from, to);
}

export function bucketKey(dayStr, bucket) {
  const d = parseDay(dayStr);
  if (!d) return dayStr;
  if (bucket === 'month') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }
  if (bucket === 'week') {
    const wd = (d.getDay() + 6) % 7;
    return fmtDay(addDays(d, -wd));
  }
  return dayStr;
}

export function eachBucket(from, to, bucket) {
  const start = parseDay(from);
  const end = parseDay(to);
  if (!start || !end) return [];
  const out = [];
  if (bucket === 'month') {
    let y = start.getFullYear();
    let m = start.getMonth();
    const endY = end.getFullYear();
    const endM = end.getMonth();
    while (y < endY || (y === endY && m <= endM)) {
      out.push(`${y}-${String(m + 1).padStart(2, '0')}-01`);
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }
    return out;
  }
  if (bucket === 'week') {
    let cur = parseDay(bucketKey(from, 'week'));
    const last = parseDay(bucketKey(to, 'week'));
    while (cur <= last) {
      out.push(fmtDay(cur));
      cur = addDays(cur, 7);
    }
    return out;
  }
  let cur = start;
  while (cur <= end) {
    out.push(fmtDay(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * Top `max` slices + optional 其它. count sum equals input total.
 * @param {{ key: string, label?: string, count: number }[]} items
 */
export function pieSlices(items, { max = 6 } = {}) {
  const list = (items || []).map((it) => ({
    key: String(it.key),
    label: it.label != null ? String(it.label) : String(it.key),
    count: Number(it.count) || 0,
  }));
  const total = list.reduce((s, x) => s + x.count, 0);
  const pctOf = (n) => pieSharePct(n, total);
  const sorted = [...list].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const head = sorted.slice(0, max);
  const rest = sorted.slice(max);
  const restSum = rest.reduce((s, x) => s + x.count, 0);
  const out = head.map((x) => ({ key: x.key, label: x.label, count: x.count, pct: pctOf(x.count) }));
  if (restSum > 0) {
    out.push({ key: '_other', label: '其它', count: restSum, pct: pctOf(restSum) });
  }
  return out;
}

export function countBy(items, keyFn, labelFn) {
  const map = new Map();
  for (const it of items || []) {
    const rec = keyFn(it);
    if (!rec || rec.key == null) continue;
    const key = String(rec.key);
    const label = rec.label != null ? String(rec.label) : (labelFn ? labelFn(it) : key);
    const prev = map.get(key) || { key, label, count: 0 };
    prev.count += 1;
    map.set(key, prev);
  }
  return [...map.values()];
}

export function isBriefReady(status) {
  return briefSegment(status) === 'ready';
}

export function briefPieKey(status) {
  const g = briefSegment(status);
  if (g === 'ready') return { key: 'ready', label: '可交 spec-engine' };
  if (g === 'draft') return { key: 'draft', label: '草稿' };
  if (g === 'doing') return { key: 'doing', label: '实现中' };
  if (g === 'done') return { key: 'done', label: '已实现' };
  if (g === 'rejected') return { key: 'rejected', label: '已否决' };
  return { key: 'other', label: String(status || '其它') };
}

/** Count TASK.md table rows whose 状态 is TODO / In Progress / Backlog. */
export function countOpenTaskRows(markdown) {
  let statusIdx = 3;
  let n = 0;
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    if (!raw.startsWith('|')) continue;
    const parts = raw.split('|').map((c) => c.trim());
    if (/^编号$/.test(parts[1] || '') && parts.some((c) => c === '状态')) {
      statusIdx = parts.findIndex((c) => c === '状态');
      continue;
    }
    if (!/^TASK-\d+/i.test(parts[1] || '')) continue;
    const st = String(parts[statusIdx] || '').toLowerCase();
    if (OPEN_TASK.has(st)) n += 1;
  }
  return n;
}

export function inWindow(day, from, to) {
  return !!(day && day >= from && day <= to && ISO.test(day));
}

export function runningSum(points, fields) {
  const acc = {};
  for (const f of fields) acc[f] = 0;
  return points.map((p) => {
    const row = { ...p };
    for (const f of fields) {
      acc[f] += Number(p[f]) || 0;
      row[f] = acc[f];
    }
    return row;
  });
}

/** True when trends JSON has the implementation/rhythm walls (not just git overview). */
export function trendsHasCodeRhythm(t) {
  return !!(t && t.code && t.rhythm && t.code.business && t.rhythm.commitTypes);
}

export function jsonHasSubjectArrays(obj, path = '') {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    const leaf = path.split('.').pop();
    if (leaf === 'commits' || leaf === 'subjects' || leaf === 'messages') return path;
    for (let i = 0; i < obj.length; i++) {
      const hit = jsonHasSubjectArrays(obj[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj)) {
    const next = path ? `${path}.${k}` : k;
    if ((k === 'commits' || k === 'subjects' || k === 'messages') && Array.isArray(v)) return next;
    const hit = jsonHasSubjectArrays(v, next);
    if (hit) return hit;
  }
  return null;
}

export function groupAddedByDay(dates, from, to, bucket) {
  const keys = eachBucket(from, to, bucket);
  const map = new Map(keys.map((k) => [k, 0]));
  for (const day of dates || []) {
    if (!inWindow(day, from, to)) continue;
    const k = bucketKey(day, bucket);
    if (map.has(k)) map.set(k, map.get(k) + 1);
  }
  let cum = 0;
  return keys.map((day) => {
    const added = map.get(day) || 0;
    cum += added;
    return { day, added, cumulative: cum };
  });
}

export function parseNumstatText(text) {
  const byDay = new Map();
  let curDay = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    // Real `git log --numstat --format=%H%x09%cs` emits a blank line after the
    // commit header (and between commits). Blank must NOT clear curDay — only
    // the next hash\tdate header switches the current commit day.
    if (!line) continue;
    const head = line.match(/^([0-9a-f]{7,40})\t(\d{4}-\d{2}-\d{2})(?:\t(.*))?$/i);
    if (head) {
      curDay = head[2];
      const rec = byDay.get(curDay) || {
        day: curDay,
        commits: 0,
        plus: 0,
        minus: 0,
        textFiles: new Set(),
        binaries: new Set(),
        files: [],
        prefixes: { feat: 0, fix: 0, test: 0, docs: 0, other: 0 },
      };
      rec.commits += 1;
      if (!rec.prefixes) rec.prefixes = { feat: 0, fix: 0, test: 0, docs: 0, other: 0 };
      const pref = parseCommitPrefix(head[3]);
      if (pref) rec.prefixes[pref] += 1;
      byDay.set(curDay, rec);
      continue;
    }
    const ns = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!ns || !curDay) continue;
    const rec = byDay.get(curDay);
    if (!rec) continue;
    const file = ns[3].replace(/^\{.*=>\s*/, '').replace(/\s*\}$/, '');
    const binary = ns[1] === '-' || ns[2] === '-';
    if (binary) {
      rec.binaries.add(file);
      rec.files.push({ path: file, binary: true });
    } else {
      rec.plus += Number(ns[1]);
      rec.minus += Number(ns[2]);
      rec.textFiles.add(file);
      rec.files.push({ path: file, binary: false, plus: Number(ns[1]), minus: Number(ns[2]) });
    }
  }
  return byDay;
}

/** Volume / byDir key. Splits game/src (business) from game/tests. */
export function volumeDirKey(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  if (!p) return '(root)';
  if (p === 'game/src' || p.startsWith('game/src/')) return 'game/src';
  if (p === 'game/tests' || p.startsWith('game/tests/')) return 'game/tests';
  if (p === 'game' || p.startsWith('game/')) {
    const seg = p.split('/')[1];
    return seg ? `game/${seg}` : 'game/other';
  }
  const i = p.indexOf('/');
  return i <= 0 ? p : p.slice(0, i);
}

export function dirKey(filePath) {
  return volumeDirKey(filePath);
}

export function extKey(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  const base = p.split('/').pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0) return '(none)';
  return base.slice(i).toLowerCase();
}

export function volumeFromFiles(files, { detailFiles = false } = {}) {
  const byDir = new Map();
  const byExt = new Map();
  const byFile = [];
  let plus = 0;
  let minus = 0;
  for (const f of files || []) {
    const n = f.binary ? 1 : (Number(f.plus) || 0) + (Number(f.minus) || 0);
    const d = dirKey(f.path);
    const e = extKey(f.path);
    byDir.set(d, (byDir.get(d) || 0) + n);
    byExt.set(e, (byExt.get(e) || 0) + n);
    if (!f.binary) {
      plus += Number(f.plus) || 0;
      minus += Number(f.minus) || 0;
    }
    if (detailFiles) {
      const row = { key: f.path, n };
      if (f.binary) row.binary = true;
      byFile.push(row);
    }
  }
  const asList = (map) => [...map.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => a.n - b.n || a.key.localeCompare(b.key));
  const out = {
    byDir: asList(byDir),
    byExt: asList(byExt),
    totals: { plus, minus },
  };
  if (detailFiles) out.byFile = byFile;
  return out;
}

const COMMIT_PREFIX = /^(feat|fix|docs|test|refactor|chore|style|perf|revert|build|ci)\b/;
const NAMED_PREFIX = new Set(['feat', 'fix', 'test', 'docs']);

/** Conventional first token → feat|fix|test|docs|other. Empty subject → null (do not count). */
export function parseCommitPrefix(subject) {
  const s = String(subject || '').trim();
  if (!s) return null;
  const m = COMMIT_PREFIX.exec(s);
  if (!m) return 'other';
  const w = m[1];
  return NAMED_PREFIX.has(w) ? w : 'other';
}

/**
 * Path → wall bucket. null = not a wall (briefs/bugs/assets/skills/…).
 * @returns {'business'|'json'|'tests'|'cases'|'specs'|'lessons'|'toolchain'|null}
 */
export function classifyNumstatPath(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  if (!p) return null;
  if (p.startsWith('game/src/data/') || p === 'game/src/data'
    || p.startsWith('game/src/schemas/') || p === 'game/src/schemas') {
    return 'json';
  }
  if (p.startsWith('game/src/')) return 'business';
  if (p.startsWith('game/tests/')) return 'tests';
  if (p.startsWith('specs/') && /\/e2e\/[^/]+\.json$/i.test(p)) return 'cases';
  if (p.startsWith('specs/')) return 'specs';
  if (p.startsWith('docs/lessons/') && /\.md$/i.test(p)) {
    const base = p.split('/').pop();
    if (base === 'INDEX.md' || base === 'proposals.md' || base === 'README.md') return null;
    return 'lessons';
  }
  if (p.startsWith('scripts/') || p.startsWith('tools/test/')) return 'toolchain';
  return null;
}

export function shouldDrawBarLabel(bucketCount, barWidthPx, value) {
  if (!(Number(value) > 0)) return false;
  if (Number(bucketCount) > 31) return false;
  if (Number(barWidthPx) < 12) return false;
  return true;
}

/** Chart readout labels (viewer.js duplicates the CSS-var color arrays). */
export const STACK_KEYS = ['feat', 'fix', 'test', 'docs', 'other'];
export const STACK_COLORS = ['var(--accent)', 'var(--red)', 'var(--green)', 'var(--amber)', 'var(--fg2)'];
export const RUN_KEYS = ['passed', 'failed'];
export const RUN_COLORS = ['var(--green)', 'var(--red)'];
export const CASE_KEYS = ['gutAdded', 'e2eAdded'];
export const CASE_COLORS = ['var(--green)', 'var(--accent)'];

export const PULSE_SLICE_UNIT = {
  briefs: '份',
  tracks: '条',
  domains: '个',
  bugs: '个',
  business: '文件',
  json: '文件',
  tests: '文件',
  game: '文件',
  cases: '个 E2E JSON',
  lessons: '篇',
  specs: '文件',
  toolchain: '文件',
};

/** #/pulse section order. daily may follow. */
export const PULSE_SEC_ORDER = ['overview', 'ents', 'code', 'runs', 'rhythm'];

export const RUN_MEANING = {
  title: '本机 vlm_agent E2E（checkpoint 步）',
  passed: '通过步',
  failed: '失败步',
  caption: '绿=该日 vlm_agent report.json 的 checkpoint 通过步；红=失败步。旁路「最近 E2E / 最近门禁」是最近一次摘要，不是柱高。',
};

export const PULSE_LEGEND_LABEL = {
  other: '其它',
  passed: '通过步',
  failed: '失败步',
  gutAdded: 'GUT 文件+',
  e2eAdded: 'E2E JSON+',
  plus: '新增行',
  minus: '删除行',
  commits: '提交',
  briefs: '简报',
};

export function pulseSliceUnit(kind) {
  return PULSE_SLICE_UNIT[kind] || '个';
}

export function sumRows(rows, keys) {
  const out = {};
  for (const k of keys || []) out[k] = 0;
  for (const r of rows || []) {
    for (const k of keys || []) out[k] += Number(r[k]) || 0;
  }
  return out;
}

export function formatPulseTotal(n, unit) {
  return '窗内合计 ' + (Number(n) || 0) + ' ' + unit;
}

/** Slice share 0–100 with one decimal. Never returns count-as-percent. */
export function pieSharePct(count, total) {
  const n = Number(count) || 0;
  const t = Number(total) || 0;
  if (!(t > 0) || n <= 0) return 0;
  return Math.round((n / t) * 1000) / 10;
}

/**
 * Tip rows: [label, value] or [key, label, value].
 * length≥3 always wins so slice/seg/dot `[null, 标签, 值]` keep the number.
 */
export function normalizePulseTipRow(row) {
  const r = Array.isArray(row) ? row : [];
  if (r.length >= 3) {
    const label = r[1];
    return {
      key: r[0] == null || r[0] === '' ? null : r[0],
      label: label == null ? '' : label,
      value: r[2],
    };
  }
  const label = r[0];
  return {
    key: null,
    label: label == null ? '' : label,
    value: r[1],
  };
}

export function extractSubmittedBugId(bugReport) {
  if (bugReport == null || bugReport === false) return null;
  if (typeof bugReport === 'number' && /^\d{8}$/.test(String(Math.trunc(bugReport)))) {
    return String(Math.trunc(bugReport));
  }
  if (typeof bugReport === 'string') {
    const m = bugReport.match(/\b(\d{8})\b/);
    return m ? m[1] : null;
  }
  if (typeof bugReport !== 'object') return null;
  if (bugReport.ok === false) return null;
  const prefer = [
    bugReport.id,
    bugReport.bug_id,
    bugReport.folder,
    bugReport.data && (bugReport.data.id || bugReport.data.bug_id || bugReport.data.folder),
    bugReport.result && (bugReport.result.id || bugReport.result.bug_id),
  ];
  for (const c of prefer) {
    const s = String(c == null ? '' : c);
    if (/^\d{8}$/.test(s)) return s;
    const m = s.match(/\b(\d{8})\b/);
    if (m) return m[1];
  }
  try {
    const blob = JSON.stringify(bugReport);
    const m = blob.match(/\b(\d{8})\b/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function classifyPulseBugKind(status) {
  const s = String(status || '').trim();
  if (s === '已关闭 · 非缺陷') return 'false_red';
  // 重复包（已并入主号）不是独立存活缺陷：与假红同桶，不计入 valid
  if (s === '已关闭 · 重复') return 'false_red';
  return 'valid';
}

export function pulseBarTipRows(opts) {
  const rows = [];
  const metric = opts && opts.metric ? String(opts.metric) : '';
  const value = opts && opts.value;
  const plus = opts && opts.plus;
  const minus = opts && opts.minus;
  const plusLabel = opts && opts.plusLabel ? String(opts.plusLabel) : '';
  const minusLabel = opts && opts.minusLabel ? String(opts.minusLabel) : '';
  if (plusLabel || minusLabel) {
    if (metric && metric !== plusLabel && value != null && value !== '') {
      rows.push([metric, value]);
    }
    if (plusLabel && plus != null && plus !== '') rows.push([plusLabel, plus]);
    if (minusLabel && minus != null && minus !== '') rows.push([minusLabel, minus]);
    return rows;
  }
  if (metric) rows.push([metric, value]);
  return rows;
}

export function stackLegendItems(keys, colors) {
  return (keys || []).map((k, i) => ({
    key: k,
    color: (colors || [])[i % Math.max(1, (colors || []).length)],
    label: PULSE_LEGEND_LABEL[k] || k,
  }));
}

export function parseLessonStatus(markdown) {
  const m = String(markdown || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return 'draft';
  const st = m[1].match(/^status:\s*(\S+)/m);
  const v = st ? String(st[1]).trim().toLowerCase() : '';
  return v === 'promoted' ? 'promoted' : 'draft';
}

export function lessonDayFromName(fileName) {
  const m = String(fileName || '').match(/^(\d{4}-\d{2}-\d{2})-/);
  return m ? m[1] : null;
}

export function parseNameStatusText(text) {
  const events = [];
  let curDay = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue;
    const head = line.match(/^([0-9a-f]{7,40})\t(\d{4}-\d{2}-\d{2})/i);
    if (head) {
      curDay = head[2];
      continue;
    }
    const ns = line.match(/^([AMD])\t(.+)$/);
    if (!ns || !curDay) continue;
    events.push({
      day: curDay,
      status: ns[1],
      path: ns[2].replace(/\\/g, '/').replace(/^\{.*=>\s*/, '').replace(/\s*\}$/, ''),
    });
  }
  return events;
}

export function businessSubdir(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  const parts = p.split('/');
  if (parts[0] !== 'game' || parts[1] !== 'src' || parts.length < 3) return 'other';
  const seg = parts[2];
  if (seg === 'data' || seg === 'schemas') return null;
  return seg || 'other';
}

export function specsPackageKey(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  const parts = p.split('/');
  if (parts[0] !== 'specs' || parts.length < 2) return 'specs';
  return parts[1] || 'specs';
}

export function e2eDomainKey(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  const m = p.match(/^specs\/[^/]+\/domains\/([^/]+)\/e2e\//);
  if (m) return m[1];
  const m2 = p.match(/\/e2e\/[^/]+\.json$/i);
  return m2 ? 'e2e' : 'e2e';
}

export function emptyPrefixCounts() {
  return { feat: 0, fix: 0, test: 0, docs: 0, other: 0 };
}
