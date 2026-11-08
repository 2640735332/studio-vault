import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** 原子写：先写同目录临时文件再 rename（避免半截 JSON）。 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? v : v.toFixed(2)) + ' ' + units[i];
}
