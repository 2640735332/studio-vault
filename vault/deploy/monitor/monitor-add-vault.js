"use strict";

/**
 * Adds a Vault health monitor to an existing Uptime Kuma deployment (socket.io API).
 *
 * Run it where Uptime Kuma's dependencies are installed, with NODE_PATH pointing at the
 * Kuma node_modules directory, for example:
 *   NODE_PATH=<monitor-install>/node_modules node vault/deploy/monitor/monitor-add-vault.js
 *
 * Environment:
 *   KUMA_URL           Uptime Kuma base URL (default http://127.0.0.1:3001)
 *   KUMA_ADMIN_FILE    JSON file with {"username","password"}; default
 *                      <KUMA_DATA_DIR>/monitor-admin.json, then ./monitor-admin.json
 *   KUMA_DATA_DIR      Directory that contains monitor-admin.json (default: working directory)
 *   KUMA_MONITOR_NAME  Monitor name (default "Vault (<vault host:port>)")
 *   VAULT_URL          Vault base URL used as the monitor target (default http://127.0.0.1:3460)
 *   KUMA_STATUS_PAGE   Status page slug to append the monitor to (default "home")
 *   KUMA_STATUS_GROUP  Status page group name (default "Services")
 *
 * Idempotent: if the monitor already exists it only reports it. Reuses the existing default
 * webhook notification of the first monitor that has one.
 *
 * ASCII-only (runs under Windows PowerShell 5.1 task context).
 */

const fs = require("fs");
const path = require("path");
const { io } = require("socket.io-client");

const KUMA_URL = process.env.KUMA_URL || "http://127.0.0.1:3001";
const VAULT_URL = process.env.VAULT_URL || "http://127.0.0.1:3460";
const MONITOR_NAME = process.env.KUMA_MONITOR_NAME || "Vault (" + VAULT_URL.replace(/^https?:\/\//, "") + ")";
const MONITOR_URL = VAULT_URL.replace(/\/+$/, "") + "/api/v1/health";
const KUMA_DATA_DIR = process.env.KUMA_DATA_DIR || process.cwd();
const ADMIN_FILE = process.env.KUMA_ADMIN_FILE || path.join(KUMA_DATA_DIR, "monitor-admin.json");
const STATUS_PAGE_SLUG = process.env.KUMA_STATUS_PAGE || "home";
const STATUS_GROUP = process.env.KUMA_STATUS_GROUP || "Services";

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log.apply(console, [new Date().toISOString()].concat(args));
}

const monitorDefaults = {
  type: "http",
  name: "",
  parent: null,
  url: "http://",
  wsSubprotocol: "",
  method: "GET",
  protocol: null,
  location: "world",
  ipFamily: null,
  interval: 60,
  retryInterval: 60,
  resendInterval: 0,
  maxretries: 1,
  retryOnlyOnStatusCodeFailure: false,
  notificationIDList: {},
  ignoreTls: false,
  upsideDown: false,
  expiryNotification: false,
  domainExpiryNotification: false,
  maxredirects: 10,
  accepted_statuscodes: ["200-299"],
  saveResponse: false,
  saveErrorResponse: true,
  responseMaxLength: 1024,
  dns_resolve_type: "A",
  dns_resolve_server: "",
  docker_container: "",
  docker_host: null,
  proxyId: null,
  basic_auth_user: "",
  basic_auth_pass: "",
  bearer_token: "",
  mqttUsername: "",
  mqttPassword: "",
  mqttTopic: "",
  mqttWebsocketPath: "",
  mqttSuccessMessage: "",
  mqttCheckType: "keyword",
  authMethod: null,
  oauth_auth_method: "client_secret_basic",
  httpBodyEncoding: "json",
  kafkaProducerBrokers: [],
  kafkaProducerSaslOptions: { mechanism: "None" },
  cacheBust: false,
  kafkaProducerSsl: false,
  kafkaProducerAllowAutoTopicCreation: false,
  gamedigGivenPortOnly: true,
  gamedigToken: "",
  remote_browser: null,
  screenshot_delay: 0,
  rabbitmqNodes: [],
  rabbitmqUsername: "",
  rabbitmqPassword: "",
  conditions: [],
  system_service_name: "",
  sshAuthMethod: "password",
  ntpStratumThreshold: 5,
  ntpTimeOffsetThreshold: 1000,
  ntpRootDispersionThreshold: 500,
};

