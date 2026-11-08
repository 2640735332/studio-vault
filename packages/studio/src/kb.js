import fs from 'node:fs';
import path from 'node:path';
import { loadShared } from './deps.js';
import { sharedRepoState } from './mirror.js';

const S = await loadShared();

/**
 * node:sqlite 兼容层（Node >= 22.5 才有该内置模块）。
 * 用「动态 import + try/catch」而不是静态 import：旧 Node 上模块加载不抛栈，
 * kb 命令与 doctor 的 kb 检查降级为 degraded（code=node_sqlite_unavailable），其它命令不受影响。
 * 用顶层 await 而非在函数里 await，是因为 kbStatus 被 doctor.js 同步调用（不改其签名）。
 */
export const SQLITE_MIN_NODE = '22.5';
let DatabaseSync = null;
let sqliteUnavailable = null;
try {
  const mod = await import('node:sqlite');
  if (typeof mod.DatabaseSync === 'function') DatabaseSync = mod.DatabaseSync;
  else sqliteUnavailable = 'node:sqlite 未导出 DatabaseSync';
} catch (err) {
  sqliteUnavailable = String((err && (err.code ? err.code + ': ' : '') + err.message) || err);
}

export function sqliteAvailable() {
  return DatabaseSync !== null;
}

/** 模块不可用时的统一载荷（kbStatus / kb rebuild / kb search 复用；doctor 视为 degraded）。 */
function sqliteUnavailablePayload() {
  return {
    ok: false,
    code: 'node_sqlite_unavailable',
    level: S.LEVEL.degraded,
    reason: 'node_sqlite_unavailable',
    message: '共享文本 kb 索引依赖 node:sqlite（需要 Node >= ' + SQLITE_MIN_NODE + ' 且模块未被禁用），当前运行环境 ' + process.version + ' 不可用',
    hint: '升级 Node 到 >= ' + SQLITE_MIN_NODE + ' 后重试；其它命令不受影响',
    node: process.version,
    error: sqliteUnavailable,
  };
}

/**
 * 共享文本 kb 索引：共享仓扫描根 + briefs 白名单 + kb-shared.db + stale/TTL。
 * 显式未覆盖：BGE 向量与查询期 RRF 合并（需模型环境）；此处 embedding=false 明示。
 */
export const KB_SCHEMA_VERSION = 1;
export const KB_TTL_DAYS = 7;
const TEXT_EXT = ['.md', '.html', '.htm', '.txt', '.json', '.yml', '.yaml', '.svg'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIPPET_CHARS = 2000;

export function kbPath(paths) {
  return path.join(paths.studioHome, 'cache', paths.projectId, 'kb-shared.db');
}

function readMeta(db) {
  const out = {};
  try {
    for (const row of db.prepare('SELECT key, value FROM meta').all()) out[row.key] = row.value;
  } catch { /* empty/corrupt */ }
  return out;
}

export function kbStatus(paths) {
  const file = kbPath(paths);
  const state = sharedRepoState(paths);
  if (!fs.existsSync(file)) {
    return { file, exists: false, level: S.LEVEL.degraded, reason: 'kb_shared_missing', hint: 'studio kb rebuild', source_commit: state.head || null };
  }
  if (!DatabaseSync) {
    return { file, exists: true, source_commit: state.head || null, ...sqliteUnavailablePayload() };
  }
  let meta = {};
  let entries = null;
  let files = null;
  let dbError = null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    meta = readMeta(db);
    try { entries = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n; } catch { entries = null; }
    files = meta.files != null ? Number(meta.files) : null;
    db.close();
  } catch (err) {
    dbError = String((err && err.message) || err);
  }
  const builtAt = meta.built_at || null;
  const ageDays = builtAt ? (Date.now() - Date.parse(builtAt)) / 86400000 : null;
  const commitDrift = !!(meta.source_commit && state.head && meta.source_commit !== state.head);
  const ttlExpired = ageDays != null && ageDays > KB_TTL_DAYS;
  const stale = commitDrift || ttlExpired;
  const schemaOk = Number(meta.schema_version) === KB_SCHEMA_VERSION && entries !== null;
  let level = S.LEVEL.ok;
  let reason = null;
  if (dbError) { level = S.LEVEL.degraded; reason = 'kb_db_unreadable: ' + dbError; }
  else if (!schemaOk) { level = S.LEVEL.degraded; reason = 'kb_schema_unsupported (rebuild required)'; }
  else if (stale) { level = S.LEVEL.degraded; reason = commitDrift ? 'source_commit_drift' : 'ttl_expired'; }
  return {
    file,
    exists: true,
    level,
    reason,
    entries,
    files,
    source_commit: meta.source_commit || null,
    current_head: state.head || null,
    built_at: builtAt,
    age_days: ageDays == null ? null : Number(ageDays.toFixed(2)),
    ttl_days: KB_TTL_DAYS,
    stale,
    embedding: { enabled: false, note: 'BGE 向量/RRF 合并尚未启用，本索引仅供关键词检索与 stale 可见性' },
  };
}

