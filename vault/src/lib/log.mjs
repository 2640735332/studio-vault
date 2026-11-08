const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = "info", name = "vault", sink = (line) => process.stdout.write(line + "\n") } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  function emit(lvl, msg, fields = {}) {
    if ((LEVELS[lvl] ?? 20) < threshold) return;
    const record = { ts: new Date().toISOString(), level: lvl, service: name, msg, ...fields };
    sink(JSON.stringify(record));
  }
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (childName) => createLogger({ level, name: `${name}.${childName}`, sink }),
  };
}
