import path from 'node:path';
import { loadWorkspace, upsertProject, listProjects, exportWorkspace, importWorkspace, workspacePath, exportTemplate, importTemplate } from '../workspace.js';

export const name = 'workspace';
export const summary = '本机 workspace 注册表（~/.studio/workspace.json，不入 git；token 只存 credentialRef）';
export const usage = 'studio workspace list|register|export [--out f]|import --from f|import --template|template [--out f]|path [--json]';

export function run({ paths, config, args }) {
  const sub = args._[0] || 'list';
  if (sub === 'path') return { exitCode: 0, report: { command: 'workspace path', path: workspacePath(paths) } };
  if (sub === 'list' || sub === 'status') {
    const r = listProjects(paths);
    return { exitCode: 0, report: { command: 'workspace ' + sub, ...r } };
  }
  if (sub === 'register') {
    const r = upsertProject(paths, config);
    return { exitCode: 0, report: { command: 'workspace register', ok: true, ...r } };
  }
  if (sub === 'export') {
    const r = exportWorkspace(paths, args.out || null);
    return { exitCode: r.ok ? 0 : 1, report: { command: 'workspace export', ...r } };
  }
  if (sub === 'template') {
    const r = exportTemplate(paths, args.out || null);
    return { exitCode: r.ok ? 0 : 1, report: { command: 'workspace template', ...r } };
  }
  if (sub === 'import') {
    if (args.template) {
      const r = importTemplate(paths, args.template === true ? null : args.template);
      return { exitCode: r.ok ? 0 : 1, report: { command: 'workspace import --template', ...r } };
    }
    if (!args.from) return { exitCode: 2, report: { command: 'workspace import', ok: false, code: 'missing_from', hint: '--from <file>' } };
    const r = importWorkspace(paths, args.from);
    return { exitCode: r.ok ? 0 : 1, report: { command: 'workspace import', ...r } };
  }
  return { exitCode: 2, report: { command: 'workspace', ok: false, code: 'unknown_subcommand', sub } };
}

export function projectRun({ paths, config, args }) {
  const sub = args._[0] || 'list';
  if (sub === 'list' || sub === 'status') {
    const r = listProjects(paths);
    return { exitCode: 0, report: { command: 'project ' + sub, ...r, current: paths.projectId } };
  }
  if (sub === 'register') {
    const r = upsertProject(paths, config);
    return { exitCode: 0, report: { command: 'project register', ok: true, ...r } };
  }
  return { exitCode: 2, report: { command: 'project', ok: false, code: 'unknown_subcommand', sub, hint: 'project create/remove 尚未实现' } };
}
