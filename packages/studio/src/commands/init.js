import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShared } from '../deps.js';

const S = await loadShared();

export const name = 'init';
export const summary = '初始化当前目录：生成 studio.config.json + specs/docs/briefs/game 骨架（--demo 附带演示简报/Bug/数据）';
export const usage = 'studio init [--demo] [--force] [--cwd <dir>] [--json]';
// init 不依赖既有 studio.config.json；index.js 会据此在 loadConfig 之前分派（新目录里还没有 config）。
export const needsConfig = false;

export const CONFIG_FILE = 'studio.config.json';
export const SKELETON_DIRS = ['specs', 'docs/briefs', 'game/reports/bugs', 'game/src/data'];
export const DEMO_BRIEF_SUFFIX = '-demo-brief';

const DEFAULT_VAULT_URL = 'http://127.0.0.1:3460';
const DEFAULT_STUDIO_PORT = 3456;
const DEFAULT_WORKTREE_PORT_BASE = 3457;
const TEMPLATE_DIR = fileURLToPath(new URL('../../templates/workspace/demo/', import.meta.url));

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区 YYYY-MM-DD（简报目录命名用；不用 UTC，避免跨时区出现「昨天」目录）。 */
export function localDate(d = new Date()) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** studio.config.json 内容（字段须满足 packages/shared/schema/studio.config.schema.json）。 */
export function buildConfig(projectId) {
  return {
    version: 1,
    project: { id: projectId, name: projectId, gameRepo: '.' },
    shared: { repo: projectId + '-shared', branch: 'main', mirror: 'docs/briefs', lfs: 'text' },
    vault: { url: DEFAULT_VAULT_URL, project: projectId },
    studio: { port: DEFAULT_STUDIO_PORT, worktreePortBase: DEFAULT_WORKTREE_PORT_BASE },
    kb: { namespace: projectId },
  };
}

/**
 * 找已存在的演示简报目录。跨天重跑 init --demo 时沿用旧日期，
 * 保证「同一命令重复执行不新增文件」（幂等）。
 */
export function findExistingDemoBrief(root) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, 'docs', 'briefs'), { withFileTypes: true });
  } catch {
    return null;
  }
  const hits = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-demo-brief$/.test(e.name))
    .map((e) => e.name)
    .sort();
  return hits.length ? hits[hits.length - 1] : null;
}

function readTemplate(file) {
  const abs = path.join(TEMPLATE_DIR, file);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    const e = new Error('演示模板缺失: ' + abs + '（包内 templates/workspace/demo/ 不完整）: ' + String((err && err.message) || err));
    e.code = 'demo_template_missing';
    throw e;
  }
}

export function templateVars({ projectId, date, now }) {
  return {
    PROJECT_ID: projectId,
    PROJECT_NAME: projectId,
    DATE: date,
    NOW: now,
    BUG_ID: '9001',
    NODE_VERSION: process.version,
  };
}

/** 占位符替换；残留 {{...}} 直接抛错（防止模板拼错后被悄悄写进目标仓）。 */
export function fillTemplate(text, vars) {
  const out = String(text).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => (vars[key] !== undefined ? String(vars[key]) : m));
  const left = /\{\{[A-Z0-9_]+\}\}/.exec(out);
  if (left) {
    const e = new Error('演示模板占位符未替换: ' + left[0]);
    e.code = 'template_placeholder_unfilled';
    throw e;
  }
  return out;
}

/** --demo 要写的文件清单（相对路径 + 模板名）。 */
export function demoPlan({ projectId, date, now }) {
  const vars = templateVars({ projectId, date, now });
  const briefDir = 'docs/briefs/' + date + DEMO_BRIEF_SUFFIX;
  const bugDir = 'game/reports/bugs/bug-' + date.replace(/-/g, '') + '-000000-' + vars.BUG_ID;
  return [
    { rel: briefDir + '/BRIEF.md', template: 'BRIEF.md', vars },
    { rel: bugDir + '/Readme.md', template: 'bug-Readme.md', vars },
    { rel: 'game/src/data/buildings.json', template: 'buildings.json', vars },
  ];
}

/**
 * 纯函数式脚手架（不 println，便于 node --test / 复用）：
 * 建骨架目录 -> 写 studio.config.json（已存在且非 --force 时不覆盖）-> 可选写入演示文件。
 */
