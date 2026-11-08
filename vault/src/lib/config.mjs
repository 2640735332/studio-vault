import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..", "..");

export const DEV_PROJECTS = ["demo-project", "demo-b"];

export const DEV_TOKENS = [
  { id: "devtokena", secret: "dev-secret-a", label: "dev-a", projects: ["demo-project"], role: "admin" },
  { id: "devtokenb", secret: "dev-secret-b", label: "dev-b", projects: ["demo-b"], role: "writer" },
  { id: "devtokenm", secret: "dev-secret-m", label: "dev-multi", projects: ["demo-project", "demo-b"], role: "admin" },
];

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function intFromEnv(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseDatabaseUrl(url) {
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a postgres:// url, got " + parsed.protocol);
  }
  return {
    host: parsed.hostname || "127.0.0.1",
    port: intFromEnv(parsed.port, 5432),
    user: decodeURIComponent(parsed.username || "vault"),
    password: decodeURIComponent(parsed.password || ""),
    database: decodeURIComponent((parsed.pathname || "/vault").replace(/^\//, "") || "vault"),
  };
}

/**
 * Load Vault configuration from the environment (deploy contract in deploy/vault/README.md).
 * Keys: VAULT_BIND, VAULT_PORT, VAULT_DB (pg|memory), VAULT_PG_HOST/PORT/USER/DB/PASSWORD,
 * VAULT_DATA_DIR, VAULT_LOG_LEVEL, VAULT_MIGRATE_ON_START, VAULT_DEV_SEED, VAULT_DEV_PROJECTS,
 * VAULT_READONLY, DATABASE_URL.
 */
export function loadConfig(env = process.env) {
  const driver = (env.VAULT_DB || "memory").trim().toLowerCase();
  if (driver !== "pg" && driver !== "memory") {
    throw new Error("VAULT_DB must be 'pg' or 'memory', got " + driver);
  }
  const databaseUrl = env.DATABASE_URL ? parseDatabaseUrl(env.DATABASE_URL) : null;
  const defaultDataDir = path.join(os.homedir(), ".studio", "vault", "data");
  const pg = {
    host: env.VAULT_PG_HOST || (databaseUrl && databaseUrl.host) || "127.0.0.1",
    port: intFromEnv(env.VAULT_PG_PORT, databaseUrl ? databaseUrl.port : 5432),
    user: env.VAULT_PG_USER || (databaseUrl && databaseUrl.user) || "vault",
    database: env.VAULT_PG_DB || (databaseUrl && databaseUrl.database) || "vault",
    password: env.VAULT_PG_PASSWORD !== undefined ? env.VAULT_PG_PASSWORD : (databaseUrl ? databaseUrl.password : ""),
    connectTimeoutMs: intFromEnv(env.VAULT_PG_CONNECT_TIMEOUT_MS, 15000),
    queryTimeoutMs: intFromEnv(env.VAULT_PG_QUERY_TIMEOUT_MS, 30000),
  };
  const dataDir = env.VAULT_DATA_DIR || defaultDataDir;
  const devProjects = (env.VAULT_DEV_PROJECTS || DEV_PROJECTS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const devSeedRaw = env.VAULT_DEV_SEED;
  const devSeed = devSeedRaw === undefined || devSeedRaw === "" ? driver === "memory" : devSeedRaw === "1";
  return {
    service: "vault",
    version: readVersion(),
    apiVersion: "v1",
    bind: env.VAULT_BIND || "127.0.0.1",
    port: intFromEnv(env.VAULT_PORT, 3460),
    driver,
    pg,
    packageRoot: PACKAGE_ROOT,
    migrationsDir: env.VAULT_MIGRATIONS_DIR || path.join(PACKAGE_ROOT, "migrations"),
    dataDir,
    objectsDir: env.VAULT_OBJECTS_DIR || path.join(dataDir, "objects"),
    objectStore: (env.VAULT_OBJECT_STORE || "fs").toLowerCase(),
    minio: {
      endpoint: env.VAULT_MINIO_ENDPOINT || null,
      bucket: env.VAULT_MINIO_BUCKET || "vault",
      user: env.VAULT_MINIO_USER || null,
      password: env.VAULT_MINIO_PASSWORD || null,
      region: env.VAULT_MINIO_REGION || "us-east-1",
      prefix: env.VAULT_MINIO_PREFIX || "",
      timeoutMs: intFromEnv(env.VAULT_MINIO_TIMEOUT_MS, 20000),
      insecureTls: env.VAULT_MINIO_INSECURE_TLS || "",
    },
    logLevel: env.VAULT_LOG_LEVEL || "info",
    maxBodyBytes: intFromEnv(env.VAULT_MAX_BODY_BYTES, 4 * 1024 * 1024),
    maxUploadBytes: intFromEnv(env.VAULT_MAX_UPLOAD_BYTES, 64 * 1024 * 1024),
    migrateOnStart: env.VAULT_MIGRATE_ON_START !== "0",
    devSeed,
    devProjects,
    devTokens: DEV_TOKENS,
    readonly: env.VAULT_READONLY === "1",
  };
}

export function tokenFor(devToken) {
  return "vt_" + devToken.id + "_" + devToken.secret;
}
