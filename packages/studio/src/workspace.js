import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShared } from './deps.js';

const S = await loadShared();

export const WORKSPACE_SCHEMA_VERSION = 1;

export function workspacePath(paths) {
  return paths.workspaceFile;
}

export function loadWorkspace(paths) {
  const file = workspacePath(paths);
  const data = S.readJson(file, null);
  if (!data) return { version: WORKSPACE_SCHEMA_VERSION, projects: [], settings: {}, path: file, exists: false };
  if (!Array.isArray(data.projects)) data.projects = [];
  data.exists = true;
  data.path = file;
  return data;
}

export function saveWorkspace(paths, data) {
  const file = workspacePath(paths);
  const clean = { version: WORKSPACE_SCHEMA_VERSION, projects: data.projects || [], settings: data.settings || {} };
  S.writeJsonAtomic(file, clean);
  return { path: file, projects: clean.projects.length };
}

/** 由 studio.config.json 派生本机注册条目（机器相关路径只进 ~/.studio/workspace.json，不入 git）。 */
export function projectEntry(paths, config) {
  return {
    id: paths.projectId,
    name: (config.project && config.project.name) || paths.projectId,
    gameRepo: paths.repoRoot,
    worktrees: [],
    sharedRepo: paths.sharedRoot,
    sharedRemote: (config.shared && config.shared.remote) || null,
    vault: { url: (config.vault && config.vault.url) || null, project: (config.vault && config.vault.project) || paths.projectId },
    studio: { port: (config.studio && config.studio.port) || 3456 },
    kb: { namespace: (config.kb && config.kb.namespace) || paths.projectId },
    credentialRef: 'studio:' + paths.projectId,
  };
}

export function upsertProject(paths, config) {
  const data = loadWorkspace(paths);
  const entry = projectEntry(paths, config);
  const idx = data.projects.findIndex((p) => p.id === entry.id);
  if (idx >= 0) {
    const old = data.projects[idx];
    entry.worktrees = Array.from(new Set([...(old.worktrees || []), ...(entry.worktrees || [])]));
    data.projects[idx] = { ...old, ...entry };
  } else {
    data.projects.push(entry);
  }
  const saved = saveWorkspace(paths, data);
  return { entry, saved };
}

export function listProjects(paths) {
  const data = loadWorkspace(paths);
  return { path: data.path, exists: data.exists, projects: data.projects };
}

/** 导出（不含 token；credentialRef 只是引用名）。 */
export function exportWorkspace(paths, outFile) {
  const data = loadWorkspace(paths);
  const abs = path.resolve(paths.repoRoot, outFile || path.join(paths.studioHome, 'workspace.export.json'));
  S.writeJsonAtomic(abs, { version: WORKSPACE_SCHEMA_VERSION, projects: data.projects, settings: data.settings });
  return { ok: true, path: abs, projects: data.projects.length };
}

export function importWorkspace(paths, fromFile) {
  const src = path.resolve(paths.repoRoot, fromFile);
  const incoming = S.readJson(src, null);
  if (!incoming || !Array.isArray(incoming.projects)) return { ok: false, error: 'invalid_workspace_file', path: src };
  const data = loadWorkspace(paths);
  for (const p of incoming.projects) {
    const idx = data.projects.findIndex((x) => x.id === p.id);
    if (idx >= 0) data.projects[idx] = { ...data.projects[idx], ...p };
    else data.projects.push(p);
  }
  const saved = saveWorkspace(paths, data);
  return { ok: true, imported: incoming.projects.length, ...saved };
}
export const TEMPLATE_REL = 'templates/studio.workspace.template.json';

/** 团队模板路径（随包分发；不含路径/凭据）。 */
export function templatePath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'studio.workspace.template.json');
}

/** 模板校验：禁止明文凭据与绝对路径（模板入共享仓/可分发）。 */
export function validateTemplate(data) {
  const issues = [];
  const walk = (v, at) => {
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (/^(token|secret|password|passwd|apikey|api_key|access_key)$/i.test(k)) issues.push('secret_key: ' + at + '.' + k);
        walk(v[k], at + '.' + k);
      }
      return;
    }
    if (typeof v === 'string') {
      if (/^[A-Za-z]:[\\/]/.test(v)) issues.push('absolute_path: ' + at + ' = ' + v);
      else if (v.startsWith('/') && !v.startsWith('/api')) issues.push('absolute_path: ' + at + ' = ' + v);
    }
  };
  walk(data, '$');
  return { ok: issues.length === 0, issues };
}

export function loadTemplate() {
  const file = templatePath();
  return { file, data: S.readJson(file, null) };
}

/** 导出/校验团队模板（`studio workspace template [--out <f>]`）。 */
export function exportTemplate(paths, outFile) {
  const { file, data } = loadTemplate();
  if (!data) return { ok: false, error: 'template_missing', path: file };
  const v = validateTemplate(data);
  if (!v.ok) return { ok: false, error: 'template_invalid', issues: v.issues, path: file };
  if (outFile) {
    const abs = path.resolve(paths.repoRoot, outFile);
    S.writeJsonAtomic(abs, data);
    return { ok: true, template: file, exported: abs, projects: (data.projects || []).length, validated: true };
  }
  return { ok: true, template: file, data, projects: (data.projects || []).length, validated: true };
}

/** 由模板生成/合并本机注册表（`studio workspace import --template`）：占位符替换，不写凭据。 */
export function importTemplate(paths, fromFile) {
  const file = fromFile ? path.resolve(paths.repoRoot, fromFile) : templatePath();
  const data = S.readJson(file, null);
  if (!data) return { ok: false, error: 'template_missing', path: file };
  const v = validateTemplate(data);
  if (!v.ok) return { ok: false, error: 'template_invalid', issues: v.issues, path: file };
  const subst = (val) => typeof val === 'string'
    ? val.split('<project>').join(paths.projectId).split('<workspaceRoot>').join(paths.workspaceRoot)
    : val;
  const walk = (val) => {
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === 'object') { const o = {}; for (const k of Object.keys(val)) o[k] = walk(val[k]); return o; }
    return subst(val);
  };
  const local = loadWorkspace(paths);
  const imported = [];
  for (const raw of walk(data.projects || [])) {
    const existing = local.projects.find((p) => p.id === raw.id);
    if (existing) { local.projects[local.projects.indexOf(existing)] = { ...existing, ...raw }; imported.push(raw.id + '(merged)'); }
    else { local.projects.push(raw); imported.push(raw.id + '(added)'); }
  }
  const saved = saveWorkspace(paths, local);
  return { ok: true, template: file, imported, ...saved };
}
