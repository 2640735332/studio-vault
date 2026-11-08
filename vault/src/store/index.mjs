import { MemoryVaultStore } from "./memory.mjs";
import { PgVaultStore } from "./pg.mjs";

/** Open the configured Vault store and run its bootstrap (migrations + dev seed when enabled). */
export async function openStore(config, { logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  if (config.driver === "pg") {
    const store = new PgVaultStore(config, log);
    await store.init();
    return store;
  }
  const store = new MemoryVaultStore(config, log);
  await store.init();
  return store;
}

export function describeStore(store) {
  return {
    driver: store.driver,
    durable: Boolean(store.durable),
    degraded: !store.durable,
  };
}
