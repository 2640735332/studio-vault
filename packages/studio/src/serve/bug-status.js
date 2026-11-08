/**
 * Bug Readme status patch helpers. Zero deps. node --test.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';

// CANONICAL = Readme `状态:` 行合法词。`修复中` 来自工作区 BUG 标准（specs/STANDARDS.md），
// 供状态流转的 start_fix（新→修复中）走既有 patchBugReadme 写方。
export const CANONICAL = ['新', '修复中', '已关闭', '已关闭 · 非缺陷', '已关闭 · 重复', '已关闭 · 设计面'];
export const KIND_MAP = {
  start_fix: '修复中',
  fixed: '已关闭',
  false_red: '已关闭 · 非缺陷',
  duplicate: '已关闭 · 重复',
  design_followup: '已关闭 · 设计面',
  reopen: '新',
};

export function isInside(root, full) {
  const r = resolve(root).replace(/[/\\]+$/, '').toLowerCase();
  const f = resolve(full).toLowerCase();
  return f === r || f.startsWith(r + sep) || f.startsWith(r + '/');
}

export function canonicalBugStatus(raw) {
  const s = String(raw || '').trim();
  if (CANONICAL.includes(s)) return { kind: 'canonical', status: s };
  if (KIND_MAP[s]) return { kind: 'canonical', status: KIND_MAP[s] };
  return { kind: 'unknown', raw: s };
}

export function resolvePatchStatus(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.status != null && String(b.status).trim() !== '') {
    const c = canonicalBugStatus(b.status);
    if (c.kind !== 'canonical') return { ok: false, error: 'invalid_status' };
    return { ok: true, status: c.status };
  }
  if (b.kind != null && String(b.kind).trim() !== '') {
    const mapped = KIND_MAP[String(b.kind).trim()];
    if (!mapped) return { ok: false, error: 'invalid_status' };
    return { ok: true, status: mapped };
  }
  return { ok: false, error: 'invalid_status' };
}

export function requireReason(status, reason) {
  if (status === '已关闭 · 非缺陷' && !String(reason || '').trim()) {
    return { ok: false, error: 'reason_required' };
  }
  // duplicate 语义本体 = 并入主号；无主号则拒绝（与 bug_report.py duplicate_requires_target 对齐）
  if (status === '已关闭 · 重复' && !String(reason || '').trim()) {
    return { ok: false, error: 'duplicate_requires_target' };
  }
  // design_followup 语义本体 = 「非代码缺陷 + 范围外后续交付」：reason 必须指向审计结论/清单
  if (status === '已关闭 · 设计面' && String(reason || '').trim().length < 20) {
    return { ok: false, error: 'design_followup_requires_reason' };
  }
  return { ok: true };
}

export function assertBugWritePath(bugsDir, folder) {
  const id = String(folder || '');
  if (!id || /[\\/]/.test(id) || id.includes('..') || id === '.' || id === '..') {
    return { ok: false, status: 403, error: 'path_escape' };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return { ok: false, status: 400, error: 'invalid_id' };
  }
  const full = resolve(join(bugsDir, id));
  if (!isInside(bugsDir, full)) {
    return { ok: false, status: 403, error: 'path_escape' };
  }
  try {
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      return { ok: false, status: 404, error: 'not_found' };
    }
  } catch {
    return { ok: false, status: 404, error: 'not_found' };
  }
  return { ok: true, dir: full };
}

export function pickReadmePath(dir) {
  const a = join(dir, 'Readme.md');
  const b = join(dir, 'README.md');
  if (existsSync(a)) return a;
  if (existsSync(b)) return b;
  return null;
}

export function currentStatusFromMd(md) {
  const m = String(md || '').match(/^状态[:：]\s*(.*)$/m);
  return m ? m[1].trim() : '';
}

export function applyBugStatusPatch(md, { status, reason, now, previous } = {}) {
  const target = status;
  const prev = previous != null ? previous : currentStatusFromMd(md);
  if (prev === target) return { md, skipped: true };
  const stamp = now || new Date().toISOString().slice(0, 19);
  const note = String(reason || '').trim() || (target === '修复中' ? '开始安排制作' : (target === '已关闭 · 非缺陷' ? '用例/oracle/环境假红' : (target === '已关闭 · 重复' ? '并入主号' : (target === '新' ? '重开' : '已验证'))));
  const hist = `- [${stamp}] ${target}: ${note}`;
  let text = String(md || '');
  if (/^状态[:：]\s*/m.test(text)) {
    text = text.replace(/^状态[:：]\s*.*$/m, `状态: ${target}`);
  } else {
    text = text.replace(/\s*$/, `\n状态: ${target}\n`);
  }
  if (/历史变更[:：]/.test(text)) {
    text = text.replace(/\s*$/, `\n${hist}\n`);
  } else {
    text = text.replace(/\s*$/, `\n\n历史变更:\n${hist}\n`);
  }
  return { md: text, skipped: false };
}

export function countHistoryLines(md) {
  return String(md || '').split(/\r?\n/).filter((l) => /^\s*[-*]\s+\[/.test(l)).length;
}

export function patchBugReadme(bugsDir, folder, body, now) {
  const st = resolvePatchStatus(body);
  if (!st.ok) return { status: 400, json: { ok: false, error: st.error } };
  const need = requireReason(st.status, body && body.reason);
  if (!need.ok) return { status: 400, json: { ok: false, error: need.error } };
  const pathRes = assertBugWritePath(bugsDir, folder);
  if (!pathRes.ok) return { status: pathRes.status, json: { ok: false, error: pathRes.error } };
  const readme = pickReadmePath(pathRes.dir);
  if (!readme) return { status: 404, json: { ok: false, error: 'not_found' } };
  let md;
  try { md = readFileSync(readme, 'utf8'); } catch {
    return { status: 404, json: { ok: false, error: 'not_found' } };
  }
  const applied = applyBugStatusPatch(md, {
    status: st.status,
    reason: body && body.reason,
    now,
  });
  if (!applied.skipped) {
    try { writeFileSync(readme, applied.md.endsWith('\n') ? applied.md : `${applied.md}\n`); }
    catch (e) {
      return { status: 400, json: { ok: false, error: 'write_failed', detail: String(e && e.message) } };
    }
  }
  return { status: 200, json: { ok: true, status: st.status, skipped: !!applied.skipped } };
}
