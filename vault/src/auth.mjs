import { parseToken, sha256Hex, formatToken, newSecret, newTokenId } from "./lib/ids.mjs";
import { badRequest, forbidden, unauthorized } from "./lib/errors.mjs";

function headerValue(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function readRawToken(req) {
  const authorization = headerValue(req, "authorization");
  if (authorization && /^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, "").trim();
  const direct = headerValue(req, "x-vault-token");
  if (direct) return String(direct).trim();
  return null;
}

/**
 * Derive the caller identity from the token. The token is the ONLY source of `author`
 * clients cannot pass an author and have it trusted.
 */
export function createAuth({ store }) {
  async function authenticate(req) {
    const raw = readRawToken(req);
    if (!raw) throw unauthorized("missing token: send Authorization: Bearer <token>");
    const parsed = parseToken(raw);
    if (!parsed) throw unauthorized("malformed token");
    const result = await store.verifyToken(parsed.id, parsed.secret);
    if (!result.ok) throw unauthorized(result.reason);
    const token = result.token;
    const projects = Array.isArray(token.projects) ? token.projects.filter((item) => typeof item === "string") : [];
    return {
      tokenId: token.id,
      label: token.label,
      role: token.role || "writer",
      projects,
      author: "token:" + (token.label || token.id),
    };
  }

  /**
   * Resolve the target project from the request. The server derives the project from the token;
   * an explicit project (header/path/query) is only an assertion that must be inside the scope.
   * A token scoped to project A asking for project B gets 403.
   */
  function resolveProject(auth, request = {}) {
    const requested = request.project || null;
    if (requested) {
      if (!auth.projects.includes(requested)) {
        throw forbidden("project_forbidden", "token has no access to project " + requested);
      }
      return requested;
    }
    if (auth.projects.length === 1) return auth.projects[0];
    if (auth.projects.length === 0) throw forbidden("no_project_scope", "token has no project scope");
    throw badRequest("multi-project token must name the project (X-Vault-Project header or ?project=)");
  }

  function requireRole(auth, required) {
    const order = { reader: 1, writer: 2, admin: 3 };
    const have = order[auth.role] || 0;
    const need = order[required] || 0;
    if (have < need) throw forbidden("insufficient_role", "token role " + auth.role + " cannot perform this action (requires " + required + ")");
  }

  return { authenticate, resolveProject, requireRole };
}

export function detectForgedAuthor(req, body) {
  const headers = ["x-vault-author", "x-author", "x-forwarded-user"];
  for (const name of headers) {
    if (headerValue(req, name)) return name;
  }
  if (req.url) {
    const url = new URL(req.url, "http://localhost");
    if (url.searchParams.has("author") || url.searchParams.has("updated_by")) return "query author";
  }
  if (body && typeof body === "object" && (Object.prototype.hasOwnProperty.call(body, "author") || Object.prototype.hasOwnProperty.call(body, "updatedBy"))) {
    return "body author";
  }
  return null;
}

export { formatToken, newSecret, newTokenId, sha256Hex };
