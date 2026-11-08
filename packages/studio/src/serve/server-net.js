// spec-server 「监听面 / 调用方来源」策略（t-0915-305 硬化，2026-09-18）
//
// 两条独立的安全线；**不改变写门语义**（写操作仍要求来自回环 + 前端写模式）：
//   A. 监听面：默认只绑回环 127.0.0.1。要开局域网必须显式 opt-in，且启动打印醒目警告：
//        · SPECVIEWER_BIND=<host>    （如 0.0.0.0 或本机 LAN IP）
//        · SPECVIEWER_ALLOW_LAN=1    （等价 SPECVIEWER_BIND=0.0.0.0）
//   B. 写路由来源：所有非 GET/HEAD 请求必须来自回环地址，否则 403 not_local。
//        只读浏览（GET）不受影响 ⇒ 局域网可看，但改不了东西。
//
// 背景：spec-server 原先用 `server.listen(PORT)`（Node 默认绑 0.0.0.0），且写路由只认服务端
// env、不认来源；打开写门后同一局域网内任何机器都能 POST 触发状态流转。本模块收口这两点。
export const DEFAULT_BIND_HOST = '127.0.0.1';
export const LAN_BIND_HOST = '0.0.0.0';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 监听主机是否是回环（主机名/字面量层面）。 */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host == null ? '' : host).trim().toLowerCase());
}

/** 请求来源地址是否是回环（含 IPv4-mapped 127.0.0.0/8）。 */
export function isLoopbackAddress(address) {
  const raw = String(address == null ? '' : address).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (raw === '') return false;
  if (LOOPBACK_ADDRS.has(raw)) return true;
  if (raw.startsWith('::ffff:127.')) return true;
  return false;
}

/**
 * 解析监听地址。默认回环；只有显式 opt-in 才会绑非回环。
 * @returns {{ host: string, source: 'default'|'SPECVIEWER_BIND'|'SPECVIEWER_ALLOW_LAN', allowLan: boolean }}
 */
export function resolveBind(env = process.env) {
  const explicit = String((env && env.SPECVIEWER_BIND) || '').trim();
  if (explicit !== '') return { host: explicit, source: 'SPECVIEWER_BIND', allowLan: !isLoopbackHost(explicit) };
  const allowLan = String((env && env.SPECVIEWER_ALLOW_LAN) || '').trim() === '1';
  if (allowLan) return { host: LAN_BIND_HOST, source: 'SPECVIEWER_ALLOW_LAN', allowLan: true };
  return { host: DEFAULT_BIND_HOST, source: 'default', allowLan: false };
}

/** 写方法判定：只读 = GET/HEAD；其它（POST/PATCH/PUT/DELETE…）都算写 ⇒ 要回环来源。 */
export function isWriteMethod(method) {
  const m = String(method == null ? '' : method).toUpperCase();
  return !(m === 'GET' || m === 'HEAD');
}

/**
 * 启动前「单实例清扫」的定位命令：**只定位本实例将要监听的那个端口**。
 * 事故（2026-09-18 t-0915-305）：旧实现写死 `:${PORT}`（3456），于是任何以 SPECVIEWER_PORT
 * 起在随机端口的实例（例如集成测试）都会顺手杀掉 3456 上的真实例。传入 effective port 后，
 * 清扫范围与监听范围严格一致。
 */
export function portSweepCommand(port, platform = process.platform) {
  return platform === 'win32' ? `netstat -ano | findstr ":${port}"` : `lsof -ti tcp:${port}`;
}

/**
 * 从 netstat 输出里挑出「真正占用该端口的 LISTENING 行」的 pid。
 * 事故（2026-09-18 t-0915-305）：旧实现拿 findstr 命中的每一行取最后一列就 kill ⇒
 * SYN_SENT/ESTABLISHED 行也会命中（那些行的最后一列是**客户端**进程），于是「起服务」
 * 会顺手杀掉正在连过来的客户端（实测把集成测试进程杀了）。这里只认 LISTENING 行，
 * 且排除自身与父进程（绝不自杀/弑父）。
 */
export function pickListenerPids(netstatOutput, options = {}) {
  const selfPid = Number(options.selfPid != null ? options.selfPid : process.pid);
  const parentPid = Number(options.parentPid != null ? options.parentPid : process.ppid);
  const pids = [];
  for (const line of String(netstatOutput == null ? '' : netstatOutput).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    if (!parts.includes('LISTENING')) continue;
    const last = parts[parts.length - 1];
    if (!/^\d+$/.test(last) || last === '0') continue;
    const pid = Number(last);
    if (pid === selfPid || pid === parentPid) continue;
    pids.push(pid);
  }
  return pids;
}
/** 非回环监听时的醒目警告（启动打印；测试断言其内容）。 */
export function bindWarningLines(host, port) {
  return [
    `  ⚠ 监听 ${host}:${port} —— 非回环（局域网/其它主机可达）`,
    '  ⚠ 只读浏览：局域网可访问；写路由（POST /api/specviewer/transition、PATCH /api/bugs|data/…）只接受回环来源，非回环一律 403 not_local',
    '  ⚠ 写门（状态流转）默认可用，只受「回源必须回环 + 前端写模式」约束',
  ];
}

/** 回环监听时的说明行（告诉用户「怎么开 LAN」）。 */
export function bindLoopbackLine(host, port) {
  return `  🔒 监听 ${host}:${port}（仅本机）；需局域网访问请显式设置 SPECVIEWER_BIND=0.0.0.0 或 SPECVIEWER_ALLOW_LAN=1`;
}
