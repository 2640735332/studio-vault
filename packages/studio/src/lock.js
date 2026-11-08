import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadShared } from './deps.js';

const S = await loadShared();

export const DEFAULT_TIMEOUT_S = 120;
export const DEFAULT_HEARTBEAT_MS = 15000;

export function pidAlive(pid) {
  if (!pid || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

/** 判定锁是否 stale（心跳过期 / 跨机无法判 PID / 本机 PID 已死）。 */
export function lockState(lockFile, { now = Date.now(), timeoutS = DEFAULT_TIMEOUT_S } = {}) {
  if (!fs.existsSync(lockFile)) return { held: false, stale: false, data: null };
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch (err) {
    return { held: true, stale: true, stale_reason: 'unreadable:' + err.message, data: null };
  }
  const hb = Date.parse(data.heartbeat_at || data.acquired_at || 0) || 0;
  const timeoutMs = (data.timeout_s || timeoutS) * 1000;
  const sameHost = String(data.host || '').toLowerCase() === os.hostname().toLowerCase();
  const heartBeatExpired = !hb || now - hb > timeoutMs;
  if (!sameHost) {
    return { held: true, stale: heartBeatExpired, stale_reason: heartBeatExpired ? 'heartbeat_expired' : null, data };
  }
  if (!pidAlive(data.pid)) return { held: true, stale: true, stale_reason: 'pid_dead', data };
  if (heartBeatExpired) return { held: true, stale: true, stale_reason: 'heartbeat_expired', data };
  return { held: true, stale: false, data };
}

/** Windows 并发 rename/unlink 会被短暂占用（EPERM/EBUSY/EACCES）⇒ 有界重试，避免 8 并发下假失败。 */
function retryFs(fn, { attempts = 8, waitMs = 25 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return { ok: true, value: fn() };
    } catch (err) {
      last = err;
      const code = err && (err.code || '');
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  throw last;
}

function writeLock(lockFile, data) {
  S.ensureDir(path.dirname(lockFile));
  const tmp = lockFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8' });
  retryFs(() => fs.renameSync(tmp, lockFile));
}

/**
 * 单机写事务锁：锁文件 PID/owner/心跳/超时 120s/stale 判定；与 git index.lock 分离（先锁后 git）。
 * @returns {{ok:boolean, stale_taken:boolean, data:object}}
 */
export function acquire(lockFile, opts = {}) {
  const {
    owner = 'studio:' + process.pid,
    project = null,
    timeoutS = DEFAULT_TIMEOUT_S,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    waitMs = 0,
    stealStale = true,
  } = opts;
  const deadline = Date.now() + Math.max(0, waitMs);
  let staleTaken = false;
  for (;;) {
    const state = lockState(lockFile, { timeoutS });
    if (!state.held) {
      const data = {
        pid: process.pid,
        owner,
        project,
        host: os.hostname(),
        nonce: Date.now().toString(36) + '-' + process.pid,
        acquired_at: S.nowIso(),
        heartbeat_at: S.nowIso(),
        timeout_s: timeoutS,
        cwd: process.cwd(),
      };
      writeLock(lockFile, data);
      const verify = lockState(lockFile, { timeoutS });
      if (verify.held && verify.data && verify.data.nonce === data.nonce) {
        return { ok: true, data, stale_taken: staleTaken };
      }
    } else if (state.stale && stealStale) {
      try { retryFs(() => fs.unlinkSync(lockFile)); } catch { /* 竞态：他人已释放 */ }
      staleTaken = true;
      continue;
    }
    if (Date.now() >= deadline) {
      const err = new Error('共享仓写锁被占用: ' + lockFile + '（owner=' + (state.data && state.data.owner) + '）');
      err.code = 'lock_busy';
      err.details = state;
      err.hint = '等待或排查：node packages/studio/bin/studio.js lock status（stale 会自动接管）';
      throw err;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}

/** 锁持有者心跳；返回 stop()。 */
export function startHeartbeat(lockFile, data, { intervalMs = DEFAULT_HEARTBEAT_MS } = {}) {
  const timer = setInterval(() => {
    try {
      const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (cur.nonce !== data.nonce) return;
      cur.heartbeat_at = S.nowIso();
      writeLock(lockFile, cur);
    } catch { /* 锁已释放 */ }
  }, Math.max(1000, intervalMs));
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

export function release(lockFile, data) {
  try {
    const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (data && cur.nonce !== data.nonce) return { ok: false, error: 'owner_mismatch' };
    retryFs(() => fs.unlinkSync(lockFile));
    return { ok: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, already_released: true };
    return { ok: false, error: String(err.message || err) };
  }
}

export function withLock(lockFile, opts, fn) {
  const held = acquire(lockFile, opts);
  const stop = startHeartbeat(lockFile, held.data, { intervalMs: opts.heartbeatMs });
  try {
    return fn(held);
  } finally {
    stop();
    release(lockFile, held.data);
  }
}
