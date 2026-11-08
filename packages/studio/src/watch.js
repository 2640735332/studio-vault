import path from 'node:path';
import { loadShared } from './deps.js';
import { compareMirror } from './mirror.js';
import { writeback } from './writeback.js';

const S = await loadShared();

function snapshot(paths) {
  const cmp = compareMirror(paths);
  return cmp.unwritten;
}

/**
 * 镜像 watcher：轮询检测未回写改动 -> 去抖 -> 写事务锁内回写（watcher + pre-commit 双保险）。
 * @param {object} opts {intervalMs=1000, debounceMs=800, once=false, push=true, onEvent}
 */
export async function watch(paths, opts = {}) {
  const { intervalMs = 1000, debounceMs = 800, once = false, push = true, onEvent = null } = opts;
  const emit = (evt) => { if (onEvent) onEvent(evt); };
  let last = new Set(snapshot(paths));
  emit({ event: 'start', mirror: paths.mirrorRoot, interval_ms: intervalMs, once });
  let pendingSince = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const now = new Set(snapshot(paths));
    const changed = now.size !== last.size || [...now].some((x) => !last.has(x));
    if (changed) {
      pendingSince = Date.now();
      emit({ event: 'pending', files: [...now] });
      last = now;
      continue;
    }
    if (pendingSince && Date.now() - pendingSince >= debounceMs) {
      pendingSince = 0;
      const result = writeback(paths, { push, owner: 'studio:watch:' + process.pid });
      emit({ event: 'writeback', result });
      last = new Set(snapshot(paths));
      if (once) return result;
    }
    if (once && !pendingSince) {
      const leftover = snapshot(paths);
      if (!leftover.length) return { ok: true, code: 'idle', files: [] };
    }
  }
}
