import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'serve';
export const summary = '启动 Studio 只读端（包内 src/serve/server.js；游戏仓 root 由 --cwd/config 解析；3456）';
export const usage = 'studio serve [--port <n>] [--bind <addr>] [--allow-lan] [--readonly]';

const SERVE_ENTRY = fileURLToPath(new URL('../serve/server.js', import.meta.url));

export function run({ paths, config, args }) {
  const port = args.port || String((config.studio && config.studio.port) || 3456);
  const entry = SERVE_ENTRY;
  const env = { ...process.env, SPECVIEWER_PORT: port };
  if (args.bind) env.SPECVIEWER_BIND = String(args.bind);
  if (args['allow-lan']) env.SPECVIEWER_ALLOW_LAN = '1';
  if (args.readonly) env.SPECVIEWER_READONLY = '1';
  const child = spawn(process.execPath, [entry], { cwd: paths.repoRoot, env, stdio: 'inherit' });
  const report = { command: 'serve', pid: child.pid, port, entry, root: paths.repoRoot };
  return {
    exitCode: 0,
    report,
    waitFor: new Promise((resolve) => child.on('exit', (code) => resolve({ exitCode: code === null ? 1 : code, report: { ...report, exited: true, child_exit: code } }))),
  };
}
