export const name = 'watch';
export const summary = '监视镜像改动并自动回写共享仓（watcher 与 pre-commit 双保险）';
export const usage = 'studio watch [--interval <ms>] [--debounce <ms>] [--once] [--no-push] [--json]';
export { watchModal as run };

import { watch as watchImpl } from '../watch.js';

async function watchModal({ paths, args, json }) {
  const intervalMs = args.interval ? Number(args.interval) : 1000;
  const debounceMs = args.debounce ? Number(args.debounce) : 800;
  const once = !!args.once;
  const push = !args['no-push'];
  const events = [];
  const result = await watchImpl(paths, {
    intervalMs,
    debounceMs,
    once,
    push,
    onEvent: (evt) => {
      events.push(evt);
      if (!json) console.log('[watch] ' + JSON.stringify(evt));
    },
  });
  return { exitCode: result && result.ok === false ? 1 : 0, report: { command: 'watch', result, events } };
}
