/**
 * transition.js — Studio 状态流转（brief / bug）：状态矩阵校验 + Markdown 写回。
 *
 * 纯本地能力：不依赖任何外部服务。
 * 端点：POST /api/specviewer/transition
 *   请求 { kind: 'brief'|'bug', id|itemId|folder, action, reason?, masterId?, note? }
 *   响应 { ok, from, to, skipped? }
 *
 * 写方：
 *   - brief：自包含，直接改写 docs/briefs/<id>/BRIEF.md 的「状态:」行（不依赖目标仓脚本）；
 *   - bug：先写 Vault 权威（SPECVIEWER_VAULT_WRITE=1 时），再把 Readme 当展示缓存补写；
 *          若轨 BUG.md「缺陷总览」首列含该 8 位 ID，best-effort 调用 scripts/spec-track.js
 *          （目标仓无该脚本时 trackRow='skipped_no_script'，不阻塞 Readme / Vault 写）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { patchBugReadme, canonicalBugStatus, resolvePatchStatus } from './bug-status.js';
import { vaultWriteEnabled, patchVaultByLegacy } from './vault-write.js';

// ---------------------------------------------------------------------------
// 常量 / 状态矩阵
// ---------------------------------------------------------------------------

export const BRIEF_STATUS = ['草稿', '可交 spec-engine', '实现中', '已实现', '已否决'];
export const BUG_STATUS = ['新', '修复中', '已关闭', '已关闭 · 非缺陷', '已关闭 · 重复'];

/**
 * 状态迁移矩阵。
 * always=true 表示状态不变动作（中断）即便 from==to 也算合法迁移。
 */
export const MATRIX = {
  brief: [
    { action: 'mark_ready', label: '标记可交', from: ['草稿'], to: '可交 spec-engine' },
    { action: 'start_impl', label: '开始实现', from: ['可交 spec-engine'], to: '实现中' },
    { action: 'mark_done', label: '标记已实现', from: ['实现中'], to: '已实现' },
    { action: 'reject', label: '否决', from: ['草稿', '可交 spec-engine', '实现中'], to: '已否决' },
    { action: 'send_back', label: '退回', from: ['可交 spec-engine'], to: '草稿' },
    { action: 'undo', label: '撤销', from: ['已否决'], to: '草稿' },
    { action: 'undo', label: '撤销', from: ['已实现'], to: '实现中' },
    { action: 'undo', label: '撤销', from: ['实现中'], to: '可交 spec-engine' },
    { action: 'interrupt', label: '中断', from: ['实现中'], to: '实现中', always: true },
    { action: 'interrupt', label: '中断', from: ['已实现'], to: '已实现', always: true },
  ],
  bug: [
    { action: 'start_fix', label: '开始制作', from: ['新'], to: '修复中' },
    { action: 'mark_done', label: '标记已实现', from: ['新', '修复中'], to: '已关闭' },
    { action: 'close_false_red', label: '关包·非缺陷', from: ['新', '修复中'], to: '已关闭 · 非缺陷', requires: 'reason' },
    { action: 'close_duplicate', label: '关包·重复', from: ['新', '修复中'], to: '已关闭 · 重复', requires: 'masterId' },
    { action: 'reopen', label: '重开', from: ['已关闭', '已关闭 · 非缺陷', '已关闭 · 重复'], to: '新' },
    { action: 'interrupt', label: '中断', from: ['新'], to: '新', always: true },
    // 修复中 → 新：中断/撤销。
    { action: 'interrupt', label: '中断/撤销', from: ['修复中'], to: '新' },
  ],
};

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

