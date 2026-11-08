import { writeback, pendingWriteback } from '../writeback.js';

export const name = 'commit';
export const summary = '把镜像改动回写共享仓（写事务锁 + 单写方 commit + push 重试 3 次）';
export const usage = 'studio commit [--dry-run] [--no-push] [--message <m>] [--wait <ms>] [--allow-delete] [--json]';

export function run({ paths, args }) {
  const dryRun = !!args['dry-run'];
  const push = !args['no-push'];
  const message = args.message || undefined;
  const allowDelete = !!args['allow-delete'];
  const waitMs = args.wait ? Number(args.wait) : 0;
  if (!dryRun) {
    const pending = pendingWriteback(paths);
    // 注意：shared_dirty = 上次失败/被中断回写留在共享仓工作树里的改动（必须一并收口，防漏提交）
    if (!pending.pending.length && !(pending.removals || []).length && !(pending.shared_dirty || []).length) {
      return { exitCode: 0, report: { command: 'commit', ok: true, code: 'nothing_to_write_back', pending: [] } };
    }
  }
  const result = writeback(paths, { dryRun, push, message, waitMs, allowDelete });
  return {
    exitCode: result.ok ? 0 : 1,
    report: { command: 'commit', ok: result.ok, code: result.code, shared_root: paths.sharedRoot, result, hint: result.hint || null },
  };
}
