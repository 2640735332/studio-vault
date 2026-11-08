import fs from 'node:fs';
import path from 'node:path';
import { importLocal, checkChain, pendingFiles, resolveUserDir, triggerSync } from '../bug-import.js';

export const name = 'bug';
export const summary = '上报链路：pending/status（降级队列可见）、import-local（补录 Vault）、check（链路自检）';
export const usage = 'studio bug pending|status [--user-dir <dir>] [--json] | studio bug import-local [--source <repo>] [--dry-run] [--limit N] [--sync] [--json] | studio bug check [--source <repo>] [--user-dir <dir>] [--json] | studio bug flush [--dry-run]';

function legacyPending(paths) {
  const dir = paths && paths.journalDir ? path.join(paths.journalDir, 'bugs') : '';
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

function resolveSource(args, paths) {
  const raw = args.source || (paths && paths.repoRoot) || process.cwd();
  return path.resolve(String(raw));
}

export async function run({ paths, args, json }) {
  const sub = args._[0] || 'pending';
  const source = resolveSource(args, paths);
  const userDir = args['user-dir'] ? path.resolve(String(args['user-dir'])) : resolveUserDir();
  const vault = args.vault || process.env.VAULT_URL || 'http://127.0.0.1:3460';
  const pending = pendingFiles(userDir);
  const legacy = legacyPending(paths);
  const pendingReport = { command: 'bug pending', ok: true, user_dir: userDir, count: pending.length, pending, legacy_count: legacy.length, legacy_pending: legacy.slice(0, 20), hint: pending.length ? '游戏内 worker 会自动重试补传；也可启动游戏触发；状态=已入本地降级队列' : '无 pending' };
  if (sub === 'pending' || sub === 'status') return { exitCode: 0, report: pendingReport };
  if (sub === 'import-local') {
    const r = await importLocal({ source, vault, dryRun: !!args['dry-run'], limit: Number(args.limit || 0) });
    // 失败时 importLocal 可能只返回 {ok:false, code, hint} 而没有 report —— 这里补一个可读报告，
    // 否则人类输出会退化成 "[studio] studio ok=n/a"，排查时需要额外加 --json。
    const report = r.report
      ? { ...r.report, sync: null }
      : { command: 'bug import-local', ok: false, code: r.code || 'import_failed', hint: r.hint || null, token_file: r.token_file || null, detail: r.detail || null, sync: null };
    if (r.ok && args.sync && !args['dry-run']) report.sync = triggerSync(userDir);
    return { exitCode: r.ok ? 0 : 1, report };
  }
  if (sub === 'check') {
    const r = await checkChain({ source, userDir, vault });
    return { exitCode: r.ok ? 0 : 1, report: r.report };
  }
  if (sub === 'flush') {
    if (args['dry-run']) return { exitCode: 0, report: { command: 'bug flush', ok: true, dry_run: true, pending, count: pending.length, hint: '真实补传由游戏内 worker 自动重试；CLI 不直接消费队列' } };
    return {
      exitCode: pending.length ? 2 : 0,
      report: {
        command: 'bug flush', ok: pending.length === 0, pending: pending.length,
        hint: pending.length ? 'pending 非空：由游戏内 worker 自动重试（或运行 studio bug check 查看链路）；CLI 不直接改写游戏队列' : '无 pending',
      },
    };
  }
  return { exitCode: 2, report: { command: 'bug', ok: false, code: 'unknown_subcommand', sub, hint: '支持 pending/status/import-local/check/flush' } };
}