import fs from 'node:fs';
import path from 'node:path';
import { loadShared } from '../deps.js';
import { sharedRepoState, pullTextLfs, materialize, mirrorFiles, sharedTreeNames, sharedBriefsDir } from '../mirror.js';

const S = await loadShared();

export const name = 'bootstrap';
export const summary = '零命令落点：克隆共享仓 -> 文本类 LFS 全量 -> 物化 docs/briefs（禁 junction）-> 装 hooksPath -> 校验';
export const usage = 'studio bootstrap [--dry-run] [--update] [--force] [--json]';

function retry(fn, { attempts = 3, waitMs = 800 } = {}) {
  const errors = [];
  for (let i = 0; i < attempts; i++) {
    try {
      const r = fn(i + 1);
      if (r && r.ok) return { ...r, attempts: i + 1, errors };
      errors.push(r && r.error ? r.error : 'attempt_' + (i + 1) + '_failed');
    } catch (err) {
      errors.push(String((err && err.message) || err));
    }
    if (i < attempts - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs * Math.pow(2, i));
  }
  return { ok: false, attempts, errors };
}

export function bootstrap({ paths, config, dryRun = false, update = false, force = false }) {
  const steps = [];
  const push = (step, ok, extra = {}) => steps.push({ step, ok, ...extra });
  const remote = (config.shared && config.shared.remote) || null;

  push('config', true, { config_path: paths.configPath, project: paths.projectId });

  let state = sharedRepoState(paths);
  if (!state.ok) {
    if (!remote) {
      push('shared_repo', false, { degraded: true, reason: 'no remote in studio.config.json', hint: '在 studio.config.json 配 shared.remote，或手工 clone 到 ' + paths.sharedRoot });
    } else if (dryRun) {
      push('shared_repo', false, { planned: true, action: 'git clone --branch ' + paths.sharedBranch + ' ' + remote + ' ' + paths.sharedRoot });
    } else {
      const cloned = retry(() => {
        S.ensureDir(path.dirname(paths.sharedRoot));
        const r = S.git(['clone', '--branch', paths.sharedBranch, remote, paths.sharedRoot], { timeout: 900000 });
        return { ok: r.code === 0, error: r.stderr || r.stdout };
      });
      push('shared_repo', cloned.ok, {
        action: 'clone',
        attempts: cloned.attempts,
        errors: cloned.errors,
        reason: cloned.ok ? null : String((cloned.errors && cloned.errors[0]) || '').slice(0, 300) || null,
        remote,
      });
      state = sharedRepoState(paths);
    }
  } else {
    push('shared_repo', true, { head: state.head, branch: state.branch });
  }

  if (update && !dryRun && state.ok) {
    const pulled = S.git(['pull', '--rebase', 'origin', paths.sharedBranch], { cwd: paths.sharedRoot, timeout: 300000 });
    push('shared_update', pulled.code === 0, { stderr: (pulled.stderr || '').slice(0, 500) });
    state = sharedRepoState(paths);
  } else {
    push('shared_update', true, { skipped: true, reason: update ? 'dry_run' : 'not_requested' });
  }

  const lfsVersion = state.ok ? S.git(['lfs', 'version'], { cwd: paths.sharedRoot }) : { code: 1 };
  if (!state.ok) {
    push('lfs_text', false, { degraded: true, reason: 'shared repo not ready' });
  } else if (lfsVersion.code !== 0) {
    push('lfs_text', false, { degraded: true, reason: 'git-lfs not installed (>=3.4 required)', hint: '安装 git-lfs 后重跑 bootstrap' });
  } else if (dryRun) {
    const ptr = [];
    for (const rel of S.walkFiles(sharedBriefsDir(paths))) {
      if (!S.isTextLikePath(rel)) continue;
      if (S.isLfsPointerFile(path.join(sharedBriefsDir(paths), rel))) ptr.push(rel);
    }
    push('lfs_text', ptr.length === 0, { planned: true, text_pointers: ptr.length });
  } else {
    const pulled = pullTextLfs(paths);
    push('lfs_text', pulled.ok, { pulled: pulled.pulled, still_pointers: (pulled.still_pointers || []).length, stderr: pulled.stderr || null });
  }

  // 共享仓 git 身份：新机 clone 后首次 commit 会因 identity 缺失失败；从游戏仓（local/global）复制，幂等。
  let identity = { ok: true, skipped: true, reason: 'not_needed' };
  if (state.ok && !dryRun) {
    const curEmail = S.configGet(paths.sharedRoot, 'user.email');
    if (curEmail) {
      identity = { ok: true, skipped: true, reason: 'already_configured', email: curEmail };
    } else {
      const name = S.configGet(paths.repoRoot, 'user.name') || S.git(['config', '--get', 'user.name'], { cwd: paths.repoRoot }).stdout || '';
      const email = S.configGet(paths.repoRoot, 'user.email') || S.git(['config', '--get', 'user.email'], { cwd: paths.repoRoot }).stdout || '';
      if (name && email) {
        S.git(['config', '--local', 'user.name', name], { cwd: paths.sharedRoot });
        S.git(['config', '--local', 'user.email', email], { cwd: paths.sharedRoot });
        identity = { ok: true, copied: true, name, email };
      } else {
        identity = { ok: false, degraded: true, reason: 'no identity in game repo', hint: 'git -C ' + paths.sharedRoot + ' config user.name/email' };
      }
    }
  }
  push('git_identity', identity.ok, identity);

  const hooks = dryRun
    ? { ok: false, planned: true }
    : (() => { const cur = S.configGet(paths.repoRoot, 'core.hooksPath'); if (cur === '.githooks') return { ok: true, already: true }; const r = S.git(['config', '--local', 'core.hooksPath', '.githooks'], { cwd: paths.repoRoot }); return { ok: r.code === 0, stderr: r.stderr || null }; })();
  push('hooks_path', hooks.ok, { hooks_path: '.githooks', already: hooks.already || false, planned: hooks.planned || false });

  if (!state.ok) {
    push('mirror_materialize', false, { degraded: true, reason: 'shared repo not ready (read-only degrade)' });
    push('verify', false, { degraded: true, reason: 'shared repo not ready' });
  } else {
    const mat = materialize(paths, { dryRun, force, lfs: 'none' });
    push('mirror_materialize', mat.ok, { code: mat.code, changed: mat.changed || 0, kept_seeded: mat.kept_seeded || 0, deleted: mat.deleted || 0, verify: mat.verify || mat.plan || null, hint: mat.hint || null });
    if (dryRun) {
      push('verify', true, { skipped: true, reason: 'dry_run' });
    } else {
      const treeCount = sharedTreeNames(paths).length;
      const mirrorCount = mirrorFiles(paths).length;
      const link = S.isLinkOrJunction(paths.mirrorRoot);
      const textPointers = mirrorFiles(paths).filter((rel) => S.isTextLikePath(rel) && S.isLfsPointerFile(path.join(paths.mirrorRoot, rel))).length;
      const ok = mirrorCount === treeCount && !link.isLink && textPointers === 0;
      push('verify', ok, { mirror_count: mirrorCount, shared_tree_count: treeCount, is_link: link.isLink, text_pointers: textPointers });
    }
  }

  const hardFailures = steps.filter((s) => !s.ok && !s.degraded);
  const degraded = steps.filter((s) => s.degraded);
  return { steps, ok: hardFailures.length === 0, degraded: degraded.map((s) => s.step), exit_code: hardFailures.length ? 1 : 0, dry_run: dryRun };
}

export function run({ paths, config, args, json }) {
  const result = bootstrap({ paths, config, dryRun: !!args['dry-run'], update: !!args.update, force: !!args.force });
  return { exitCode: result.exit_code, report: { command: 'bootstrap', ...result } };
}