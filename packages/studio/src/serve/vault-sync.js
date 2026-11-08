#!/usr/bin/env node
/**
 * Studio data sync: Vault API -> local game/reports/bugs snapshot (read by spec-server).
 * Vault: http://127.0.0.1:3460 ; token file: env VAULT_TOKEN_FILE or ~/.studio/secrets/vault-token.txt
 * Objects: env VAULT_OBJECTS_DIR only (optional, no default) for attachment copy;
 *          without it the Readme still lists evidence metadata (Vault stays the source of truth).
 * Idempotent: rewrites Readme.md per bug; keeps previous snapshot if Vault is unreachable;
 *             attachments are cached per bug in .vault-files.json (path -> sha256/size/reportId).
 * Readme fields (kept stable for spec-viewer parsers): ID / 标题 / 描述 / 复现时间 / 状态 / 项目 / 来源 /
 *   证据 / 截图 / 日志 / 文件 / 历史变更 (timeline).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(process.env.STUDIO_ROOT || process.cwd());
const VAULT = process.env.VAULT_URL || 'http://127.0.0.1:3460';
const BUGS = path.join(ROOT, 'game', 'reports', 'bugs');
const TOKEN_FILE = process.env.VAULT_TOKEN_FILE || path.join(os.homedir(), '.studio', 'secrets', 'vault-token.txt');
const STATUS_FILE = path.join(ROOT, 'game', 'reports', 'vault-sync.json');
const MAX_ATTACHMENT_MB = Number(process.env.VAULT_SYNC_MAX_ATTACHMENT_MB || 4096);
const MAX_ATTACHMENT_BYTES = Math.max(0, MAX_ATTACHMENT_MB) * 1024 * 1024;
const MAX_HISTORY_LINES = 30;
const MAX_FILE_LINES = 60;
const log = (...args) => console.log(new Date().toISOString(), ...args);

function detectObjectsDir() {
  const explicit = String(process.env.VAULT_OBJECTS_DIR || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  return '';
}
const OBJECTS_DIR = detectObjectsDir();

function token() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}
async function getJson(url) {
  const headers = {};
  const t = token();
  if (t) headers.authorization = 'Bearer ' + t;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, body: null, error: String((error && error.message) || error) };
  }
}

// Vault English status -> Readme Chinese CANONICAL (viewer filters by Chinese).
// CANONICAL list follows scripts/spec-bug-status.js:9; unknown codes fall back to 新 with a note (never silent).
const CANONICAL_STATUS = ['新', '修复中', '已关闭', '已关闭 · 非缺陷', '已关闭 · 重复', '已关闭 · 设计面'];
const STATUS_ZH = {
  new: '新', open: '新', reopen: '新', triaged: '新', interrupted: '新', pending: '新', todo: '新',
  in_progress: '修复中', fixing: '修复中', fixing_in_progress: '修复中', start_fix: '修复中', verifying: '修复中',
  fixed: '已关闭', closed: '已关闭', done: '已关闭', resolved: '已关闭',
  false_red: '已关闭 · 非缺陷', false_positive: '已关闭 · 非缺陷', false_negative: '已关闭',
  duplicate: '已关闭 · 重复',
  design_followup: '已关闭 · 设计面', design: '已关闭 · 设计面',
  cannot_reproduce: '已关闭',
};
function mapStatus(raw) {
  const s = String(raw || '').trim();
  if (!s) return { zh: '新', raw: s, note: '空状态 → 新（回退）', unknown: true };
  if (CANONICAL_STATUS.includes(s)) return { zh: s, raw: s, note: null, unknown: false };
  const key = s.toLowerCase().replace(/[\s-]+/g, '_');
  if (STATUS_ZH[key]) return { zh: STATUS_ZH[key], raw: s, note: 'vault 状态码 ' + s + ' → ' + STATUS_ZH[key], unknown: false };
  return { zh: '新', raw: s, note: '未知 vault 状态码 ' + s + ' → 新（回退）', unknown: true };
}
function noteStatus(status, mapped) {
  if (!status || typeof status !== 'object') return;
  if (!status.statusMap) status.statusMap = {};
  if (!status.statusFallback) status.statusFallback = {};
  const k = mapped.raw || '(empty)';
  status.statusMap[k] = (status.statusMap[k] || 0) + 1;
  if (mapped.note) {
    if (mapped.unknown) status.statusFallback[k] = (status.statusFallback[k] || 0) + 1;
    if (!Array.isArray(status.notes)) status.notes = [];
    if (!status.notes.includes(mapped.note) && status.notes.length < 50) status.notes.push(mapped.note);
  }
}

// ── enrichment helpers (description / evidence / logs / timeline) ──
const cache = { links: new Map(), reports: new Map(), objectText: new Map() };

async function linksForBug(uuid) {
  if (cache.links.has(uuid)) return cache.links.get(uuid);
  const r = await getJson(VAULT + '/api/v1/links?bug_id=' + encodeURIComponent(uuid));
  const items = r.status === 200 && r.body && Array.isArray(r.body.items) ? r.body.items : [];
  cache.links.set(uuid, items);
  return items;
}
async function reportDetail(reportId) {
  if (cache.reports.has(reportId)) return cache.reports.get(reportId);
  const r = await getJson(VAULT + '/api/v1/reports/' + encodeURIComponent(reportId));
  const value = r.status === 200 && r.body && r.body.report
    ? { report: r.body.report, files: Array.isArray(r.body.files) ? r.body.files : [] }
    : null;
  cache.reports.set(reportId, value);
  return value;
}
async function collectEvidence(uuid) {
  const links = await linksForBug(uuid);
  const entries = [];
  for (const link of links) {
    const rid = String((link && link.reportId) || '').trim();
    if (!rid) continue;
    const detail = await reportDetail(rid);
    if (!detail) continue;
    entries.push({ link, report: detail.report, files: detail.files });
  }
  entries.sort((a, b) => String((a.link && a.link.createdAt) || '').localeCompare(String((b.link && b.link.createdAt) || '')));
  return entries;
}

function humanSize(n) {
  const bytes = Number(n || 0);
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}
function safeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_') || 'file';
}
function safeRel(rel) {
  return String(rel || '').split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..').map(safeName).join('/') || 'file';
}
function objectPath(sha) {
  return path.join(OBJECTS_DIR, sha.slice(0, 2), sha.slice(2, 4), sha);
}
function copyObject(sha, dest, expectedSize) {
  if (!OBJECTS_DIR || !sha) return false;
  try {
    const src = objectPath(sha);
    if (!fs.existsSync(src)) return false;
    const st = fs.statSync(src);
    if (Number(expectedSize) > 0 && st.size !== Number(expectedSize)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}
function readObjectText(sha) {
  if (!OBJECTS_DIR || !sha) return '';
  if (cache.objectText.has(sha)) return cache.objectText.get(sha);
  let text = '';
  try { text = fs.readFileSync(objectPath(sha), 'utf8'); } catch { text = ''; }
  if (text.length > 20000) text = text.slice(0, 20000);
  cache.objectText.set(sha, text);
  return text;
}
function readmeFieldOf(text, key) {
  const m = String(text || '').match(new RegExp('^' + key + '[:：]\\s*(.*)$', 'm'));
  return m ? m[1].trim() : '';
}
function manifestPath(dir) { return path.join(dir, '.vault-files.json'); }
function loadManifest(dir) {
  try {
    const obj = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}
function saveManifest(dir, manifest) {
  try { fs.writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2) + '\n'); } catch { /* best effort */ }
}

