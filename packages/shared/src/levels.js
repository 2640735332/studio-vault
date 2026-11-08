/**
 * doctor 分级（四条硬规则）：
 *   ok       -> exit 0
 *   degraded -> **exit 0**（能力降级但只读可用；只有被 --require 显式点名时才判红）
 *   fail     -> exit 非 0
 */
export const LEVEL = Object.freeze({ ok: 'ok', degraded: 'degraded', fail: 'fail' });
const RANK = { ok: 0, degraded: 1, fail: 2 };

export function worstLevel(levels) {
  let worst = LEVEL.ok;
  for (const l of levels) {
    if (RANK[l] > RANK[worst]) worst = l;
  }
  return worst;
}

/**
 * @param {Array<{name:string, level:string}>} checks
 * @param {string[]} requireList  --require 点名的检查名（degraded 点名 => 判红）
 */
export function evaluateChecks(checks, requireList = []) {
  const req = new Set(requireList.filter(Boolean));
  const failing = [];
  const degradedRequired = [];
  for (const c of checks) {
    if (c.level === LEVEL.fail) { failing.push(c.name); continue; }
    if (c.level === LEVEL.degraded && req.has(c.name)) { degradedRequired.push(c.name); failing.push(c.name); }
  }
  const level = failing.length ? LEVEL.fail : worstLevel(checks.map((c) => c.level));
  return { overall: level, exitCode: failing.length ? 1 : 0, failing, degradedRequired };
}
