// 依赖解析：优先使用已安装的 @studio/shared（npm/Gitea registry 形态），
// 缺失时回落到仓库内 vendored 的 packages/shared（零命令落点：clone 后无需 npm install）。
let cached = null;

export async function loadShared() {
  if (cached) return cached;
  try {
    cached = await import('@studio/shared');
  } catch (err) {
    if (!err || (err.code !== 'ERR_MODULE_NOT_FOUND' && err.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED')) throw err;
    cached = await import('../../shared/src/index.js');
  }
  return cached;
}

export function resetSharedForTests() {
  cached = null;
}