function plainText(text, rel) {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return text
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return text.replace(/\s+/g, ' ').trim();
}

function titleOf(text, rel) {
  const md = /^#\s+(.+)$/m.exec(text);
  if (md) return md[1].trim().slice(0, 200);
  const html = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (html) return html[1].replace(/\s+/g, ' ').trim().slice(0, 200);
  return path.basename(rel);
}

export function kbRebuild(paths, opts = {}) {
  const { dryRun = false } = opts;
  // --dry-run 只扫描不建库，无需 sqlite；真正重建才要求模块可用。
  if (!DatabaseSync && !dryRun) return { ...sqliteUnavailablePayload(), file: kbPath(paths), dry_run: false };
  const state = sharedRepoState(paths);
  if (!state.ok) return { ok: false, code: 'shared_repo_not_ready', state };
  const roots = [
    { root: path.join(paths.sharedRoot, 'docs', 'briefs'), kind: 'brief' },
    { root: path.join(paths.sharedRoot, 'specs'), kind: 'spec' },
  ];
  const scanned = [];
  const skipped = { large: 0, pointer: 0, ext: 0, unreadable: 0 };
  for (const entry of roots) {
    for (const rel of S.walkFiles(entry.root)) {
      if (!TEXT_EXT.some((e) => rel.toLowerCase().endsWith(e))) { skipped.ext += 1; continue; }
      const abs = path.join(entry.root, rel);
      const st = S.statSafe(abs);
      if (st.size > MAX_FILE_BYTES) { skipped.large += 1; continue; }
      if (st.size <= S.LFS_POINTER_MAX_BYTES && S.isLfsPointerFile(abs)) { skipped.pointer += 1; continue; }
      let buf;
      try { buf = fs.readFileSync(abs); } catch { skipped.unreadable += 1; continue; }
      const text = buf.toString('utf8');
      const repoRel = entry.kind === 'brief' ? 'docs/briefs/' + rel : 'specs/' + rel;
      scanned.push({ path: repoRel, kind: entry.kind, hash: S.sha256Buf(buf), title: titleOf(text, rel), text: plainText(text, rel).slice(0, SNIPPET_CHARS), size: st.size });
    }
  }
  const report = {
    ok: true,
    code: dryRun ? 'dry_run' : 'rebuilt',
    file: kbPath(paths),
    source_commit: state.head,
    files: scanned.length,
    skipped,
    entries: scanned.length,
    dry_run: dryRun,
  };
  if (dryRun) return report;
  const file = kbPath(paths);
  S.ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  const db = new DatabaseSync(tmp);
  try {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
    db.exec('CREATE TABLE docs (path TEXT PRIMARY KEY, kind TEXT, hash TEXT, title TEXT, text TEXT, size INTEGER);');
    db.exec('CREATE INDEX docs_kind ON docs(kind);');
    db.exec('BEGIN');
    const ins = db.prepare('INSERT OR REPLACE INTO docs (path, kind, hash, title, text, size) VALUES (?,?,?,?,?,?)');
    for (const d of scanned) ins.run(d.path, d.kind, d.hash, d.title, d.text, d.size);
    db.exec('COMMIT');
    const meta = {
      schema_version: String(KB_SCHEMA_VERSION),
      project: paths.projectId,
      source_commit: state.head || '',
      source_branch: paths.sharedBranch,
      files: String(scanned.length),
      built_at: S.nowIso(),
      bge_model: '',
      bge_dim: '',
      skipped_large: String(skipped.large),
      skipped_pointer: String(skipped.pointer),
    };
    const mi = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)');
    for (const key of Object.keys(meta)) mi.run(key, meta[key]);
  } finally {
    db.close();
  }
  fs.renameSync(tmp, file);
  report.status = kbStatus(paths);
  return report;
}

export function kbSearch(paths, query, limit = 10) {
  const file = kbPath(paths);
  if (!fs.existsSync(file)) return { ok: false, code: 'kb_shared_missing' };
  if (!DatabaseSync) return sqliteUnavailablePayload();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const like = '%' + String(query || '').replace(/[%_]/g, '') + '%';
    const rows = db.prepare('SELECT path, kind, title, substr(text,1,240) AS snippet FROM docs WHERE title LIKE ? OR text LIKE ? LIMIT ?').all(like, like, limit);
    return { ok: true, query, count: rows.length, rows };
  } finally {
    db.close();
  }
}