export function normalizeWhitespace(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 矩阵查找：返回 {ok,row,to,requires} 或 {ok:false,error}；已到目标状态时 skipped。 */
export function buildTransition(kind, fromRaw, action) {
  const rows = MATRIX[kind];
  if (!rows) return { ok: false, error: 'unknown_kind' };
  const from = String(fromRaw == null ? '' : fromRaw).trim();
  const matches = rows.filter((r) => r.action === action);
  if (!matches.length) return { ok: false, error: 'unknown_action' };
  const row = matches.find((r) => r.from.includes(from));
  if (!row) {
    const target = matches.find((r) => r.to === from);
    if (target && !target.always) {
      return { ok: true, skipped: true, reason: 'already_at_target', to: from, row: target };
    }
    return { ok: false, error: 'illegal_transition', from, action };
  }
  return { ok: true, row, to: row.to, requires: row.requires || null };
}

// ---------------------------------------------------------------------------
// 默认写方（brief 自包含写 Markdown；bug 走 Vault + Readme，轨文档 best-effort）
// ---------------------------------------------------------------------------

/**
 * 自包含 brief 状态写方：直接改写 docs/briefs/<folder>/BRIEF.md 的「状态:」行。
 * - 保留文件其余内容（含行尾空格 / 变更记录等）；
 * - 原行用 **加粗** 写法时保持加粗（Studio 演示模板就是 `状态: **草稿**`）；
 * - 行不存在时追加到文末；
 * - 不依赖目标仓任何脚本（开源工作区即可用）。
 * note 参数仅为兼容旧调用签名保留，不写入文件。
 */
function defaultWriteBriefStatus({ briefsDir, folder, status }) {
  if (!BRIEF_STATUS.includes(status)) return { ok: false, http: 400, error: 'invalid_status' };
  const dir = join(briefsDir, folder);
  const file = join(dir, 'BRIEF.md');
  if (!existsSync(file)) return { ok: false, http: 404, error: 'not_found' };
  let md;
  try { md = readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, http: 500, error: 'read_failed', detail: String((e && e.message) || e) };
  }
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const lineRe = /^(状态[:：][ \t]*)([^\r\n]*)$/m;
  const hit = lineRe.exec(md);
  let next;
  if (hit) {
    const bold = /\*{2}/.test(hit[2]);
    next = md.replace(lineRe, (_all, prefix) => prefix + (bold ? `**${status}**` : status));
  } else {
    next = String(md).replace(/\s*$/, '') + eol + eol + '状态: ' + status + eol;
  }
  try { writeFileSync(file, next); } catch (e) {
    return { ok: false, http: 500, error: 'write_failed', detail: String((e && e.message) || e) };
  }
  return { ok: true, status, file };
}

/** 只读定位：轨 BUG.md「缺陷总览」表首列 == 8 位 ID（不改文档）。 */
export function findTrackBugRow(md, bugId) {
  const want = String(bugId || '').trim();
  if (!/^\d{8}$/.test(want)) return false;
  let inOverview = false;
  for (const line of String(md || '').split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) { inOverview = /缺陷总览/.test(line); continue; }
    if (!inOverview || !/^\s*\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells[1] === want) return true;
  }
  return false;
}

/** 跨包定位含该 8 位 ID 首列行的轨 BUG.md（返回 {file,package,track} 或 null）。 */
export function locateTrackBugFile(specsDir, bugId, fsDeps = {}) {
  const readDir = fsDeps.readDir || readdirSync;
  const readFile = fsDeps.readFile || readFileSync;
  const exists = fsDeps.exists || existsSync;
  const want = String(bugId || '').trim();
  if (!/^\d{8}$/.test(want)) return null;
  let pkgs;
  try { pkgs = readDir(specsDir, { withFileTypes: true }); } catch { return null; }
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue;
    const pkgDir = join(specsDir, pkg.name);
    let tracks;
    try { tracks = readDir(pkgDir, { withFileTypes: true }); } catch { continue; }
    for (const tr of tracks) {
      if (!tr.isDirectory() || !tr.name.startsWith('track-')) continue;
      const file = join(pkgDir, tr.name, 'BUG.md');
      if (!exists(file)) continue;
      let md;
      try { md = readFile(file, 'utf8'); } catch { continue; }
      if (findTrackBugRow(md, want)) return { file, package: pkg.name, track: tr.name };
    }
  }
  return null;
}

