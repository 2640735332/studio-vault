import fs from 'node:fs';
import { sha256Buf } from './json.js';

export const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
/** LFS pointer 上限：规范要求 < 1KB；实测 130~200B。 */
export const LFS_POINTER_MAX_BYTES = 1024;

/** 解析 LFS 指针文本 -> {oid, size, sha256} 或 null（非指针）。 */
export function parseLfsPointer(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf), 'utf8');
  if (buf.length === 0 || buf.length > LFS_POINTER_MAX_BYTES) return null;
  const text = buf.toString('utf8');
  if (!text.startsWith(LFS_POINTER_PREFIX)) return null;
  const oid = /(?:^|\n)oid sha256:([0-9a-f]{64})(?:\n|$)/.exec(text);
  const size = /(?:^|\n)size (\d+)(?:\n|$)/.exec(text);
  if (!oid || !size) return null;
  return { oid: oid[1], size: Number(size[1]), sha256: oid[1] };
}

/** 读文件判定是否 LFS 指针（只读前 1KB，二进制安全）。 */
export function readLfsPointer(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(LFS_POINTER_MAX_BYTES);
    const n = fs.readSync(fd, buf, 0, LFS_POINTER_MAX_BYTES, 0);
    return parseLfsPointer(buf.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

export function isLfsPointerFile(file) {
  return readLfsPointer(file) !== null;
}

/** 指针 oid 是否等于磁盘真实内容的 sha256（= 内容已就位，无需再拉 LFS）。 */
export function matchesLfsOid(file, oid) {
  try {
    return sha256Buf(fs.readFileSync(file)) === oid;
  } catch {
    return false;
  }
}

/** 文本类 LFS 白名单：文本类首启全量、二进制按需。 */
export const TEXT_LFS_EXTENSIONS = ['.md', '.html', '.htm', '.json', '.yml', '.yaml', '.svg', '.txt', '.css', '.js'];
export function isTextLikePath(rel) {
  const lower = String(rel).toLowerCase();
  return TEXT_LFS_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