async function syncAttachments(dir, entries, manifest, metrics) {
  const counts = { screenshot: 0, log: 0, readme: 0, attachment: 0 };
  const listed = [];
  let copiedBytes = 0;
  entries.forEach((entry, entryIndex) => {
    const reportId = String((entry.report && entry.report.id) || '');
    const short = reportId.slice(0, 8) || 'report';
    const primary = entryIndex === 0;
    for (const file of (entry.files || [])) {
      const role = String(file.role || 'attachment');
      if (role === 'screenshot') counts.screenshot += 1;
      else if (role === 'log') counts.log += 1;
      else if (role === 'readme') counts.readme += 1;
      else counts.attachment += 1;
      const sha = String(file.sha256 || '');
      const size = Number(file.sizeBytes || 0);
      const original = safeRel(file.path);
      let destRel = '';
      if (primary && (role === 'screenshot' || role === 'log')) destRel = original.split('/').pop();
      else destRel = 'files/' + short + '/' + original;
      const prev = manifest[destRel];
      const destAbs = path.join(dir, destRel);
      const unchanged = !!(prev && prev.sha256 === sha && Number(prev.sizeBytes) === size && fs.existsSync(destAbs));
      if (unchanged) {
        metrics.attachmentsSkipped += 1;
        listed.push({ rel: destRel, role, size, sha, copied: false });
        continue;
      }
      if (!OBJECTS_DIR) {
        metrics.attachmentMissingObjects += 1;
        listed.push({ rel: destRel, role, size, sha, copied: false, missing: true });
        continue;
      }
      if (copiedBytes + size > MAX_ATTACHMENT_BYTES) {
        metrics.attachmentLimitHit += 1;
        listed.push({ rel: destRel, role, size, sha, copied: false, limit: true });
        continue;
      }
      const ok = copyObject(sha, destAbs, size);
      if (!ok) {
        metrics.attachmentMissingObjects += 1;
        listed.push({ rel: destRel, role, size, sha, copied: false, missing: true });
        continue;
      }
      manifest[destRel] = { sha256: sha, sizeBytes: size, role, reportId };
      copiedBytes += size;
      metrics.attachmentsCopied += 1;
      listed.push({ rel: destRel, role, size, sha, copied: true });
    }
  });
  metrics.attachmentsBytes += copiedBytes;
  return { counts, listed };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}
