import { kbStatus, kbRebuild, kbSearch } from '../kb.js';

export const name = 'kb';
export const summary = '共享文本 kb 索引（~/.studio/cache/<project>/kb-shared.db）：rebuild / status / search（关键词检索；BGE/RRF 暂未启用）';
export const usage = 'studio kb rebuild|status|search <q> [--dry-run] [--json]';

export function run({ paths, args }) {
  const sub = args._[0] || 'status';
  if (sub === 'rebuild') {
    const r = kbRebuild(paths, { dryRun: !!args['dry-run'] });
    return { exitCode: r.ok ? 0 : 1, report: { command: 'kb rebuild', ...r } };
  }
  if (sub === 'status') {
    return { exitCode: 0, report: { command: 'kb status', ...kbStatus(paths) } };
  }
  if (sub === 'search') {
    const r = kbSearch(paths, args._[1] || '', 10);
    return { exitCode: r.ok ? 0 : 1, report: { command: 'kb search', ...r } };
  }
  return { exitCode: 2, report: { command: 'kb', ok: false, code: 'unknown_subcommand', sub } };
}
