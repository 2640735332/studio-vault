import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MinioObjectStore } from "./minio.mjs";

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Content-addressed object store: sha256 keys + refcount + bucketing.
 *
 * The filesystem driver ships by default; live MinIO wiring is a later deployment step.
 * Layout: <root>/<sha[0:2]>/<sha[2:4]>/<sha>. The same interface is what the MinIO driver
 * implements, so import code does not change when the backend switches.
 */
export class FsObjectStore {
  driver = "fs";

  constructor({ root }) {
    this.root = root;
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
  }

  keyFor(sha256) {
    return sha256.slice(0, 2) + "/" + sha256.slice(2, 4) + "/" + sha256;
  }

  pathFor(sha256) {
    return path.join(this.root, this.keyFor(sha256));
  }

  async has(sha256) {
    return fs.existsSync(this.pathFor(sha256));
  }

  async stat(sha256) {
    const stat = await fsp.stat(this.pathFor(sha256));
    return { sha256, sizeBytes: stat.size, key: this.keyFor(sha256) };
  }

  /** Store bytes copied from a file. Verifies the content hash while writing. */
  async putFile(sha256, sourcePath) {
    const target = this.pathFor(sha256);
    if (await this.has(sha256)) return { created: false, sha256, key: this.keyFor(sha256), sizeBytes: (await fsp.stat(target)).size };
    const buffer = await fsp.readFile(sourcePath);
    const digest = sha256Hex(buffer);
    if (digest !== sha256) throw new Error("object hash mismatch for " + sourcePath + ": expected " + sha256 + " got " + digest);
    await this.putBuffer(sha256, buffer);
    return { created: true, sha256, key: this.keyFor(sha256), sizeBytes: buffer.length };
  }

  async putBuffer(sha256, buffer) {
    const digest = sha256Hex(buffer);
    if (digest !== sha256) throw new Error("object hash mismatch: expected " + sha256 + " got " + digest);
    const target = this.pathFor(sha256);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = target + ".tmp-" + crypto.randomUUID();
    try {
      await fsp.writeFile(tmp, buffer, { flag: "wx" });
      // Publish once: readers never see a partial file and concurrent deduplicated
      // uploads never replace an object that another Windows reader has open.
      try {
        await fsp.link(tmp, target);
      } catch (error) {
        if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
        const existing = await fsp.readFile(target);
        if (sha256Hex(existing) !== sha256) throw new Error("existing object hash mismatch");
      }
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    return { created: true, sha256, key: this.keyFor(sha256), sizeBytes: buffer.length };
  }

  async readBuffer(sha256) {
    return fsp.readFile(this.pathFor(sha256));
  }

  async delete(sha256) {
    try {
      await fsp.unlink(this.pathFor(sha256));
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async health() {
    try {
      await fsp.access(this.root, fs.constants.W_OK);
      return { driver: this.driver, ok: true };
    } catch (error) {
      return { driver: this.driver, ok: false, error: String(error && error.message) };
    }
  }
}

export { MinioObjectStore };

export async function createObjectStore(config) {
  const driver = (config.objectStore || "fs").toLowerCase();
  if (driver === "fs") {
    const store = new FsObjectStore({ root: config.objectsDir || path.join(config.dataDir, "objects") });
    await store.init();
    return store;
  }
  if (driver === "minio") {
    const store = new MinioObjectStore(config);
    await store.init();
    return store;
  }
  throw new Error("unknown VAULT_OBJECT_STORE: " + driver);
}
