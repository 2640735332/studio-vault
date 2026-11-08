import fs from 'node:fs';
import { loadShared } from '../deps.js';
import { sharedRepoState, compareMirror, listJournal } from '../mirror.js';

const S = await loadShared();

export const name = 'status';
export const summary = '一次性只读状态：配置路径 / 共享仓 / 镜像比对 / 未回写 / journal / hooksPath';
export const usage = 'studio status [--json]';

export function run({ paths, config, args }) {
  const state = sharedRepoState(paths);
  const cmp = state.ok ? compareMirror(paths) : null;
  const hooksPath = S.configGet(paths.repoRoot, 'core.hooksPath');
  const report = {
    command: 'status',
    ok: !!(state.ok && cmp && cmp.unwritten.length === 0),
    project: paths.projectId,
    repo_root: paths.repoRoot,
    mirror_root: paths.mirrorRoot,
    shared_root: paths.sharedRoot,
    shared: state,
    mirror: cmp ? {
      source_count: cmp.source_count,
      mirror_count: cmp.mirror_count,
      missing: cmp.missing.length,
      extra: cmp.extra.length,
      differing: cmp.differing.length,
      seedable: cmp.seedable.length,
      lfs_missing: cmp.lfs_missing.length,
      unwritten: cmp.unwritten.length,
    } : null,
    journal: listJournal(paths).length,
    hooks_path: hooksPath,
    studio_home: paths.studioHome,
    vault: config && config.vault ? { url: config.vault.url, project: config.vault.project } : null,
    studio_config: { port: config && config.studio ? config.studio.port : null },
  };
  return { exitCode: report.ok ? 0 : 1, report };
}
