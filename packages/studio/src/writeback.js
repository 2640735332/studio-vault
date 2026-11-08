import fs from 'node:fs';
import path from 'node:path';
import { loadShared } from './deps.js';
import * as L from './lock.js';
import { compareMirror, sharedBriefsDir, sharedRepoState, journalUnwritten, mirrorFiles } from './mirror.js';

const S = await loadShared();

export const DEFAULT_MESSAGE = 'docs(briefs): write back shared-repo mirror';

/** 共享仓 HEAD tree 里存在、镜像已删除的路径（= 需回写的删除；默认不允许，需 --allow-delete）。 */
export function pendingRemovals(paths) {
  const tree = S.lsTreeNames(paths.sharedRoot, 'HEAD', paths.mirrorRel);
  if (!tree.ok) return [];
  const mirrorSet = new Set(mirrorFiles(paths).map((rel) => paths.mirrorRel + '/' + rel));
  return tree.names.filter((p) => !mirrorSet.has(p));
}

export function pendingWriteback(paths) {
  const cmp = compareMirror(paths);
  const dirty = sharedDirtyPaths(paths);
  return { pending: cmp.unwritten, removals: pendingRemovals(paths), shared_dirty: dirty, detail: cmp };
}

function sharedDirtyPaths(paths) {
  const r = S.git(['status', '--porcelain', '-z', '--untracked-files=no', '--', paths.mirrorRel], { cwd: paths.sharedRoot });
  if (r.code !== 0) return [];
  return r.stdout.split('\u0000').filter(Boolean).map((s) => s.slice(3).replace(/\\/g, '/'));
}

function copyMirrorToShared(paths, rels) {
  const srcDir = sharedBriefsDir(paths);
  const copied = [];
  for (const rel of rels) {
    const from = path.join(paths.mirrorRoot, rel);
    const to = path.join(srcDir, rel);
    if (!fs.existsSync(from)) continue;
    S.ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
    copied.push(rel);
  }
  return copied;
}

/** Windows 上 git 并发/瞬时占用会导致 add/commit 偶发失败 ⇒ 有界重试（错误串限定 index.lock/Unable to create 等）。 */
function gitRetry(args, opts = {}, { attempts = 6, waitMs = 200 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const r = S.git(args, opts);
    if (r.code === 0) return r;
    last = r;
    const text = String((r.stderr || '') + (r.stdout || ''));
    if (!/index\.lock|Unable to create|File exists|cannot lock ref|another git process|unable to write|Operation not permitted|Permission denied|EBUSY|EACCES|EPERM|failed to write|bad object/i.test(text)) return r;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs * (i + 1));
  }
  return last;
}

function commitShared(paths, message, removals = []) {
  // 删除回写：仅当调用方显式 --allow-delete（镜像删文件 ⇒ 共享仓同步删除）
  if (removals.length) {
    const rm = S.git(['rm', '-f', '--ignore-unmatch', '-q', '--'].concat(removals), { cwd: paths.sharedRoot });
    if (rm.code !== 0) return { ok: false, code: 'git_rm_failed', stderr: rm.stderr || rm.stdout, removals };
  }
  // 单写方：整棵 mirrorRel 子树 add -A（同时吸收上次失败留下的 dirty 工作树，防漏提交）
  const added = gitRetry(['add', '-A', '--', paths.mirrorRel], { cwd: paths.sharedRoot });
  if (added.code !== 0) return { ok: false, code: 'git_add_failed', stderr: added.stderr || added.stdout };
  const staged = S.git(['diff', '--cached', '--name-only', '--', paths.mirrorRel], { cwd: paths.sharedRoot });
  if (staged.code !== 0) return { ok: false, code: 'git_diff_failed', stderr: staged.stderr };
  const stagedFiles = staged.stdout ? staged.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (!stagedFiles.length) return { ok: true, committed: false, staged: [], reason: 'no_staged_changes' };
  const commit = gitRetry(['commit', '-m', message], { cwd: paths.sharedRoot });
  if (commit.code !== 0) {
    const err = (commit.stderr || commit.stdout || '');
    const identity = /Author identity unknown|unable to auto-detect email/i.test(err);
    return {
      ok: false,
      code: identity ? 'git_identity_missing' : 'git_commit_failed',
      stderr: err,
      staged: stagedFiles,
      hint: identity
        ? '共享仓缺 git 身份：git -C ' + paths.sharedRoot + ' config user.name "<name>"; git -C ' + paths.sharedRoot + ' config user.email "<mail>"'
        : '共享仓 commit 失败：先看 stderr，再重跑 node scripts/studio/cli.cjs commit',
    };
  }
  return { ok: true, committed: true, staged: stagedFiles, head: S.gitHead(paths.sharedRoot) };
}

