import fs from 'node:fs';
// @studio/shared —— Studio 共享零依赖原语
// 纯 Node 标准库：不引入任何 npm 依赖，保证「clone 即可运行」的零命令落点。
export * from './json.js';
export * from './git.js';
export * from './lfs.js';
export * from './tree.js';
export * from './levels.js';
export * from './args.js';
export * from './errors.js';

export const SHARED_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
