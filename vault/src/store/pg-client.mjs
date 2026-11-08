import { PgConnection } from "../lib/pgwire.mjs";

class Mutex {
  #tail = Promise.resolve();
  run(task) {
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Serialised PostgreSQL client.
 *
 * The Vault service uses one logical connection per process for the skeleton: every
 * operation (including whole transactions) runs under a mutex so that BEGIN/COMMIT of one
 * request never interleaves with another request's statements. Horizontal scale-out is done
 * by running several Vault API processes against the same PostgreSQL server (see
 * deploy/vault/docker-compose.yml), not by sharing a connection.
 */
export class PgClient {
  #options;
  #lock = new Mutex();
  #connection = null;

  constructor(options) {
    this.#options = options;
  }

  async #conn() {
    if (this.#connection && !this.#connection.closed) return this.#connection;
    this.#connection = await PgConnection.connect(this.#options);
    return this.#connection;
  }

  async query(sql) {
    return this.#lock.run(async () => {
      const conn = await this.#conn();
      try {
        return await conn.query(sql);
      } catch (error) {
        if (error && (error.code === "CONNECTION_CLOSED" || error.code === "ECONNRESET" || error.code === "ECONNREFUSED")) {
          this.#connection = null;
        }
        throw error;
      }
    });
  }

  /** Run fn inside BEGIN/COMMIT. fn receives a raw query function bound to the same connection. */
  async transaction(fn) {
    return this.#lock.run(async () => {
      const conn = await this.#conn();
      const query = (sql) => conn.query(sql);
      await query("BEGIN");
      try {
        const result = await fn(query);
        await query("COMMIT");
        return result;
      } catch (error) {
        try {
          await query("ROLLBACK");
        } catch {
          // ignore rollback failures, the original error is what matters
        }
        if (error && (error.code === "CONNECTION_CLOSED" || error.code === "ECONNRESET")) this.#connection = null;
        throw error;
      }
    });
  }

  async ping() {
    const started = Date.now();
    const result = await this.query("SELECT version() AS version, current_database() AS database, now() AS now");
    const row = result.rows[0] || {};
    return {
      ok: true,
      latencyMs: Date.now() - started,
      serverVersion: row.version || null,
      database: row.database || null,
      serverTime: row.now || null,
    };
  }

  async close() {
    const conn = this.#connection;
    this.#connection = null;
    if (conn) await conn.end();
  }
}
