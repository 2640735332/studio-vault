import { pathToFileURL } from "node:url";
import { loadConfig } from "./lib/config.mjs";
import { createLogger } from "./lib/log.mjs";
import { openStore } from "./store/index.mjs";
import { createApp } from "./app.mjs";

/**
 * Start the Vault API.
 * The deployment contract (deploy/vault) runs this entry point with VAULT_DB=pg behind
 * docker compose or the Windows scheduled task; the zero-server dev mode uses VAULT_DB=memory.
 */
export async function startVault(config = loadConfig(), { logger } = {}) {
  const log = logger || createLogger({ level: config.logLevel, name: "vault" });
  log.info("starting vault", {
    version: config.version,
    driver: config.driver,
    bind: config.bind,
    port: config.port,
    migrateOnStart: config.migrateOnStart,
    devSeed: config.devSeed,
  });
  const store = await openStore(config, { logger: log });
  const app = createApp({ config, store, logger: log });
  const address = await app.listen();
  const ready = {
    event: "vault.ready",
    service: config.service,
    version: config.version,
    apiVersion: config.apiVersion,
    driver: store.driver,
    bind: address.address,
    port: address.port,
    pid: process.pid,
    startedAt: app.startedAt,
  };
  log.info("vault ready", ready);
  if (process.env.VAULT_READY_STDOUT !== "0") {
    // single machine-readable line for scripts/CI to latch onto
    process.stdout.write("VAULT_READY " + JSON.stringify(ready) + "\n");
  }
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal });
    try {
      await app.close();
    } catch {
      // ignore
    }
    try {
      await store.close();
    } catch {
      // ignore
    }
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return { app, store, address, ready, log };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startVault().catch((error) => {
    process.stderr.write("VAULT_FATAL " + String(error && error.stack ? error.stack : error) + "\n");
    process.exit(1);
  });
}
