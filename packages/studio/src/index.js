import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { loadShared } from './deps.js';
import * as cmdInit from './commands/init.js';
import * as cmdSync from './commands/sync.js';
import * as cmdCommit from './commands/commit.js';
import * as cmdWatch from './commands/watch.js';
import * as cmdStatus from './commands/status.js';
import * as cmdDoctor from './commands/doctor.js';
import * as cmdBootstrap from './commands/bootstrap.js';
import * as cmdMirrorSwitch from './commands/mirror-switch.js';
import * as cmdWorkspace from './commands/workspace.js';
import * as cmdProject from './commands/project.js';
import * as cmdServe from './commands/serve.js';
import * as cmdBug from './commands/bug.js';
import * as cmdKb from './commands/kb.js';
import * as cmdVaultSync from './commands/vault-sync.js';
import * as cmdPerf from './commands/perf.js';
import * as cmdArchive from './commands/archive.js';

const S = await loadShared();

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const COMMANDS = {
  init: cmdInit,
  sync: cmdSync,
  commit: cmdCommit,
  watch: cmdWatch,
  status: cmdStatus,
  doctor: cmdDoctor,
  bootstrap: cmdBootstrap,
  'mirror-switch': cmdMirrorSwitch,
  workspace: cmdWorkspace,
  project: cmdProject,
  serve: cmdServe,
  bug: cmdBug,
  kb: cmdKb,
  perf: cmdPerf,
  archive: cmdArchive,
};

const GLOBAL_BOOLEAN = ['json', 'help', 'version', 'quiet', 'execute', 'dry-run', 'force', 'assets', 'allow-lan', 'once', 'update', 'no-push', 'no-seed', 'no-lock', 'allow-delete', 'template', 'write-manifest', 'demo', 'readonly', 'sync', 'missing-only'];
const GLOBAL_VALUE = ['cwd', 'out', 'require', 'lfs', 'message', 'wait', 'port', 'bind', 'interval', 'debounce', 'from', 'vault', 'root', 'source', 'limit', 'user-dir', 'meta', 'id', 'base', 'offset', 'query', 'file'];

export function helpText() {
  const lines = ['studio ' + VERSION + ' —— Studio（工程台）本地端（@studio/local）', '', '用法: studio <command> [flags]', ''];
  for (const [key, mod] of Object.entries(COMMANDS)) {
    lines.push('  ' + key.padEnd(15) + (mod.summary || ''));
    if (mod.usage) lines.push('  ' + ''.padEnd(15) + mod.usage);
  }
  lines.push('', '通用: --json --cwd <dir> --out <path> --help --version');
  return lines.join('\n');
}

export function formatReport(report) {
  const out = [];
  const head = report && report.command ? report.command : 'studio';
  out.push('[studio] ' + head + ' ok=' + (report && report.ok !== undefined ? report.ok : 'n/a') + (report && report.code ? ' code=' + report.code : ''));
  if (report && report.exit_code !== undefined) out.push('[studio] exit_code=' + report.exit_code);
  if (report && report.hint) out.push('[studio] hint: ' + report.hint);
  if (report && report.error) out.push('[studio] error: ' + report.error);
  if (report && report.token_file) out.push('[studio] token file: ' + report.token_file);
  // 多步命令（bootstrap 等）：人类可读输出直接给出失败步骤原因，不必再加 --json。
  if (report && Array.isArray(report.steps)) {
    for (const step of report.steps) {
      if (!step || step.ok !== false) continue;
      const extra = step.reason || step.error || (Array.isArray(step.errors) && step.errors.length ? step.errors[0] : '') || (step.hint ? 'hint: ' + step.hint : '');
      out.push('[studio] step ' + (step.step || '?') + ' failed' + (extra ? ': ' + String(extra).slice(0, 240) : ''));
    }
  }
  if (report && Array.isArray(report.degraded) && report.degraded.length) out.push('[studio] degraded（不是失败）: ' + report.degraded.join(', '));
  // 检查类命令（bug check 等）：给出问题清单摘要。
  if (report && Array.isArray(report.problems)) {
    for (const p of report.problems.slice(0, 8)) {
      const where = p.file ? ' [' + p.file + ']' : '';
      const why = p.hint ? ' — ' + p.hint : '';
      out.push('[studio] problem: ' + (p.code || 'issue') + where + why);
    }
    if (report.problems.length > 8) out.push('[studio] ... ' + (report.problems.length - 8) + ' more problems（--json 查看全部）');
  }
  if (report && report.failed) out.push('[studio] failed=' + report.failed + (report.created !== undefined ? ' created=' + report.created : ''));
  const r = report && report.result ? report.result : null;
  if (r && r.pending) out.push('[studio] pending=' + JSON.stringify(r.pending.slice(0, 20)));
  if (r && r.verify) out.push('[studio] verify=' + JSON.stringify(r.verify));
  if (r && r.plan) out.push('[studio] plan=' + JSON.stringify(r.plan).slice(0, 400));
  return out.join('\n');
}

