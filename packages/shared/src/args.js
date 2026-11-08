/**
 * 极简参数解析（零依赖）：支持 --flag / --key value / --key=value / 之后原样保留。
 * spec = { boolean: [...], value: [...] }；未知参数进 _unknown（由调用方报错，禁止静默吞掉）。
 */
export function parseArgs(argv, spec = {}) {
  const booleans = new Set(spec.boolean || []);
  const values = new Set(spec.value || []);
  const out = { _: [], _unknown: [], _rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) {
        if (!values.has(key)) { out._unknown.push(a); continue; }
        out[key] = a.slice(eq + 1);
        continue;
      }
      if (booleans.has(key)) { out[key] = true; continue; }
      if (values.has(key)) {
        const v = argv[++i];
        if (v === undefined) { out._unknown.push(a); continue; }
        out[key] = v;
        continue;
      }
      out._unknown.push(a);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && a !== '-') { out._unknown.push(a); continue; }
    out._.push(a);
  }
  return out;
}

export function usageError(message, usage) {
  const err = new Error(message + (usage ? '\n' + usage : ''));
  err.code = 'usage';
  return err;
}