const socket = io(KUMA_URL, { reconnection: false, timeout: 15000 });

function emitAck(event) {
  const args = Array.prototype.slice.call(arguments, 1);
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () { reject(new Error("timeout waiting for " + event)); }, 30000);
    const cb = function (res) { clearTimeout(timer); resolve(res); };
    socket.emit.apply(socket, [event].concat(args, [cb]));
  });
}

function waitConnect() {
  return new Promise(function (resolve, reject) {
    if (socket.connected) { return resolve(); }
    const timer = setTimeout(function () { reject(new Error("connect timeout to " + KUMA_URL)); }, 15000);
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

function findNotificationId(monitors) {
  const values = Object.values(monitors);
  for (let i = 0; i < values.length; i += 1) {
    const ids = Object.keys(values[i].notificationIDList || {});
    if (ids.length > 0) { return parseInt(ids[0], 10); }
  }
  return null;
}

async function main() {
  await waitConnect();
  log("connected to", KUMA_URL);
  if (!fs.existsSync(ADMIN_FILE)) { throw new Error("missing Kuma admin credentials: " + ADMIN_FILE); }
  const admin = JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
  const login = await emitAck("login", { username: admin.username, password: admin.password, token: "" });
  if (!login || !login.ok) { throw new Error("monitor login failed: " + JSON.stringify(login)); }
  log("logged in as", admin.username);

  let monitors = await getMonitorList();
  const byName = {};
  Object.values(monitors).forEach(function (m) { byName[m.name] = m; });
  const existing = byName[MONITOR_NAME];
  let created = null;
  let monitorId = existing ? existing.id : null;

  if (!existing) {
    const notificationID = findNotificationId(monitors);
    const payload = Object.assign({}, monitorDefaults, {
      name: MONITOR_NAME,
      url: MONITOR_URL,
      interval: 60,
      retryInterval: 60,
      maxretries: 1,
      notificationIDList: notificationID === null ? {} : JSON.parse("{" + JSON.stringify(String(notificationID)) + ":true}"),
    });
    const res = await emitAck("add", payload);
    if (!res || !res.ok) { throw new Error("add monitor failed: " + JSON.stringify(res)); }
    monitorId = res.monitorID;
    created = { name: MONITOR_NAME, id: monitorId, notificationID: notificationID };
    log("monitor created:", MONITOR_NAME, "id =", monitorId);
  } else {
    log("monitor already exists:", MONITOR_NAME, "id =", existing.id);
  }

  // Append the monitor to the configured status page group.
  let statusPage = null;
  try {
    monitors = await getMonitorList();
    const allIds = Object.values(monitors).map(function (m) { return { id: m.id }; });
    let pageRes = await emitAck("getStatusPage", STATUS_PAGE_SLUG);
    if (!pageRes || !pageRes.ok) { throw new Error("getStatusPage failed: " + JSON.stringify(pageRes)); }
    const config = pageRes.config || {};
    config.slug = STATUS_PAGE_SLUG;
    config.title = config.title || "Service Status";
    const groups = [{ name: STATUS_GROUP, monitorList: allIds }];
    const saved = await emitAck("saveStatusPage", STATUS_PAGE_SLUG, config, "", groups);
    if (saved && saved.ok) { statusPage = STATUS_PAGE_SLUG; log("status page updated with", allIds.length, "monitors"); }
    else { log("status page save failed:", JSON.stringify(saved)); }
  } catch (err) {
    log("status page skipped:", err.message);
  }

  const summary = {
    ok: true,
    monitor: MONITOR_NAME,
    url: MONITOR_URL,
    monitorId: monitorId,
    created: created,
    statusPage: statusPage,
    monitorsTotal: Object.keys(monitors || {}).length,
  };
  console.log("KUMA_SUMMARY " + JSON.stringify(summary));
  socket.close();
}

main()
  .then(function () { process.exit(0); })
  .catch(function (err) {
    console.error("KUMA_ADD_FAILED:", err.message);
    socket.close();
    process.exit(1);
  });
