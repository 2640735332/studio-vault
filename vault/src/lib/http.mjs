import crypto from "node:crypto";
import { ApiError, badRequest, tooLarge } from "./errors.mjs";

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-vault-api": "v1",
    ...headers,
  });
  res.end(text);
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end();
}

export async function readJsonBody(req, options = {}) {
  const limit = options.limit === undefined ? 4 * 1024 * 1024 : options.limit;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw tooLarge("request body exceeds " + String(limit) + " bytes");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("request body is not valid JSON");
  }
}

export async function readRawBody(req, options = {}) {
  const limit = options.limit === undefined ? 64 * 1024 * 1024 : options.limit;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw tooLarge("upload body exceeds " + String(limit) + " bytes");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const MIME_BY_EXT = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export function mimeForPath(name) {
  const ext = (String(name || "").match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

export function newRequestId() {
  return "req_" + crypto.randomBytes(8).toString("hex");
}

export function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || null;
}

export function sendApiError(res, error, requestId) {
  const status = error instanceof ApiError ? error.status : 500;
  const code = error instanceof ApiError ? error.code : "internal_error";
  const message = error instanceof Error ? error.message : String(error);
  const body = { error: { code, message, request_id: requestId === undefined ? null : requestId } };
  if (error instanceof ApiError && error.details !== undefined) body.error.details = error.details;
  sendJson(res, status, body);
}