export function initWorkspace({ cwd = process.cwd(), demo = false, force = false } = {}) {
  const root = path.resolve(cwd);
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    return {
      ok: false,
      code: 'invalid_cwd',
      exit_code: 2,
      message: '目标目录不存在或不是目录: ' + root,
      hint: '先创建目录，或用 --cwd 指定已有目录',
    };
  }

  const projectId = path.basename(root) || 'studio-project';
  const report = {
    ok: true,
    cwd: root,
    project: { id: projectId, name: projectId },
    demo: !!demo,
    force: !!force,
    config: { path: path.join(root, CONFIG_FILE), rel: CONFIG_FILE, status: null },
    dirs: { created: [], kept: [] },
    files: { created: [], kept: [], updated: [] },
    warnings: [],
    next: ['studio doctor', 'studio bootstrap', 'studio serve'],
  };

  // loadConfig 以 git 仓根为 repoRoot 优先；init 写在子目录会让后续命令「找不到配置」。
  // 不硬失败（非 git 的临时目录/裸目录都合法），但给明确 warning 指明该在仓根执行。
  try {
    const top = S.gitTopLevel(root);
    if (top && path.resolve(top) !== root) {
      report.warnings.push('当前目录位于 git 仓库 ' + path.resolve(top) + ' 内，但 ' + CONFIG_FILE + ' 写在了子目录；loadConfig 以 git 仓根为准，建议在仓根重跑 studio init（或 --cwd <仓根>）');
    }
  } catch { /* git 不可用不阻塞 init */ }

  for (const rel of SKELETON_DIRS) {
    const abs = path.join(root, rel);
    let isDir = false;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      report.dirs.kept.push(rel + '/');
      continue;
    }
    if (fs.existsSync(abs)) {
      return {
        ok: false,
        code: 'path_conflict',
        exit_code: 2,
        message: '需要创建目录，但目标位置已存在同名文件: ' + abs,
        hint: '移走该文件后重试',
      };
    }
    fs.mkdirSync(abs, { recursive: true });
    report.dirs.created.push(rel + '/');
  }

  const configPath = path.join(root, CONFIG_FILE);
  const configExisted = fs.existsSync(configPath);
  if (configExisted && !force) {
    report.config.status = 'kept';
    try {
      S.readJson(configPath);
    } catch (err) {
      report.warnings.push('现有 ' + CONFIG_FILE + ' 不是合法 JSON（' + String((err && err.message) || err) + '）；确认后用 --force 覆盖');
    }
  } else {
    S.writeJsonAtomic(configPath, buildConfig(projectId));
    report.config.status = configExisted ? 'overwritten' : 'created';
  }

  if (demo) {
    const existing = findExistingDemoBrief(root);
    const date = existing ? existing.slice(0, 10) : localDate();
    const now = S.nowIso();
    for (const item of demoPlan({ projectId, date, now })) {
      const abs = path.join(root, ...item.rel.split('/'));
      const existed = fs.existsSync(abs);
      if (existed && !force) {
        report.files.kept.push(item.rel);
        continue;
      }
      // 只有真要落盘时才读模板/做替换，避免「已有文件 + 模板缺失」这类无关报错。
      S.writeTextAtomic(abs, fillTemplate(readTemplate(item.template), item.vars));
      (existed ? report.files.updated : report.files.created).push(item.rel);
    }
  }

  return report;
}

function formatInitText(report) {
  const out = [];
  out.push('[studio] init ok · project=' + report.project.id + ' · ' + report.cwd);
  const cfg = report.config;
  out.push('[studio] config: ' + cfg.status + ' ' + cfg.rel + (cfg.status === 'kept' ? '（已存在，--force 覆盖）' : ''));
  out.push('[studio] dirs: created ' + report.dirs.created.length + ' / kept ' + report.dirs.kept.length +
    (report.dirs.created.length ? ' · ' + report.dirs.created.join(' ') : ''));
  if (report.demo) {
    const f = report.files;
    out.push('[studio] demo: created ' + f.created.length + ' / kept ' + f.kept.length + (f.updated.length ? ' / overwritten ' + f.updated.length : ''));
    for (const rel of f.created) out.push('  + ' + rel);
    for (const rel of f.updated) out.push('  ~ ' + rel);
    for (const rel of f.kept) out.push('  = ' + rel);
  } else {
    out.push('[studio] tip: 加 --demo 可生成演示简报 / Bug 上报 / 建筑数据样例');
  }
  for (const w of report.warnings) out.push('[studio] warning: ' + w);
  out.push('[studio] next:');
  out.push('  git add -A && git commit -m "studio workspace"  首次提交（Pulse 的提交/活跃统计依赖 Git 历史）');
  out.push('  studio doctor     分级体检（Vault 未启动 = degraded，不是失败）');
  out.push('  studio bootstrap  可选：配好 shared.remote 后克隆团队共享仓');
  out.push('  studio serve      启动本地 Viewer（默认端口 ' + DEFAULT_STUDIO_PORT + '）');
  return out.join('\n');
}

export function run({ args = {} } = {}) {
  const cwd = args.cwd ? String(args.cwd) : process.cwd();
  let report;
  try {
    report = { command: 'init', ...initWorkspace({ cwd, demo: !!args.demo, force: !!args.force }) };
  } catch (err) {
    report = {
      command: 'init',
      ok: false,
      code: (err && err.code) || 'init_failed',
      message: String((err && err.message) || err),
      error: String((err && err.message) || err),
      hint: (err && err.hint) || '检查目标目录写权限后重试',
    };
  }
  // 失败分支（如 invalid_cwd）把 message 也作为 error 输出，formatReport 才会打印具体原因。
  if (!report.ok && report.message && !report.error) report.error = report.message;
  const exitCode = report.ok ? 0 : (report.exit_code === undefined ? 1 : report.exit_code);
  report.exit_code = exitCode;
  return { exitCode, report, text: report.ok ? formatInitText(report) : null };
}