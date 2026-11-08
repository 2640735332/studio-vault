import fs from 'node:fs';
import path from 'node:path';
import { loadShared } from '../deps.js';
import { sharedRepoState, sharedTreeNames, mirrorFiles, materialize, compareMirror, journalUnwritten } from '../mirror.js';

const S = await loadShared();

export const name = 'mirror-switch';
export const summary = '切镜像（vm --cached docs/briefs + gitignore + 物化 + 校验）；默认 dry-run，execute 需 --execute';
export const usage = 'studio mirror-switch [--execute] [--force] [--json] [--out <path>]';

const IGNORE_MARK = '# docs/briefs/';

function trackedCount(paths) {
  const r = S.git(['ls-files', '-z', '--', 'docs/briefs'], { cwd: paths.repoRoot });
  if (r.code !== 0) return null;
  return r.stdout.split('\u0000').filter(Boolean).length;
}

function ignoreState(paths) {
  const r = S.git(['check-ignore', '-q', '--', 'docs/briefs'], { cwd: paths.repoRoot });
  return { rc: r.code, ignored: r.code === 0 };
}

export function preflight(paths) {
  const state = sharedRepoState(paths);
  const tracked = trackedCount(paths);
  const ignored = ignoreState(paths);
  const link = S.isLinkOrJunction(paths.mirrorRoot);
  const tree = sharedTreeNames(paths);
  const mirror = mirrorFiles(paths);
  const treeSet = new Set(tree);
  const mirSet = new Set(mirror);
  const missing = tree.filter((rel) => !mirSet.has(rel));
  const extra = mirror.filter((rel) => !treeSet.has(rel));
  const cmp = state.ok && missing.length === 0 && extra.length === 0 ? compareMirror(paths) : null;
  const plan = [
    'git rm -r --cached docs/briefs  (tracked=' + tracked + ' -> 0)',
    'edit .gitignore: enable docs/briefs/ (currently ' + (ignored.ignored ? 'ignored' : 'tracked') + ')',
    'studio sync --execute（由共享仓物化镜像，禁止 junction）',
    'verify: tracked=0 + ignored=true + mirror_count==shared_tree_count',
  ];
  const checks = [
    { id: 'shared_repo_ready', pass: state.ok, detail: state },
    { id: 'p0_state_tracked', pass: tracked !== null && tracked > 0, detail: { tracked } },
    { id: 'mirror_not_link', pass: !link.isLink, detail: link },
    { id: 'mirror_sets_equal', pass: missing.length === 0 && extra.length === 0, detail: { missing: missing.length, extra: extra.length } },
    { id: 'mirror_clean', pass: !!(cmp && cmp.unwritten.length === 0), detail: cmp ? { unwritten: cmp.unwritten } : null },
  ];
  return { checks, ok: checks.every((c) => c.pass), plan, tracked, ignored, state, missing, extra, compare: cmp ? { source_count: cmp.source_count, mirror_count: cmp.mirror_count, seedable: cmp.seedable.length, lfs_missing: cmp.lfs_missing.length, unwritten: cmp.unwritten } : null };
}

function enableGitignore(paths) {
  const file = path.join(paths.repoRoot, '.gitignore');
  let text = fs.readFileSync(file, 'utf8');
  if (/^docs\/briefs\/$/m.test(text)) return { ok: true, changed: false };
  if (!text.includes(IGNORE_MARK)) return { ok: false, error: 'gitignore_marker_missing', marker: IGNORE_MARK };
  text = text.replace(IGNORE_MARK, 'docs/briefs/');
  fs.writeFileSync(file, text, 'utf8');
  return { ok: true, changed: true };
}

