import { spawnSync } from 'node:child_process';

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * git 调用封装。**从不使用 shell**：args 为数组，避免 Windows 引号/路径转义踩坑。
 * 返回 {code, stdout, stderr, error}。
 */
export function git(args, opts = {}) {
  const { cwd, env, input = undefined, timeout = 120000 } = opts;
  const r = spawnSync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    timeout,
  });
  return {
    code: r.status === null ? (r.error ? 127 : 1) : r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

export function gitOk(args, opts = {}) {
  const r = git(args, opts);
  if (r.code !== 0) {
    const err = new Error('git ' + args.join(' ') + ' 失败: ' + (r.stderr || r.stdout || r.error || ('exit ' + r.code)));
    err.code = 'git_failed';
    err.details = r;
    throw err;
  }
  return r.stdout;
}

export function gitVersion(cwd) {
  const r = git(['--version'], { cwd });
  return r.code === 0 ? r.stdout.replace(/^git version\s*/, '') : null;
}

export function isGitRepo(dir) {
  return git(['rev-parse', '--show-toplevel'], { cwd: dir }).code === 0;
}

export function gitTopLevel(dir) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd: dir });
  return r.code === 0 ? r.stdout.replace(/\n/g, '') : null;
}

export function gitHead(dir) {
  const r = git(['rev-parse', '--verify', 'HEAD'], { cwd: dir });
  return r.code === 0 ? r.stdout : null;
}

/** git ls-tree -r --name-only <ref> -- <sub>  ->  相对 workspace 的 POSIX 路径数组（已排序）。 */
export function lsTreeNames(dir, ref, sub) {
  const r = git(['ls-tree', '-r', '--name-only', '-z', ref, '--', sub], { cwd: dir });
  if (r.code !== 0) return { ok: false, names: [], error: r.stderr || r.stdout };
  const names = r.stdout.split('\u0000').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
  return { ok: true, names: names.sort() };
}

/** git ls-tree -r -l -z <ref> -- <sub>  ->  [{mode,type,oid,size,path}]（path 为 POSIX） */
export function lsTreeEntries(dir, ref, sub) {
  const r = git(['ls-tree', '-r', '-l', '-z', ref, '--', sub], { cwd: dir });
  if (r.code !== 0) return { ok: false, entries: [], error: r.stderr || r.stdout };
  const entries = [];
  for (const rec of r.stdout.split('\u0000')) {
    if (!rec) continue;
    const m = /^(\d+) (\w+) ([0-9a-f]+)\s+(\S+)\t(.*)$/.exec(rec);
    if (!m) continue;
    entries.push({ mode: m[1], type: m[2], oid: m[3], size: m[4] === '-' ? null : Number(m[4]), path: m[5].replace(/\\/g, '/') });
  }
  return { ok: true, entries, entriesByPath: new Map(entries.map((e) => [e.path, e])) };
}

/** git status --porcelain -z --untracked-files=no  ->  变更路径（仅 tracked）。 */
export function changedPaths(dir) {
  const r = git(['status', '--porcelain', '-z', '--untracked-files=no'], { cwd: dir });
  if (r.code !== 0) return [];
  return r.stdout.split('\u0000').filter(Boolean).map((s) => s.slice(3).replace(/\\/g, '/'));
}

export function currentBranch(dir) {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  return r.code === 0 ? r.stdout : null;
}

export function configGet(dir, key) {
  const r = git(['config', '--local', '--get', key], { cwd: dir });
  return r.code === 0 ? r.stdout : null;
}
