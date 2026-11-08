import crypto from "node:crypto";

export function uuid() { return crypto.randomUUID(); }

const TOKEN_ID_RE = /^[a-z0-9]{8,32}$/;

export function newTokenId(prefix = "tk") {
  // 8 lowercase base36 chars: stable, url safe, non-guessable enough as a lookup key (secret carries entropy).
  const raw = crypto.randomBytes(6).toString("hex").slice(0, 8);
  return prefix + raw;
}

export function newSecret() { return crypto.randomBytes(32).toString("base64url"); }

export function sha256Hex(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }

export function hmacHex(key, value) { return crypto.createHmac("sha256", key).update(String(value)).digest("hex"); }

/** Token wire format: `vt_<id>_<secret>` (secret never stored, only sha256). */
export function formatToken(id, secret) { return `vt_${id}_${secret}`; }

export function parseToken(raw) {
  if (typeof raw !== "string") return null;
  const m = /^vt_([a-z0-9]{8,32})_([A-Za-z0-9_-]{8,128})$/.exec(raw.trim());
  if (!m) return null;
  if (!TOKEN_ID_RE.test(m[1])) return null;
  return { id: m[1], secret: m[2] };
}

export function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a), "hex");
  const bb = Buffer.from(String(b), "hex");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}
