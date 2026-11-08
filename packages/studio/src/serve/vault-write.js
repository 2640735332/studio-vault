/**
 * Studio -> Vault 权威状态写通道
 * 读本地 writer token（不入库/不打印），按 legacy 8 位 ID 查 Vault bug，再用 If-Match 乐观锁 PATCH。
 * 默认关闭；常驻服务设 SPECVIEWER_VAULT_WRITE=1 + STUDIO_VAULT_WRITER_TOKEN_FILE 开启。
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const VAULT_URL = (process.env.VAULT_URL || 'http://127.0.0.1:3460').replace(/\/+$/, '');
const TOKEN_FILE = process.env.STUDIO_VAULT_WRITER_TOKEN_FILE
  || process.env.VAULT_WRITER_TOKEN_FILE
  || join(homedir(), '.studio', 'secrets', 'vault-writer-token.txt');
const TIMEOUT_MS = Number(process.env.STUDIO_VAULT_WRITE_TIMEOUT_MS || 12000);

const STATUS_TO_VAULT = {
  '新': 'new',
  '修复中': 'in_progress',
  '已关闭': 'fixed',
  '已关闭 · 非缺陷': 'false_red',
  '已关闭 · 重复': 'duplicate',
  '已关闭 · 设计面': 'closed',
  '已关闭 · 未复现': 'cannot_reproduce',
};
const CLOSED = new Set(['fixed', 'false_red', 'duplicate', 'design_followup', 'cannot_reproduce']);

export function vaultWriteEnabled() {
  return String(process.env.SPECVIEWER_VAULT_WRITE || '') === '1';
}

function readToken() {
  try {
    if (!existsSync(TOKEN_FILE)) return { ok: false, error: 'vault_token_missing', token_file: TOKEN_FILE };
    const token = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!token) return { ok: false, error: 'vault_token_empty', token_file: TOKEN_FILE };
    return { ok: true, token };
  } catch (e) {
    return { ok: false, error: 'vault_token_read_failed', detail: String((e && e.message) || e), token_file: TOKEN_FILE };
  }
}

async function vaultFetch(path, opts = {}) {
  const tk = readToken();
  if (!tk.ok) return { ok: false, http: 500, error: tk.error, detail: tk.token_file };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(VAULT_URL + path, {
      ...opts,
      signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + tk.token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
    return { ok: res.ok, http: res.status, json };
  } catch (e) {
    return { ok: false, http: 0, error: 'vault_unreachable', detail: String((e && (e.name === 'AbortError' ? 'timeout' : e.message)) || e) };
  } finally { clearTimeout(timer); }
}

export function mapStatusToVault(zh) {
  return STATUS_TO_VAULT[String(zh || '').trim()] || null;
}

/** 从 folder/Readme 解析 8 位 legacy ID（Vault by-legacy 键）。 */
export function resolveLegacyId(bugsDir, folder, bugId) {
  const direct = String(bugId || '').trim();
  if (/^\d{8}$/.test(direct)) return direct;
  const m = String(folder || '').match(/(\d{8})$/);
  if (m) return m[1];
  try {
    const md = readFileSync(join(bugsDir, folder, 'Readme.md'), 'utf8');
    const idm = md.match(/^ID[:：]\s*(\d{8})\s*$/m);
    if (idm) return idm[1];
  } catch { /* ignore */ }
  return '';
}

/**
 * 写 Vault 权威状态；成功后才允许调用方更新展示缓存。
 * @returns {{ok:boolean, http?:number, error?:string, detail?:any, bugId?:string, legacyId?:string, version?:number, status?:string, code?:string}}
 */
export async function patchVaultByLegacy({ bugsDir, folder, bugId, statusZh, reason }) {
  const legacyId = resolveLegacyId(bugsDir, folder, bugId);
  if (!legacyId) return { ok: false, http: 400, error: 'legacy_id_missing', detail: '无法从目录/Readme 解析 8 位 ID' };
  const code = mapStatusToVault(statusZh);
  if (!code) return { ok: false, http: 400, error: 'invalid_status', detail: 'Vault 不支持的状态: ' + String(statusZh || '') };
  const got = await vaultFetch('/api/v1/bugs/by-legacy/' + encodeURIComponent(legacyId), { method: 'GET' });
  if (!got.ok) {
    return { ok: false, http: got.http || 502, error: got.http === 404 ? 'vault_bug_not_found' : (got.error || 'vault_lookup_failed'), detail: { status: got.http, body: got.json }, legacyId };
  }
  const bug = got.json && got.json.bug ? got.json.bug : null;
  if (!bug || !bug.id) return { ok: false, http: 502, error: 'vault_bad_response', detail: got.json, legacyId };
  const body = { status: code, historyNote: String(reason || 'Studio 状态流转').slice(0, 400) };
  if (CLOSED.has(code)) body.resolution = code;
  if (String(statusZh).includes('设计面')) { body.status = 'closed'; body.resolution = 'design_followup'; }
  async function doPatch(version) {
    return vaultFetch('/api/v1/bugs/' + encodeURIComponent(bug.id), {
      method: 'PATCH',
      headers: { 'If-Match': String(version || 1) },
      body: JSON.stringify(body),
    });
  }
  let patched = await doPatch(bug.version);
  if (patched.http === 409) {
    // version 冲突：重取一次版本号再重试（vault-impl 契约建议）
    const fresh = await vaultFetch('/api/v1/bugs/by-legacy/' + encodeURIComponent(legacyId), { method: 'GET' });
    const freshBug = fresh.ok && fresh.json && fresh.json.bug ? fresh.json.bug : null;
    if (freshBug && freshBug.version) patched = await doPatch(freshBug.version);
  }
  if (!patched.ok) {
    return { ok: false, http: patched.http || 502, error: patched.http === 409 ? 'vault_version_conflict' : 'vault_patch_failed', detail: patched.json || patched.error, legacyId, version: bug.version };
  }
  const newBug = patched.json && patched.json.bug ? patched.json.bug : null;
  return { ok: true, legacyId, bugId: bug.id, version: newBug ? newBug.version : null, status: newBug ? newBug.status : code, code, history: newBug && newBug.payload ? newBug.payload.history : null };
}

export { VAULT_URL, TOKEN_FILE };