export function pushWithRetry(paths, { attempts = 3 } = {}) {
  const branch = paths.sharedBranch;
  const results = [];
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const r = S.git(['push', 'origin', 'HEAD:' + branch], { cwd: paths.sharedRoot, timeout: 180000 });
    results.push({ attempt: i + 1, code: r.code, stderr: (r.stderr || '').slice(0, 800) });
    if (r.code === 0) return { ok: true, attempts: i + 1, results };
    last = r;
    if (i < attempts - 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * Math.pow(2, i));
      const pull = S.git(['pull', '--rebase', 'origin', branch], { cwd: paths.sharedRoot, timeout: 180000 });
      // 跨机冲突：push 被拒 -> pull --rebase 冲突 => **保留本地 commit、abort rebase**，输出结构化冲突清单（不静默丢数据）
      const conflicts = S.git(['diff', '--name-only', '--diff-filter=U'], { cwd: paths.sharedRoot });
      const conflictFiles = conflicts.code === 0 && conflicts.stdout ? conflicts.stdout.split(/\r?\n/).filter(Boolean) : [];
      if (pull.code !== 0 && conflictFiles.length) {
        S.git(['rebase', '--abort'], { cwd: paths.sharedRoot });
        return {
          ok: false,
          code: 'push_conflict',
          attempts: i + 1,
          results,
          conflicts: conflictFiles,
          hint: '跨机冲突：本地 commit 已保留（未丢数据）；请人工合并后重跑 studio commit（或先 git -C <sharedRoot> pull --rebase 解冲突）',
        };
      }
    }
  }
  return { ok: false, code: 'push_failed', attempts, results, stderr: last ? last.stderr || last.stdout : null };
}

/**
 * 回写共享仓：写事务锁内 -> 复制镜像差异 -> git add -A mirrorRel -> 单写方 commit -> push 重试 3 次。
 * 失败时先落 journal（内容留档）再返回错误；不静默丢数据。
 */
export function writeback(paths, opts = {}) {
  const { dryRun = false, push = true, message = DEFAULT_MESSAGE, owner = 'studio:commit:' + process.pid, waitMs = 0, allowDelete = false } = opts;
  const state = sharedRepoState(paths);
  if (!state.ok) return { ok: false, code: 'shared_repo_not_ready', state, hint: 'node scripts/studio/bootstrap.cjs' };
  const cmp = compareMirror(paths, { useCache: false });
  const dirty = sharedDirtyPaths(paths);
  const removals = pendingRemovals(paths);
  if (dryRun) {
    return { ok: true, code: 'dry_run', pending: cmp.unwritten, removals, allow_delete: allowDelete, shared_dirty: dirty, shared_root: paths.sharedRoot };
  }
  if (removals.length && !allowDelete) {
    return { ok: false, code: 'deletions_pending', removals, hint: '镜像删除了共享仓里存在的文件：确认后加 --allow-delete 回写删除（防误删）' };
  }
  if (!cmp.unwritten.length && !removals.length && !dirty.length) return { ok: true, code: 'nothing_to_write_back', pending: [] };

  return L.withLock(paths.lockFile, { owner, project: paths.projectId, waitMs }, () => {
    const cmp2 = compareMirror(paths, { useCache: false });
    const dirty2 = sharedDirtyPaths(paths);
    const removals2 = allowDelete ? pendingRemovals(paths) : [];
    if (!cmp2.unwritten.length && !removals2.length && !dirty2.length) return { ok: true, code: 'nothing_to_write_back', pending: [] };
    const copied = copyMirrorToShared(paths, cmp2.unwritten);
    const committed = commitShared(paths, message, removals2);
    if (!committed.ok) {
      const journal = journalUnwritten(paths, cmp2.unwritten, { reason: 'writeback_failed' });
      return { ok: false, code: committed.code, detail: committed, journal, hint: committed.hint || '共享仓 commit 失败（journal 已留档）' };
    }
    const out = {
      ok: true,
      code: committed.committed ? 'committed' : 'nothing_to_write_back',
      copied,
      removed: removals2,
      staged: committed.staged,
      head: committed.head || null,
      shared_dirty_absorbed: dirty2,
    };
    if (committed.committed && push) {
      const pushed = pushWithRetry(paths);
      out.pushed = pushed.ok;
      out.push = pushed;
      if (!pushed.ok) {
        out.ok = false;
        out.code = pushed.code || 'push_failed';
        out.hint = pushed.hint || '推送到 Gitea 失败（本地已 commit）：检查 token/网络后重跑 node scripts/studio/cli.cjs commit；冲突清单见 push.results';
        journalUnwritten(paths, [], { reason: 'push_failed' });
      }
    }
    return out;
  });
}
