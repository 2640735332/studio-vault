// Minimal, dependency-free PostgreSQL wire-protocol (v3.0) client.
//
// Scope: initialise a connection (trust / cleartext / MD5 / SCRAM-SHA-256 auth) and run
// *simple* queries (text result format). Enough for the Vault service skeleton and for
// operating tooling; the Vault deployment target (compose) runs a real PostgreSQL server.
//
// Design notes:
//  - One TCP connection per PgConnection; callers serialise access (see PgClient in pg.mjs).
//  - All parameter values are rendered by ../lib/sql.mjs literal helpers (no extended protocol).
//  - Rows are returned in text format (strings / null); coercion happens in the store layer.
import net from "node:net";
import crypto from "node:crypto";

const PROTOCOL_V3 = 196608;
const AUTH_OK = 0;
const AUTH_CLEARTEXT = 3;
const AUTH_MD5 = 5;
const AUTH_SASL = 10;
const AUTH_SASL_CONTINUE = 11;
const AUTH_SASL_FINAL = 12;

export class PgError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "PgError";
    this.code = fields.C || "PG_ERROR";
    this.severity = fields.S;
    this.detail = fields.D;
    this.hint = fields.H;
    this.position = fields.P;
  }
}

function cstr(value) {
  return Buffer.from(String(value) + "\u0000", "utf8");
}

function int32(value) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value, 0);
  return b;
}

function parseErrorPayload(payload) {
  const fields = {};
  let offset = 0;
  while (offset < payload.length) {
    const code = payload[offset];
    offset += 1;
    if (code === 0) break;
    const end = payload.indexOf(0, offset);
    if (end === -1) break;
    const key = String.fromCharCode(code);
    fields[key] = payload.toString("utf8", offset, end);
    offset = end + 1;
  }
  const err = new PgError(fields.M || "postgres error", fields);
  return err;
}

function parseRowCount(command) {
  if (!command) return 0;
  const m = /([0-9]+)\s*$/.exec(command);
  return m ? Number(m[1]) : 0;
}

