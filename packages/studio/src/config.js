import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadShared } from './deps.js';

const S = await loadShared();

export const CONFIG_FILE = 'studio.config.json';
export const SHARED_REPO_ENV = 'STUDIO_SHARED_ROOT';
export const WORKSPACE_ENV = 'STUDIO_WORKSPACE';
export const STUDIO_HOME_ENV = 'STUDIO_HOME';

/** 从 start 向上找：① git top-level（优先）② 含 studio.config.json + specs 的目录。 */
export function findRepoRoot(start = process.cwd()) {
  const top = S.gitTopLevel(start);
  if (top) return path.resolve(top.replace(/\n/g, ''));
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE)) && fs.existsSync(path.join(dir, 'specs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function expandVars(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m));
}

/**
 * 载入 studio.config.json + 解析全部路径（机器相关路径由环境变量覆盖，不写死在仓里）。
 * @returns {{ok:boolean, repoRoot:string, config:object, paths:object, warnings:string[], error?:string}}
 */
export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const warnings = [];
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    return { ok: false, error: 'not_a_studio_repo', message: '未找到 studio.config.json（在游戏仓库内运行，或用 --cwd 指定）', warnings };
  }
  const configPath = path.join(repoRoot, CONFIG_FILE);
  let config;
  try {
    config = S.readJson(configPath, null);
  } catch (err) {
    return { ok: false, error: 'config_parse_error', message: '解析 ' + configPath + ' 失败: ' + err.message, warnings };
  }
  if (!config) return { ok: false, error: 'config_missing', message: '缺少 ' + configPath, warnings };

  const studioHome = env[STUDIO_HOME_ENV] || path.join(os.homedir(), '.studio');
  const workspaceRoot = env.STUDIO_WORKSPACE_ROOT || path.dirname(repoRoot);
  const projectId = (config.project && config.project.id) || path.basename(repoRoot);
  const shared = config.shared || {};
  const sharedRepoName = shared.repo || 'shared_' + projectId;
  const rawRoot = env[SHARED_REPO_ENV] || expandVars(shared.root || '', { WORKSPACE_ROOT: workspaceRoot, PROJECT: projectId });
  const sharedRoot = rawRoot && !rawRoot.includes('${') ? path.resolve(rawRoot) : path.join(workspaceRoot, sharedRepoName);
  const mirrorRel = shared.mirror || path.join('docs', 'briefs').replace(/\\/g, '/');
  const mirrorRoot = path.join(repoRoot, mirrorRel);

  const paths = {
    repoRoot,
    configPath,
    studioHome,
    workspaceRoot,
    projectId,
    sharedRepoName,
    sharedRoot,
    sharedBranch: shared.branch || 'main',
    mirrorRel: mirrorRel.replace(/\\/g, '/'),
    mirrorRoot,
    lockFile: path.join(studioHome, 'locks', projectId + '.shared.lock'),
    journalDir: path.join(studioHome, 'journal', projectId),
    cacheDir: path.join(studioHome, 'cache', projectId),
    evidenceLocalDir: path.join(studioHome, 'evidence-local'),
    workspaceFile: env[WORKSPACE_ENV] || path.join(studioHome, 'workspace.json'),
    sharedGitDir: path.join(sharedRoot, '.git'),
  };
  return { ok: true, repoRoot, config, paths, warnings, configPath };
}

export function requireConfig(opts = {}) {
  const loaded = loadConfig(opts);
  if (!loaded.ok) {
    const err = new Error(loaded.message || loaded.error);
    err.code = loaded.error || 'config_error';
    err.hint = '在游戏仓库根目录运行，或先执行 node scripts/studio/bootstrap.cjs';
    throw err;
  }
  return loaded;
}