/**
 * 轨 BUG.md 写方（best-effort）：目标仓存在 scripts/spec-track.js 时复用它（行为不变）；
 * 脚本不存在（开源工作区常态）时返回 {skipped:true}，由调用方记 trackRow:'skipped_no_script'，
 * 不阻塞 Readme / Vault 写入。
 */
function defaultWriteTrackStatus({ repoRoot, package: pkg, track, bugId, status }) {
  const script = join(repoRoot, 'scripts', 'spec-track.js');
  if (!existsSync(script)) return { ok: false, skipped: true, reason: 'no_script' };
  const r = spawnSync(process.execPath, [
    script, 'bug', 'set',
    '--package', String(pkg), '--track', String(track), '--id', String(bugId), '--status', String(status),
  ], { cwd: repoRoot, encoding: 'utf8' });
  return { ok: r.status === 0, exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readBugReadmeStatus(bugsDir, folder) {
  const dir = join(bugsDir, folder);
  const readme = ['Readme.md', 'README.md'].map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!readme) return null;
  try {
    const md = readFileSync(readme, 'utf8');
    const m = md.match(/^状态[:：]\s*(.*)$/m);
    return { readme, status: m ? m[1].trim() : '' };
  } catch { return null; }
}

async function defaultWriteBugStatus({ repoRoot, specsDir, bugsDir, folder, bugId, fields }) {
  const st = resolvePatchStatus(fields);
  if (!st.ok) return { ok: false, http: 400, json: { ok: false, error: st.error } };
  // 先写 Vault 权威，再写展示缓存（缓存被 vault-sync 覆盖也不会回退）。
  // 未开启写通道（本地开发，无 token）时保持旧本地行为；常驻服务开启后失败必须显式报错，不静默。
  let vault = null;
  if (vaultWriteEnabled()) {
    vault = await patchVaultByLegacy({
      bugsDir,
      folder,
      bugId,
      statusZh: st.status,
      reason: fields.reason || 'Studio 状态流转',
    });
    if (!vault.ok) {
      return { ok: false, http: vault.http || 502, json: { ok: false, error: 'vault_write_failed', vault, hint: 'Vault 权威未更新，展示缓存保持原状；请检查 token/网络后重试' } };
    }
  }
  const before = readBugReadmeStatus(bugsDir, folder);
  const r = patchBugReadme(bugsDir, folder, fields);
  if (!r.json || r.json.ok !== true) {
    return { ok: false, http: r.status || 500, json: { ...(r.json || { ok: false, error: 'write_failed' }), vault: vault || { skipped: true } } };
  }
  if (r.json.skipped) return { ok: true, http: r.status, json: { ...r.json, trackRow: 'noop', vault: vault || { skipped: true } } };
  // 两处一致：定位轨 BUG.md 首列 8 位行；命中则走既有 spec-track.js 写方。
  let loc = null;
  try { loc = locateTrackBugFile(specsDir, bugId); } catch { loc = null; }
  if (!loc) {
    // 无轨总览行（E2E 自动上报常见）：只写 Readme，不制造 conflict。
    return { ok: true, http: r.status, json: { ...r.json, trackRow: 'absent', vault: vault || { skipped: true } } };
  }
  const tw = defaultWriteTrackStatus({ repoRoot, package: loc.package, track: loc.track, bugId, status: st.status });
  if (tw.ok !== true && tw.skipped) {
    // best-effort：目标仓没有轨写脚本 → 只写 Readme/Vault，轨行保持原状，不 fail。
    return { ok: true, http: r.status, json: { ...r.json, trackRow: 'skipped_no_script', trackFile: loc.file, vault: vault || { skipped: true } } };
  }
  if (!tw.ok) {
    // 轨写失败 → 尽力回滚 Readme，保持两处状态一致。
    let rolledBack = false;
    if (before && before.status && before.status !== st.status) {
      const rb = patchBugReadme(bugsDir, folder, { status: before.status, reason: '轨 BUG.md 写失败，Readme 回滚' });
      rolledBack = !!(rb.json && rb.json.ok);
    }
    return { ok: false, http: 500, json: { ok: false, error: 'track_status_write_failed', readmeStatus: st.status, readmeRolledBack: rolledBack, trackFile: loc.file, detail: { exit: tw.exit, stderr: String(tw.stderr || '').slice(0, 500), stdout: String(tw.stdout || '').slice(0, 500) } } };
  }
  return { ok: true, http: r.status, json: { ...r.json, trackRow: 'updated', trackFile: loc.file, vault: vault || { skipped: true } } };
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export function createTransition(overrides = {}) {
  const deps = {
    repoRoot: resolve('.'),
    briefsDir: resolve('docs/briefs'),
    bugsDir: resolve('game/reports/bugs'),
    specsDir: resolve('specs'),
    writeBriefStatus: defaultWriteBriefStatus,
    writeBugStatus: defaultWriteBugStatus,
    ...overrides,
  };
  const inFlight = new Map(); // itemId -> Promise（同条目串行，防并发双写）

  function currentStatus(kind, id) {
    if (kind === 'brief') {
      const p = join(deps.briefsDir, id, 'BRIEF.md');
      if (!existsSync(p)) return { ok: false, error: 'not_found' };
      const md = readFileSync(p, 'utf8');
      const m = md.match(/^状态[:：]\s*\*{0,2}([^*\n|]+?)\*{0,2}\s*$/m);
      // 缺「状态:」行/空值 → 按草稿处理（与 server.js parseBriefMeta 的展示默认一致），
      // 这样「标记可交」等首步流转可用于刚手写、还没写状态行的新简报。
      const raw = m ? m[1].trim() : '';
      return { ok: true, status: raw || '草稿' };
    }
    const dir = join(deps.bugsDir, id);
    const readme = ['Readme.md', 'README.md'].map((f) => join(dir, f)).find((f) => existsSync(f));
    if (!readme) return { ok: false, error: 'not_found' };
    const md = readFileSync(readme, 'utf8');
    const m = md.match(/^状态[:：]\s*(.*)$/m);
    const idm = md.match(/^ID[:：]\s*(\d{8})\s*$/m);
    return { ok: true, status: m ? m[1].trim() : '', bugId: idm ? idm[1] : '' };
  }

  async function writeStatus(kind, id, row, req, cur) {
    if (kind === 'brief') {
      return deps.writeBriefStatus({ repoRoot: deps.repoRoot, briefsDir: deps.briefsDir, folder: id, status: row.to, note: req.note || '' });
    }
    const bugId = (cur && cur.bugId) || '';
    if (row.action === 'close_false_red') {
      return deps.writeBugStatus({ repoRoot: deps.repoRoot, specsDir: deps.specsDir, bugsDir: deps.bugsDir, folder: id, bugId, fields: { kind: 'false_red', reason: req.reason } });
    }
    if (row.action === 'close_duplicate') {
      return deps.writeBugStatus({ repoRoot: deps.repoRoot, specsDir: deps.specsDir, bugsDir: deps.bugsDir, folder: id, bugId, fields: { kind: 'duplicate', reason: req.masterId || req.reason } });
    }
    if (row.action === 'start_fix') {
      return deps.writeBugStatus({ repoRoot: deps.repoRoot, specsDir: deps.specsDir, bugsDir: deps.bugsDir, folder: id, bugId, fields: { kind: 'start_fix', reason: req.reason } });
    }
    if (row.action === 'interrupt') {
      // 修复中 → 新（中断/撤销）：直接写目标状态。
      return deps.writeBugStatus({ repoRoot: deps.repoRoot, specsDir: deps.specsDir, bugsDir: deps.bugsDir, folder: id, bugId, fields: { status: row.to, reason: req.reason || '中断/撤销修复' } });
    }
    const kindMap = { mark_done: 'fixed', reopen: 'reopen' };
    return deps.writeBugStatus({ repoRoot: deps.repoRoot, specsDir: deps.specsDir, bugsDir: deps.bugsDir, folder: id, bugId, fields: { kind: kindMap[row.action], reason: req.reason } });
  }

  function validItemId(id) {
    const s = String(id || '');
    if (!s || s === '.' || s === '..' || s.includes('..')) return false;
    for (const ch of s) if (ch === '/' || ch === '\\') return false;
    return /^[A-Za-z0-9._ -]+$/.test(s);
  }

  async function runTransition(req = {}) {
    const kind = String(req.kind || '').trim();
    const id = String(req.id || req.folder || req.itemId || '').trim();
    const action = String(req.action || '').trim();
    const reply = (http, body) => ({ http, body: body || {} });

    if (!MATRIX[kind]) return reply(400, { ok: false, error: 'unknown_kind', from: null, to: null });
    if (!validItemId(id)) return reply(400, { ok: false, error: 'invalid_id', from: null, to: null });

    const cur = currentStatus(kind, id);
    if (!cur.ok) return reply(404, { ok: false, error: cur.error, from: null, to: null });
    const from = kind === 'brief' ? cur.status : (canonicalBugStatus(cur.status).status || cur.status);

    const bt = buildTransition(kind, from, action);
    if (!bt.ok) {
      const http = bt.error === 'illegal_transition' ? 409 : 400;
      return reply(http, { ok: false, error: bt.error, from, to: null });
    }
    const row = bt.row;
    const to = bt.to;

    // requires 校验（false_red 原因 / duplicate 主号）
    if (row.requires && !bt.skipped) {
      const val = row.requires === 'masterId' ? (req.masterId || req.reason) : req.reason;
      if (!String(val || '').trim()) {
        return reply(400, { ok: false, error: row.requires === 'masterId' ? 'duplicate_requires_target' : 'reason_required', from, to });
      }
      if (row.requires === 'masterId' && !/\d{6,8}/.test(String(val))) {
        return reply(400, { ok: false, error: 'duplicate_requires_target', from, to });
      }
    }

    // 状态已达目标（中断等 always 动作除外）→ skipped，不重复写。
    if (bt.skipped) {
      return reply(200, { ok: true, skipped: true, reason: bt.reason || 'already_at_target', from, to: bt.to });
    }

    // 同条目 in-flight 串行，避免并发双写。
    if (inFlight.has(id)) {
      try { await inFlight.get(id); } catch { /* 前序失败不阻塞本次；真实错误已在前序响应里 */ }
    }

    const task = (async () => {
      // 状态不变动作（中断）无需写状态（避免 changelog 噪声 / undefined kind）
      if (to === from) {
        return reply(200, { ok: true, from, to, skipped: false, statusWritten: false });
      }
      let w;
      try { w = await writeStatus(kind, id, row, req, cur); }
      catch (e) { w = { ok: false, error: 'status_write_failed', detail: String((e && e.message) || e) }; }
      if (!w || !w.ok) {
        const detail = w && w.json ? w.json : w;
        return reply(500, { ok: false, error: { code: 'status_write_failed', message: '状态写失败', detail }, from, to, statusWritten: false });
      }
      const extra = (w && w.json) || {};
      return reply(200, {
        ok: true,
        from,
        to,
        skipped: false,
        statusWritten: true,
        trackRow: extra.trackRow || null,
        vault: extra.vault || null,
      });
    })();

    inFlight.set(id, task);
    try { return await task; } finally { if (inFlight.get(id) === task) inFlight.delete(id); }
  }

  return { runTransition, deps, _state: { inFlight } };
}

const defaultTransition = createTransition();
export const runTransition = (...a) => defaultTransition.runTransition(...a);
export default defaultTransition;