/**
 * 统一执行 + 输出：json 打 report；否则优先用命令自带的简洁 text，再退回 formatReport。
 * outBase：--out 相对路径的解析基准（init 用目标目录，其余命令用 repoRoot）。
 */
async function runCommand(mod, { paths, config, args, json, env, outBase }) {
  try {
    const result = await mod.run({ paths, config, args, json, env });
    const report = result.report || {};
    if (args.out && !report.evidence_path && !json) {
      try { S.writeJsonAtomic(path.resolve(outBase, args.out), report); } catch { /* ignore */ }
    }
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(result.text || formatReport(report));
    if (result.waitFor) {
      const awaited = await result.waitFor;
      return awaited.exitCode;
    }
    return result.exitCode === undefined ? 0 : result.exitCode;
  } catch (err) {
    const payload = S.toErrorPayload(err);
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.error('[studio] ERROR ' + payload.code + ': ' + payload.message + (payload.hint ? '\n[studio] hint: ' + payload.hint : ''));
    return 1;
  }
}

export async function main(argv = [], env = process.env) {
  const args = S.parseArgs(argv, { boolean: GLOBAL_BOOLEAN, value: GLOBAL_VALUE });
  const json = !!args.json;
  if (args.version) { console.log('studio ' + VERSION); return 0; }
  if (args.help || args._.length === 0) { console.log(helpText()); return args.help || args._.length === 0 ? (args._.length === 0 && !args.help ? 2 : 0) : 2; }
  const cmdName = args._[0];
  const mod = COMMANDS[cmdName];
  if (!mod) {
    console.error('[studio] 未知命令: ' + cmdName + '\n' + helpText());
    return 2;
  }
  if (args._unknown && args._unknown.length) {
    console.error('[studio] 未知参数: ' + args._unknown.join(' ') + '\n' + (mod.usage || ''));
    return 2;
  }
  const cwd = args.cwd ? String(args.cwd) : process.cwd();
  args._ = args._.slice(1);
  // init 必须在 loadConfig 之前分派：目标目录里还没有 studio.config.json，
  // 走正常路径会先报 not_a_studio_repo。init 自己定位目标目录（--cwd / process.cwd()）。
  if (cmdName === 'init' || mod.needsConfig === false) {
    return runCommand(mod, { paths: null, config: null, args, json, env, outBase: path.resolve(cwd) });
  }
  let loaded;
  try {
    loaded = loadConfig({ cwd, env });
  } catch (err) {
    console.error('[studio] ' + String((err && err.message) || err));
    return 2;
  }
  if (!loaded.ok) {
    console.error('[studio] ' + loaded.message);
    if (loaded.error) console.error('[studio] code=' + loaded.error);
    return 2;
  }
  return runCommand(mod, { paths: loaded.paths, config: loaded.config, args, json, env, outBase: loaded.paths.repoRoot });
}