function xorBuffers(a, b) {
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

function hmacSha256(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function parseScramAttributes(text) {
  const attrs = {};
  for (const part of text.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    attrs[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return attrs;
}

export class PgConnection {
  #socket;
  #options;
  #buffer = Buffer.alloc(0);
  #queue = [];
  #waiter = null;
  #failure = null;
  #closed = false;
  #params = new Map();
  #lastNotice = null;

  constructor(socket, options = {}) {
    this.#socket = socket;
    this.#options = options;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (err) => this.#fail(err));
    socket.on("close", () => {
      this.#closed = true;
      this.#fail(Object.assign(new Error("postgres connection closed"), { code: "CONNECTION_CLOSED" }));
    });
  }

  static async connect(options) {
    const {
      host = "127.0.0.1",
      port = 5432,
      user = "vault",
      database = user,
      password = "",
      applicationName = "studio-vault",
      connectTimeoutMs = 15000,
      queryTimeoutMs = 30000,
    } = options || {};
    const socket = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(Object.assign(new Error("postgres connect timeout"), { code: "CONNECT_TIMEOUT" }));
      }, connectTimeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const conn = new PgConnection(socket, {
      host,
      port,
      user,
      database,
      password: password ?? "",
      applicationName,
      connectTimeoutMs,
      queryTimeoutMs,
    });
    try {
      await conn.#startup();
    } catch (err) {
      conn.#destroy(err);
      throw err;
    }
    return conn;
  }

  get serverParameters() {
    return Object.fromEntries(this.#params.entries());
  }

  get lastNotice() {
    return this.#lastNotice;
  }

  get closed() {
    return this.#closed || this.#failure !== null;
  }

  async query(sql, { timeoutMs } = {}) {
    if (this.closed) throw this.#failure || new Error("postgres connection is closed");
    this.#send("Q", cstr(sql));
    const fields = [];
    const rows = [];
    let command = null;
    let failure = null;
    for (;;) {
      const msg = await this.#next(timeoutMs || this.#options.queryTimeoutMs || 30000);
      switch (msg.type) {
        case "T":
          fields.length = 0;
          this.#parseRowDescription(msg.payload, fields);
          break;
        case "D":
          rows.push(this.#parseDataRow(msg.payload, fields));
          break;
        case "C":
          command = msg.payload.toString("utf8").replace(/\u0000+$/, "");
          break;
        case "E":
          failure = parseErrorPayload(msg.payload);
          break;
        case "Z":
          if (failure) throw failure;
          return { fields, rows, command, rowCount: parseRowCount(command), notices: this.#lastNotice };
        case "I":
          break;
        default:
          break; // notice/parameter/notification messages are not part of the query result
      }
    }
  }

  async end() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#send("X", Buffer.alloc(0));
    } catch {
      // ignore write failures on shutdown
    }
    await new Promise((resolve) => {
      this.#socket.end(() => resolve());
      setTimeout(() => {
        this.#socket.destroy();
        resolve();
      }, 200).unref?.();
    });
  }

  #destroy(err) {
    this.#closed = true;
    if (err) this.#fail(err);
    this.#socket.destroy();
  }

  #startup() {
    const { user, database, applicationName } = this.#options;
    const params = [
      cstr("user"), cstr(user),
      cstr("database"), cstr(database || user),
      cstr("client_encoding"), cstr("UTF8"),
      cstr("application_name"), cstr(applicationName || "studio-vault"),
    ];
    const body = Buffer.concat([...params, Buffer.from([0])]);
    const header = Buffer.alloc(8);
    header.writeInt32BE(body.length + 8, 0);
    header.writeInt32BE(PROTOCOL_V3, 4);
    this.#socket.write(Buffer.concat([header, body]));
    return this.#awaitReady();
  }

  async #awaitReady() {
    let sasl = null;
    const timeoutMs = this.#options.connectTimeoutMs || 15000;
    for (;;) {
      const msg = await this.#next(timeoutMs);
      if (msg.type === "E") throw parseErrorPayload(msg.payload);
      if (msg.type === "Z") return;
      if (msg.type !== "R") continue;
      const code = msg.payload.readInt32BE(0);
      const rest = msg.payload.subarray(4);
      if (code === AUTH_OK) continue;
      if (code === AUTH_CLEARTEXT) {
        this.#passwordMessage(cstr(this.#options.password || ""));
        continue;
      }
      if (code === AUTH_MD5) {
        const inner = crypto.createHash("md5").update((this.#options.password || "") + this.#options.user).digest("hex");
        const outer = crypto.createHash("md5").update(Buffer.concat([Buffer.from(inner, "utf8"), rest.subarray(0, 4)])).digest("hex");
        this.#passwordMessage(cstr("md5" + outer));
        continue;
      }
      if (code === AUTH_SASL) {
        sasl = this.#saslStart(rest);
        continue;
      }
      if (code === AUTH_SASL_CONTINUE) {
        if (!sasl) throw new Error("unexpected SASL continue without SASL start");
        this.#saslContinue(rest, sasl);
        continue;
      }
      if (code === AUTH_SASL_FINAL) {
        if (!sasl) throw new Error("unexpected SASL final without SASL start");
        this.#saslFinal(rest, sasl);
        continue;
      }
      throw new Error("unsupported postgres authentication method: code " + code);
    }
  }

  #saslStart(rest) {
    const mechanisms = [];
    let offset = 0;
    for (;;) {
      const end = rest.indexOf(0, offset);
      if (end === -1) break;
      if (end === offset) break;
      mechanisms.push(rest.toString("utf8", offset, end));
      offset = end + 1;
    }
    if (!mechanisms.includes("SCRAM-SHA-256")) {
      throw new Error("postgres requires an unsupported SASL mechanism: " + mechanisms.join(","));
    }
    const nonce = crypto.randomBytes(18).toString("base64");
    const clientFirstBare = "n=,r=" + nonce;
    const clientFirst = "n,," + clientFirstBare;
    const initial = Buffer.from(clientFirst, "utf8");
    this.#passwordMessage(Buffer.concat([cstr("SCRAM-SHA-256"), int32(initial.length), initial]));
    return { nonce, clientFirstBare, clientFirst };
  }

  #saslContinue(rest, sasl) {
    const serverFirst = rest.toString("utf8");
    const attrs = parseScramAttributes(serverFirst);
    const serverNonce = attrs.r || "";
    if (!serverNonce.startsWith(sasl.nonce)) throw new Error("SCRAM server nonce does not extend client nonce");
    const salt = Buffer.from(attrs.s || "", "base64");
    const iterations = Number(attrs.i || 0);
    if (!salt.length || !Number.isInteger(iterations) || iterations < 4096) {
      throw new Error("invalid SCRAM salt/iteration count from server");
    }
    const saltedPassword = crypto.pbkdf2Sync(this.#options.password || "", salt, iterations, 32, "sha256");
    const clientKey = hmacSha256(saltedPassword, "Client Key");
    const storedKey = crypto.createHash("sha256").update(clientKey).digest();
    const clientFinalWithoutProof = "c=biws,r=" + serverNonce;
    const authMessage = sasl.clientFirstBare + "," + serverFirst + "," + clientFinalWithoutProof;
    const clientSignature = hmacSha256(storedKey, authMessage);
    const proof = xorBuffers(clientKey, clientSignature);
    const clientFinal = clientFinalWithoutProof + ",p=" + proof.toString("base64");
    this.#passwordMessage(Buffer.from(clientFinal, "utf8"));
    sasl.serverFirst = serverFirst;
    sasl.authMessage = authMessage;
    sasl.saltedPassword = saltedPassword;
  }

  #saslFinal(rest, sasl) {
    const serverFinal = rest.toString("utf8");
    const attrs = parseScramAttributes(serverFinal);
    if (attrs.e) throw new Error("postgres SCRAM authentication failed: " + attrs.e);
    if (attrs.v) {
      const serverKey = hmacSha256(sasl.saltedPassword, "Server Key");
      const expected = hmacSha256(serverKey, sasl.authMessage).toString("base64");
      if (expected !== attrs.v) throw new Error("postgres SCRAM server signature mismatch");
    }
  }

  #passwordMessage(payload) {
    this.#send("p", payload);
  }

  #send(type, payload) {
    if (this.#closed) throw this.#failure || new Error("postgres connection is closed");
    const header = Buffer.alloc(5);
    header.write(type, 0, "utf8");
    header.writeInt32BE(payload.length + 4, 1);
    this.#socket.write(Buffer.concat([header, payload]));
  }

  #onData(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < 5) return;
      const length = this.#buffer.readInt32BE(1);
      if (this.#buffer.length < 1 + length) return;
      const type = String.fromCharCode(this.#buffer[0]);
      const payload = this.#buffer.subarray(5, 1 + length);
      this.#buffer = this.#buffer.subarray(1 + length);
      if (type === "S") {
        const text = payload.toString("utf8");
        const idx = text.indexOf("\u0000");
        if (idx > 0) this.#params.set(text.slice(0, idx), text.slice(idx + 1).replace(/\u0000+$/, ""));
        continue;
      }
      if (type === "K") continue;
      if (type === "N") {
        const notice = parseErrorPayload(payload);
        this.#lastNotice = notice.message;
        continue;
      }
      this.#queue.push({ type, payload });
      this.#wake();
    }
  }

  #wake() {
    const waiter = this.#waiter;
    if (!waiter) return;
    this.#waiter = null;
    waiter.resolve();
  }

  #fail(err) {
    if (!this.#failure) this.#failure = err || new Error("postgres connection failed");
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter.reject(this.#failure);
    }
  }

  async #next(timeoutMs) {
    for (;;) {
      if (this.#queue.length > 0) return this.#queue.shift();
      if (this.#failure) throw this.#failure;
      await this.#waitForMessage(timeoutMs);
    }
  }

  #waitForMessage(timeoutMs) {
    if (this.#queue.length > 0) return Promise.resolve();
    const waiter = { resolve: null, reject: null, timer: null };
    const promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    this.#waiter = waiter;
    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        if (this.#waiter === waiter) this.#waiter = null;
        waiter.reject(Object.assign(new Error("postgres message timeout"), { code: "PG_TIMEOUT" }));
      }, timeoutMs);
      waiter.timer.unref?.();
    }
    return promise.finally(() => {
      if (waiter.timer) clearTimeout(waiter.timer);
    });
  }

  #parseRowDescription(payload, out) {
    const count = payload.readInt16BE(0);
    let offset = 2;
    for (let i = 0; i < count; i += 1) {
      const end = payload.indexOf(0, offset);
      const name = payload.toString("utf8", offset, end);
      offset = end + 1;
      offset += 4; // table oid
      offset += 2; // column attribute number
      const typeOid = payload.readInt32BE(offset);
      offset += 4;
      offset += 2; // type size
      offset += 4; // type modifier
      const format = payload.readInt16BE(offset);
      offset += 2;
      out.push({ name, typeOid, format });
    }
  }

  #parseDataRow(payload, fields) {
    const count = payload.readInt16BE(0);
    let offset = 2;
    const row = {};
    for (let i = 0; i < count; i += 1) {
      const length = payload.readInt32BE(offset);
      offset += 4;
      const field = fields[i];
      if (length === -1) {
        row[field?.name ?? String(i)] = null;
      } else {
        row[field?.name ?? String(i)] = payload.toString("utf8", offset, offset + length);
        offset += length;
      }
    }
    return row;
  }
}
