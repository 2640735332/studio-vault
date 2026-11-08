import path from 'node:path';
import { materialize, materializeMissing, compareMirror, sharedRepoState } from '../mirror.js';

export const name = 'sync';
export const summary = '物化/校验 docs/briefs 镜像（禁 junction；未回写内容先 journal 再清理）';
export const usage = 'studio sync [--dry-run] [--force] [--lfs text|none] [--no-seed] [--missing-only] [--json]';

export function run({ paths, args }) {
  const dryRun = !!args['dry-run'];
  const force = !!args.force;
  const lfs = args.lfs || 'text';
  const seed = !args['no-seed'];
  const state = sharedRepoState(paths);
  const result = args['missing-only'] ? materializeMissing(paths, {dryRun}) : materialize(paths, { dryRun, force, lfs, seed });
  return {
    exitCode: result.ok ? 0 : 1,
    report: {
      command: 'sync',
      ok: result.ok,
      code: result.code,
      repo_root: paths.repoRoot,
      shared_root: paths.sharedRoot,
      mirror_root: paths.mirrorRoot,
      shared_repo: state,
      result,
      hint: result.hint || null,
    },
  };
}

export function compare({ paths }) {
  const cmp = compareMirror(paths);
  return {
    source_count: cmp.source_count,
    mirror_count: cmp.mirror_count,
    missing: cmp.missing.length,
    extra: cmp.extra.length,
    differing: cmp.differing.length,
    seedable: cmp.seedable.length,
    lfs_missing: cmp.lfs_missing.length,
    unwritten: cmp.unwritten,
  };
}