async function descriptionFor(b, entries) {
  const payload = (b.payload && typeof b.payload === 'object') ? b.payload : {};
  const fields = (payload.readmeFields && typeof payload.readmeFields === 'object') ? payload.readmeFields : {};
  let description = firstNonEmpty(payload.description, fields['描述'], fields.description);
  if (!description && entries.length > 0) {
    const readmeFile = (entries[0].files || []).find((f) => String(f.role || '') === 'readme' || /readme\.md$/i.test(String(f.path || '')));
    if (readmeFile && readmeFile.sha256) {
      const text = readObjectText(String(readmeFile.sha256));
      description = firstNonEmpty(readmeFieldOf(text, '描述'), readmeFieldOf(text, 'detail'));
    }
  }
  if (!description) description = firstNonEmpty(b.title, '(未提供)');
  return description.replace(/\r?\n/g, ' ').slice(0, 800);
}
function timelineLines(b, entries) {
  const payload = (b.payload && typeof b.payload === 'object') ? b.payload : {};
  const history = Array.isArray(payload.history) ? payload.history : [];
  const lines = [];
  for (const item of history.slice(-MAX_HISTORY_LINES)) {
    const text = String(item === undefined || item === null ? '' : item).trim();
    if (text) lines.push('- ' + text.replace(/^[-*]\s*/, ''));
  }
  if (lines.length === 0) {
    if (b.createdAt) lines.push('- [' + b.createdAt + '] Vault 入库（bug 创建，来源 created_at）');
    for (const entry of entries) {
      const at = entry.report && entry.report.createdAt;
      if (at) lines.push('- [' + at + '] 证据报告入库（report ' + String(entry.report.id || '').slice(0, 8) + '）');
    }
    if (b.updatedAt && b.updatedAt !== b.createdAt) lines.push('- [' + b.updatedAt + '] 最近更新（来源 updated_at）');
  }
  return lines.slice(-MAX_HISTORY_LINES);
}

function summarizeNames(list, max) {
  const names = list.slice(0, max);
  return names.join(', ') + (list.length > max ? ' … 共 ' + list.length + ' 个' : '');
}

