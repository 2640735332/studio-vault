import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'vault-sync';
export const summary = 'Vault 数据同步：读 /api/v1/bugs+links+reports 写游戏仓 Readme 快照（描述/证据/日志/时间线 + 状态码→中文 CANONICAL）';
export const usage = 'studio vault-sync [--vault <url>] [--root <gameRepo>]  (env: VAULT_TOKEN_FILE / VAULT_OBJECTS_DIR / VAULT_SYNC_MAX_ATTACHMENT_MB)';

const ENTRY = fileURLToPath(new URL('../serve/vault-sync.js', import.meta.url));

export function run({ paths, config, args }) {
  const root = args.root ? String(args.root) : paths.repoRoot;
  const vault = args.vault ? String(args.vault) : (process.env.VAULT_URL || (config.vault && config.vault.url) || 'http://127.0.0.1:3460');
  const env = { ...process.env, STUDIO_ROOT: root, VAULT_URL: vault };
  const child = spawn(process.execPath, [ENTRY], { cwd: root, env, stdio: 'inherit' });
  const report = { command: 'vault-sync', pid: child.pid, root, vault };
  return {
    exitCode: 0,
    report,
    waitFor: new Promise((resolve) => child.on('exit', (code) => resolve({ exitCode: code === null ? 1 : code, report: { ...report, exited: true, child_exit: code } }))),
  };
}
