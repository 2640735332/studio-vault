import { loadConfig, DEV_TOKENS } from "../src/lib/config.mjs";
import { openStore } from "../src/store/index.mjs";
import { createApp } from "../src/app.mjs";

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };

export const tokenFor = (devToken) => "vt_" + devToken.id + "_" + devToken.secret;
export const TOKEN_A = tokenFor(DEV_TOKENS[0]);
export const TOKEN_B = tokenFor(DEV_TOKENS[1]);
export const TOKEN_MULTI = tokenFor(DEV_TOKENS[2]);

export async function startTestApp(overrides = {}) {
  const config = loadConfig({
    VAULT_DB: overrides.driver || "memory",
    VAULT_PORT: "0",
    VAULT_BIND: "127.0.0.1",
    VAULT_DEV_SEED: overrides.devSeed === false ? "0" : "1",
    VAULT_MIGRATE_ON_START: "1",
    VAULT_LOG_LEVEL: "error",
  });
  const store = await openStore(config, { logger: silentLogger });
  const app = createApp({ config, store, logger: silentLogger });
  await app.listen();
  const port = app.server.address().port;
  const baseUrl = "http://127.0.0.1:" + port;
  async function request(method, pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.token) headers.authorization = "Bearer " + options.token;
    let body;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await fetch(baseUrl + pathname, { method, headers, body });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  }
  return {
    config,
    store,
    app,
    baseUrl,
    request,
    async close() {
      await app.close();
      await store.close();
    },
  };
}