async function writeBug(b, status) {
  const uuid = String(b.id || '').trim();
  const legacy = String(b.legacyId || '').trim();
  const key = (legacy || uuid).replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 8);
  if (!key) return false;
  const raw = String(b.createdAt || b.created_at || '').replace(/[^0-9]/g, '').slice(0, 14);
  const folder = 'bug-' + raw.padEnd(14, '0') + '-' + key;
  const dir = path.join(BUGS, folder);
  fs.mkdirSync(dir, { recursive: true });
  let entries = [];
  try { entries = await collectEvidence(uuid); } catch (error) { status.notes.push('evidence ' + key + ' error ' + String((error && error.message) || error)); }
  const manifest = loadManifest(dir);
  let evidence = { counts: { screenshot: 0, log: 0, readme: 0, attachment: 0 }, listed: [] };
  try { evidence = await syncAttachments(dir, entries, manifest, status.metrics); } catch (error) { status.notes.push('attachments ' + key + ' error ' + String((error && error.message) || error)); }
  saveManifest(dir, manifest);
  const payload = (b.payload && typeof b.payload === 'object') ? b.payload : {};
  const fields = (payload.readmeFields && typeof payload.readmeFields === 'object') ? payload.readmeFields : {};
  const description = await descriptionFor(b, entries);
  const reproducedAt = String(firstNonEmpty(payload.reproducedAt, fields['复现时间'], fields.reproducedAt, b.createdAt));
  const mapped = mapStatus(b.status);
  noteStatus(status, mapped);
  status.metrics.bugsProcessed += 1;
  if (description && description !== '(未提供)') status.metrics.descriptionFilled += 1;
  if (entries.length > 0) status.metrics.evidenceBugs += 1;
  const timeline = timelineLines(b, entries);
  if (timeline.length > 0) status.metrics.timelineBugs += 1;
  const lines = [
    '# ' + (b.title || 'untitled'),
    '',
    'ID: ' + (legacy || uuid),
    '标题: ' + (b.title || '未命名'),
    '描述: ' + description,
    '复现时间: ' + reproducedAt,
    '状态: ' + mapped.zh,
  ];
  if (mapped.note) lines.push('状态备注: ' + mapped.note);
  lines.push('项目: ' + (b.projectId || b.project_id || b.project || ''));
  lines.push('来源: Vault bug ' + uuid);
  if (b.branch) lines.push('分支: ' + b.branch);
  if (b.commitSha) lines.push('提交: ' + b.commitSha);
  if (b.sourceTrack) lines.push('关联轨: ' + b.sourceTrack);
  if (b.priority) lines.push('优先级: ' + b.priority);
  if (b.severity) lines.push('严重度: ' + b.severity);
  const buildInfo = (payload.build && typeof payload.build === 'object') ? payload.build : null;
  if (buildInfo) lines.push('构建: ' + JSON.stringify(buildInfo));
  const envInfo = (payload.env && typeof payload.env === 'object') ? payload.env : (buildInfo && (buildInfo.os || buildInfo.hw) ? { os: buildInfo.os, hw: buildInfo.hw } : null);
  if (envInfo) lines.push('环境: ' + JSON.stringify(envInfo));
  if (Array.isArray(payload.steps) && payload.steps.length) lines.push('复现步骤: ' + JSON.stringify(payload.steps));
  if (payload.reproRate && typeof payload.reproRate === 'object') lines.push('复现: ' + JSON.stringify(payload.reproRate));
  if (payload.worldState && typeof payload.worldState === 'object') lines.push('世界状态: ' + JSON.stringify(payload.worldState));
  if (payload.reporter && typeof payload.reporter === 'object') lines.push('上报者: ' + JSON.stringify(payload.reporter));
  if (payload.caseContext && typeof payload.caseContext === 'object') lines.push('E2E上下文: ' + JSON.stringify(payload.caseContext));
  if (payload.verification && typeof payload.verification === 'object') lines.push('修复验证: ' + JSON.stringify(payload.verification));
  const gaps = Array.isArray(payload.dataGaps) ? payload.dataGaps : (Array.isArray(b.dataGaps) ? b.dataGaps : []);
  if (gaps.length) lines.push('数据缺口: ' + gaps.join(', '));
  // 历史包（旧采集）显式标注，避免被误读为当前上报缺字段
  if (payload.legacyCapture === true) lines.push('历史采集: true');
  if (payload.dataGapsReason) lines.push('数据缺口原因: ' + payload.dataGapsReason);
  if (payload.legacyCaptureInfo && typeof payload.legacyCaptureInfo === 'object') lines.push('历史采集信息: ' + JSON.stringify(payload.legacyCaptureInfo));
  const totalFiles = evidence.listed.length;
  if (entries.length > 0 || totalFiles > 0) {
    const c = evidence.counts;
    lines.push('证据: ' + entries.length + ' 个报告 / ' + totalFiles + ' 个文件（截图 ' + c.screenshot + ' / 日志 ' + c.log + ' / 其他 ' + (c.attachment + c.readme) + '）');
    const screenshots = evidence.listed.filter((f) => f.role === 'screenshot').map((f) => f.rel);
    const logs = evidence.listed.filter((f) => f.role === 'log').map((f) => f.rel);
    if (screenshots.length > 0) lines.push('截图: ' + summarizeNames(screenshots, 8));
    if (logs.length > 0) lines.push('日志: ' + summarizeNames(logs, 8));
    lines.push('文件:');
    for (const file of evidence.listed.slice(0, MAX_FILE_LINES)) {
      const mark = file.missing ? ' [未落地]' : file.limit ? ' [超出附件上限]' : '';
      lines.push('- ' + file.rel + ' (' + humanSize(file.size) + ', sha256 ' + (file.sha ? file.sha.slice(0, 12) + '…' : '-') + ')' + mark);
    }
    if (evidence.listed.length > MAX_FILE_LINES) lines.push('- … 共 ' + evidence.listed.length + ' 个文件');
    if (!OBJECTS_DIR) lines.push('附件说明: 未检测到本地对象目录（VAULT_OBJECTS_DIR 未设置或不存在），文件保留在 Vault，可经 Vault API/运维导出获取。');
  } else {
    lines.push('证据: 无关联报告');
  }
  lines.push('历史变更:');
  for (const item of timeline) lines.push(item);
  lines.push('');
  fs.writeFileSync(path.join(dir, 'Readme.md'), lines.join('\n'));
  return true;
}