export function switchMirror({ paths, execute = false, force = false }) {
  const pre = preflight(paths);
  const report = { command: 'mirror-switch', execute, preflight_ok: pre.ok, checks: pre.checks, plan: pre.plan, tracked: pre.tracked, ignored: pre.ignored, steps: [] };
  // 幂等：已经切过镜像（tracked=0 且被 ignore 且镜像计数==共享仓 tree）⇒ 不再执行切换
  const already = pre.tracked === 0 && pre.ignored.ignored && pre.ok === false && pre.checks.every((c) => c.id === 'p0_state_tracked' ? true : c.pass);
  if (pre.tracked === 0 && pre.ignored.ignored) {
    report.code = 'already_switched';
    report.already_switched = true;
    report.ok = pre.checks.filter((c) => c.id !== 'p0_state_tracked').every((c) => c.pass);
    report.exit_code = report.ok ? 0 : 1;
    report.rollback = ['# 需要回到 tracked 模式：git revert <switch-commit>'];
    return report;
  }
  if (!execute) {
    report.dry_run = true;
    report.ok = pre.ok;
    report.exit_code = pre.ok ? 0 : 1;
    report.rollback = [
      '# 回退（只读双轨）：git revert <switch-commit> 恢复 tracked；共享仓与镜像均可重建',
      'git -C ' + paths.sharedRoot + ' log -1 --format=%H',
    ];
    return report;
  }
  if (!pre.ok) {
    report.ok = false;
    report.exit_code = 1;
    report.error = 'preflight_failed';
    return report;
  }
  const before = { tracked: pre.tracked, head: S.gitHead(paths.repoRoot), shared_head: S.gitHead(paths.sharedRoot), mirror_count: mirrorFiles(paths).length };
  report.before = before;

  if (pre.compare.unwritten.length && !force) {
    report.ok = false;
    report.exit_code = 1;
    report.error = 'mirror_has_unwritten';
    report.hint = '先 node scripts/studio/commit 回写，或 --force 先 journal 再清理';
    return report;
  }
  let journal = null;
  if (pre.compare.unwritten.length && force) journal = journalUnwritten(paths, pre.compare.unwritten, { reason: 'mirror-switch --force' });
  report.journal = journal;

  const gi = enableGitignore(paths);
  report.steps.push({ step: 'gitignore_enable', ...gi });
  if (!gi.ok) { report.ok = false; report.exit_code = 1; report.error = 'gitignore_failed'; return report; }

  const rm = S.git(['rm', '-r', '--cached', '-q', '--', 'docs/briefs'], { cwd: paths.repoRoot, timeout: 300000 });
  report.steps.push({ step: 'git_rm_cached', ok: rm.code === 0, stderr: (rm.stderr || '').slice(0, 500) });
  if (rm.code !== 0) { report.ok = false; report.exit_code = 1; report.error = 'git_rm_cached_failed'; return report; }

  const mat = materialize(paths, { dryRun: false, force: true, lfs: 'none', seed: true });
  report.steps.push({ step: 'materialize', ok: mat.ok, code: mat.code, changed: mat.changed, kept_seeded: mat.kept_seeded, deleted: mat.deleted, verify: mat.verify });

  const afterTracked = trackedCount(paths);
  const afterIgnored = ignoreState(paths);
  const treeCount = sharedTreeNames(paths).length;
  const mirrorCount = mirrorFiles(paths).length;
  const link = S.isLinkOrJunction(paths.mirrorRoot);
  const verify = {
    tracked: afterTracked,
    ignored: afterIgnored.ignored,
    mirror_count: mirrorCount,
    shared_tree_count: treeCount,
    is_link: link.isLink,
    ok: afterTracked === 0 && afterIgnored.ignored && mirrorCount === treeCount && !link.isLink,
  };
  report.after = verify;
  report.ok = mat.ok && verify.ok;
  report.exit_code = report.ok ? 0 : 1;
  report.rollback = [
    '# 回退：git revert <switch-commit>（恢复 docs/briefs tracked）+ 共享仓/镜像可重建（只读双轨）',
    'git checkout HEAD~1 -- docs/briefs  # 仅切换前有效',
  ];
  return report;
}

export function run({ paths, args }) {
  const out = args.out || null;
  const report = switchMirror({ paths, execute: !!args.execute, force: !!args.force });
  report.evidence_path = out ? out.replace(/\\/g, '/') : null;
  if (out) {
    const abs = path.resolve(paths.repoRoot, out);
    S.writeJsonAtomic(abs, sanitizeEvidence(report, paths));
  }
  return { exitCode: report.exit_code, report };
}

/** 证据脱敏：绝对路径换 <gameRepo>/<workspaceRoot>/<sharedRoot> 占位符。 */
function sanitizeEvidence(obj, paths) {
  const pairs = [
    [path.resolve(paths.sharedRoot), '<sharedRoot>'],
    [path.resolve(paths.workspaceRoot), '<workspaceRoot>'],
    [path.resolve(paths.repoRoot), '<gameRepo>'],
  ].sort((a, b) => b[0].length - a[0].length);
  const walk = (v) => {
    if (typeof v === 'string') {
      let s = v;
      for (const [from, to] of pairs) s = s.split(from).join(to).split(from.replace(/\\/g, '/')).join(to);
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return walk(obj);
}
