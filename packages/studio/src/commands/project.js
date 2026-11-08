export const name = 'project';
export const summary = '本机 project 注册与识别（cwd -> git top-level -> project）';
export const usage = 'studio project list|status|register [--json]';
export { projectRun as run } from './workspace.js';