async function main() {
  fs.mkdirSync(BUGS, { recursive: true });
  const status = { at: new Date().toISOString(), vault: VAULT, objectsDir: OBJECTS_DIR || null, maxAttachmentMB: MAX_ATTACHMENT_MB, health: null, bugs: null, reports: null, written: 0, statusMap: {}, statusFallback: {}, metrics: { bugsProcessed: 0, descriptionFilled: 0, evidenceBugs: 0, timelineBugs: 0, attachmentsCopied: 0, attachmentsBytes: 0, attachmentsSkipped: 0, attachmentMissingObjects: 0, attachmentLimitHit: 0 }, notes: [] };
  const h = await getJson(VAULT + '/api/v1/health');
  status.health = h.status;
  if (h.status !== 200) status.notes.push('vault health ' + h.status);
  try {
    status.bugPages = [];
    let offset = 0;
    for (let page = 0; page < 50; page += 1) {
      const r = await getJson(VAULT + '/api/v1/bugs?limit=500&offset=' + offset);
      status.bugs = r.status;
      if (r.status !== 200) { status.notes.push('bugs offset=' + offset + ' -> ' + r.status); break; }
      const items = Array.isArray(r.body) ? r.body : (r.body.items || r.body.data || []);
      status.bugPages.push(items.length);
      if (r.body && typeof r.body.total === 'number') status.bugsTotal = r.body.total;
      for (const b of items) if (await writeBug(b, status)) status.written += 1;
      if (items.length < 500) break;
      offset += items.length;
    }
  } catch (error) {
    status.notes.push('bugs error ' + String((error && error.message) || error));
  }
  try {
    const r = await getJson(VAULT + '/api/v1/reports?limit=50');
    status.reports = r.status;
    if (r.status !== 200) status.notes.push('/api/v1/reports -> ' + r.status);
  } catch (error) {
    status.notes.push('reports error ' + String((error && error.message) || error));
  }
  const m = status.metrics;
  m.descriptionFilledRate = m.bugsProcessed ? Math.round((m.descriptionFilled / m.bugsProcessed) * 1000) / 1000 : 0;
  m.evidenceRate = m.bugsProcessed ? Math.round((m.evidenceBugs / m.bugsProcessed) * 1000) / 1000 : 0;
  m.timelineRate = m.bugsProcessed ? Math.round((m.timelineBugs / m.bugsProcessed) * 1000) / 1000 : 0;
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
  const summary = { written: status.written, bugsTotal: status.bugsTotal, metrics: m, objectsDir: status.objectsDir };
  log('vault-sync done', JSON.stringify(summary));
}
main().catch((e) => { log('vault-sync failed', String((e && e.stack) || e)); process.exitCode = 1; });
