#!/usr/bin/env node
// Vault token administration (token scope -> projects[]; author is derived from the token).
//
//   node scripts/vault-token.mjs create --label dev-laptop --project demo-project --role writer [--ensure-project]
//   node scripts/vault-token.mjs list
//   node scripts/vault-token.mjs revoke --id tkxxxxxxxx
//   node scripts/vault-token.mjs verify --token vt_...
//
// The raw token is printed exactly once (only sha256(secret) is stored). Never commit it.
import { loadConfig } from "../src/lib/config.mjs";
import { openStore } from "../src/store/index.mjs";
import { createLogger } from "../src/lib/log.mjs";
import { formatToken, parseToken, sha256Hex } from "../src/lib/ids.mjs";

function parseArgs(argv) {
  const args = { command: argv[0], projects: [], label: null, role: "writer", id: null, token: null, ensureProject: false, json: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--label") args.label = argv[++i];
    else if (arg === "--project") args.projects.push(argv[++i]);
    else if (arg === "--role") args.role = argv[++i];
    else if (arg === "--id") args.id = argv[++i];
    else if (arg === "--token") args.token = argv[++i];
    else if (arg === "--ensure-project") args.ensureProject = true;
    else if (arg === "--json") args.json = true;
    else throw new Error("unknown argument: " + arg);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!["create", "list", "revoke", "verify"].includes(args.command)) {
    throw new Error("usage: vault-token.mjs <create|list|revoke|verify> [options]");
  }
  const config = loadConfig();
  const log = createLogger({ level: "warn", name: "vault-token" });
  const store = await openStore(config, { logger: log });
  try {
    if (args.command === "create") {
      if (!args.label) throw new Error("--label is required");
      if (args.projects.length === 0) throw new Error("--project is required (repeatable)");
      if (!["reader", "writer", "admin"].includes(args.role)) throw new Error("--role must be reader|writer|admin");
      if (config.driver !== "pg") {
        process.stderr.write("warning: VAULT_DB=memory - tokens live only for this process and are not durable\n");
      }
      for (const project of args.projects) {
        const existing = await store.getProject(project);
        if (!existing && args.ensureProject) await store.ensureProject(project, project);
        if (!existing && !args.ensureProject) {
          process.stderr.write("warning: project " + project + " is not registered (use --ensure-project to create it)\n");
        }
      }
      const id = "tk" + sha256Hex(args.label + ":" + args.projects.join(",") + ":" + Date.now()).slice(0, 8);
      const secretChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      let secret = "";
      const bytes = await import("node:crypto").then((mod) => mod.randomBytes(32));
      for (const byte of bytes) secret += secretChars[byte % secretChars.length];
      const token = await store.createToken({
        id,
        label: args.label,
        tokenHash: sha256Hex(secret),
        projects: args.projects,
        role: args.role,
        metadata: { createdBy: "vault-token-cli" },
      });
      process.stdout.write(JSON.stringify({ id: token.id, label: token.label, projects: token.projects, role: token.role, token: formatToken(id, secret) }, null, 2) + "\n");
    } else if (args.command === "list") {
      const tokens = await store.listTokens();
      process.stdout.write(JSON.stringify(tokens.map((token) => ({ ...token, tokenHash: undefined })), null, 2) + "\n");
    } else if (args.command === "revoke") {
      if (!args.id) throw new Error("--id is required");
      const token = await store.revokeToken(args.id);
      if (!token) throw new Error("token not found: " + args.id);
      process.stdout.write(JSON.stringify({ revoked: true, id: token.id, revokedAt: token.revokedAt }, null, 2) + "\n");
    } else if (args.command === "verify") {
      if (!args.token) throw new Error("--token is required");
      const parsed = parseToken(args.token);
      if (!parsed) throw new Error("malformed token");
      const result = await store.verifyToken(parsed.id, parsed.secret);
      process.stdout.write(JSON.stringify(result.ok ? { ok: true, id: result.token.id, label: result.token.label, projects: result.token.projects, role: result.token.role } : { ok: false, reason: result.reason }, null, 2) + "\n");
      if (!result.ok) process.exitCode = 2;
    }
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write("vault-token failed: " + String(error && error.message ? error.message : error) + "\n");
  process.exit(1);
});
