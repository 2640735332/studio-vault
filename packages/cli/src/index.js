import fs from 'node:fs';
// @studio/cli —— 命令行入口层：解析与分发委托 @studio/local（零依赖）。
// 已安装时用 node_modules 版本；未安装（clone 后未 npm install）回落仓库内 vendored 副本。
let cached = null;

export async function loadStudio() {
  if (cached) return cached;
  try {
    cached = await import('@studio/local');
  } catch (err) {
    if (!err || (err.code !== 'ERR_MODULE_NOT_FOUND' && err.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED')) throw err;
    cached = await import('../../studio/src/index.js');
  }
  return cached;
}

export async function main(argv = process.argv.slice(2)) {
  const studio = await loadStudio();
  return studio.main(argv);
}

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
