import fs from 'node:fs';
import path from 'node:path';

/** 递归枚举普通文件 -> 相对 root 的 POSIX 路径（已排序）。跳过点目录（.git 等）。 */
export function walkFiles(root, opts = {}) {
  const { skipDotDirs = true } = opts;
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const dir = path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (skipDotDirs && ent.name.startsWith('.')) continue;
        stack.push(childRel);
      } else if (ent.isFile()) {
        out.push(childRel);
      }
    }
  }
  out.sort();
  return out;
}

/** 目录是否为 symlink/junction（禁止 junction）。 */
export function isLinkOrJunction(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return { isLink: true, kind: 'symlink' };
    const real = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
    const abs = path.resolve(target);
    if (path.resolve(real).toLowerCase() !== abs.toLowerCase()) return { isLink: true, kind: 'junction', realpath: real };
    return { isLink: false, kind: null };
  } catch (err) {
    return { isLink: false, kind: null, error: String((err && err.message) || err) };
  }
}

export function statSafe(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0, isFile: false };
  }
}

/** 相对路径集合差集：a 中不在 b 的项。 */
export function setDiff(a, b) {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

export function dirSize(root) {
  let total = 0;
  let files = 0;
  for (const rel of walkFiles(root)) {
    const st = statSafe(path.join(root, rel));
    if (st.isFile) { total += st.size; files += 1; }
  }
  return { bytes: total, files };
}
