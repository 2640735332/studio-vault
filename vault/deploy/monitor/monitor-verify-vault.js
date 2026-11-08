"use strict";

/**
 * Verifies the Vault monitor in an existing Uptime Kuma deployment (socket.io API, same as UI).
 *
 *   NODE_PATH=<monitor-install>/node_modules node vault/deploy/monitor/monitor-verify-vault.js
 *
 * Environment: KUMA_URL, KUMA_ADMIN_FILE, KUMA_DATA_DIR, KUMA_MONITOR_NAME, VAULT_URL,
 * KUMA_STATUS_PAGE (see monitor-add-vault.js for defaults).
 *
 * Prints one line "KUMA_VAULT {json}" with monitor id/name/url, active flag and the latest
 * heartbeat status (1=up, 0=down, 2=pending, 3=maintenance). Exit 0 = monitor found and up.
 * Uptime Kuma stores its data in redbean (not sqlite3), so the DB is not read directly.
 */

const fs = require("fs");
const path = require("path");
const { io } = require("socket.io-client");

const KUMA_URL = process.env.KUMA_URL || "http://127.0.0.1:3001";
const VAULT_URL = process.env.VAULT_URL || "http://127.0.0.1:3460";
const MONITOR_NAME = process.env.KUMA_MONITOR_NAME || "Vault (" + VAULT_URL.replace(/^https?:\/\//, "") + ")";
const KUMA_DATA_DIR = process.env.KUMA_DATA_DIR || process.cwd();
const ADMIN_FILE = process.env.KUMA_ADMIN_FILE || path.join(KUMA_DATA_DIR, "monitor-admin.json");
const STATUS_PAGE_SLUG = process.env.KUMA_STATUS_PAGE || "home";

function emitAck(event) {
  const args = Array.prototype.slice.call(arguments, 1);
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error("timeout waiting for " + event)); }, 20000);
    const cb = function (res) { clearTimeout(timer); resolve(res); };
    socket.emit.apply(socket, [event].concat(args, [cb]));
  });
}

function waitConnect() {
  return new Promise(function (resolve, reject) {
    if (socket.connected) { return resolve(); }
    const timer = setTimeout(function () { reject(new Error("connect timeout")); }, 15000);
    socket.once("connect", function () { clearTimeout(timer); resolve(); });
    socket.once("connect_error", function (err) { clearTimeout(timer); reject(err); });
  });
}

function getMonitorList() {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error("timeout waiting for monitorList")); }, 15000);
    socket.once("monitorList", function (data) { clearTimeout(timer); resolve(data || {}); });
    socket.emit("getMonitorList", function (res) {
      if (!res || !res.ok) { clearTimeout(timer); reject(new Error("getMonitorList failed: " + JSON.stringify(res))); }
    });
  });
}

function httpGetJson(url) {
  return new Promise(function (resolve, reject) {
    const mod = url.startsWith("https") ? require("https") : require("http");
    mod.get(url, function (res) {
      let body = "";
      res.on("data", function (chunk) { body += chunk; });
      res.on("end", function () {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

const socket = io(KUMA_URL, { reconnection: false, timeout: 15000 });

async function main() {
  await waitConnect();
  if (!fs.existsSync(ADMIN_FILE)) { throw new Error("missing " + ADMIN_FILE); }
  const admin = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
  const login = await emitAck("login", { username: admin.username, password: admin.password, token: "" });
  if (!login || !login.ok) { throw new Error("login failed: " + JSON.stringify(login)); }

  const monitors = await getMonitorList();
  const monitor = Object.values(monitors).find(function (m) { return m.name === MONITOR_NAME; });
  if (!monitor) {
    console.log("KUMA_VAULT " + JSON.stringify({ ok: false, reason: "monitor_not_found", monitorsTotal: Object.keys(monitors).length }));
    return 1;
  }

  const beats = [];
  socket.on("heartbeatList", function (monitorID, data) {
    if (Number(monitorID) !== Number(monitor.id)) { return; }
    if (Array.isArray(data)) { data.forEach(function (b) { beats.push(b); }); }
    else if (data) { beats.push(data); }
  });
  socket.on("heartbeat", function (h) {
    if (h && Number(h.monitor_id) === Number(monitor.id)) { beats.push(h); }
  });

  let httpHeartbeat = null;
  try {
    const page = await httpGetJson(KUMA_URL + "/api/status-page/heartbeat/" + STATUS_PAGE_SLUG);
    const list = page.heartbeatList || {};
    const key = String(monitor.id);
    if (list[key] && list[key].length > 0) { httpHeartbeat = list[key][list[key].length - 1]; }
  } catch (err) {
    httpHeartbeat = { error: String(err && err.message) };
  }

  if (beats.length === 0 || !httpHeartbeat) {
    await new Promise(function (resolve) { setTimeout(resolve, 8000); });
  }

  const last = beats.sort(function (a, b) { return new Date(a.time).getTime() - new Date(b.time).getTime(); }).pop() || null;
  const latest = last || httpHeartbeat || null;
  const summary = {
    ok: Number(httpHeartbeat && httpHeartbeat.status !== undefined ? httpHeartbeat.status : (latest && latest.status)) === 1,
    monitorId: monitor.id,
    name: monitor.name,
    type: monitor.type,
    url: monitor.url,
    interval: monitor.interval,
    active: monitor.active,
    socketHeartbeats: beats.length,
    httpHeartbeatStatus: httpHeartbeat && httpHeartbeat.status !== undefined ? httpHeartbeat.status : null,
    lastStatus: latest && latest.status !== undefined ? latest.status : null,
    statusText: latest && Number(latest.status) === 1 ? "up" : latest && latest.status !== undefined ? String(latest.status) : "unknown",
    time: latest ? latest.time : null,
    msg: latest && latest.msg !== undefined ? latest.msg : null,
  };
  console.log("KUMA_VAULT " + JSON.stringify(summary));
  socket.close();
  return summary.ok ? 0 : 2;
}

main()
  .then(function (code) { process.exit(code); })
  .catch(function (err) {
    console.log("KUMA_VAULT " + JSON.stringify({ ok: false, reason: String(err && err.message ? err.message : err) }));
    try { socket.close(); } catch (e) {}
    process.exit(1);
  });
