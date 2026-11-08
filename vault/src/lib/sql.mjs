// SQL literal rendering helpers for the dependency-free PostgreSQL client.
// Everything that reaches a query must go through one of these helpers; never interpolate
// raw user input directly into SQL text.
export function quoteString(value) {
  const text = String(value);
  if (text.includes("\u0000")) throw new Error("NUL byte is not allowed in a SQL string literal");
  return "E'" + text.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

export function litText(value) {
  if (value === null || value === undefined) return "NULL";
  return quoteString(value);
}

export function litNumber(value) {
  if (value === null || value === undefined) return "NULL";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error("non-finite number in SQL literal: " + String(value));
  return String(n);
}

export function litInteger(value) {
  const n = litNumber(value);
  if (n !== "NULL" && !/^-?[0-9]+$/.test(n)) throw new Error("expected integer, got " + String(value));
  return n;
}

export function litBool(value) {
  if (value === null || value === undefined) return "NULL";
  return value ? "TRUE" : "FALSE";
}

export function litJson(value) {
  if (value === null || value === undefined) return "NULL";
  return quoteString(JSON.stringify(value)) + "::jsonb";
}

export function litUuid(value) {
  if (value === null || value === undefined) return "NULL";
  const text = String(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error("invalid uuid literal: " + text);
  }
  return quoteString(text) + "::uuid";
}

export function litTimestamp(value) {
  if (value === null || value === undefined) return "NULL";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid timestamp literal: " + String(value));
  return quoteString(date.toISOString()) + "::timestamptz";
}

/** Render a generic JS value as a SQL literal (numbers/booleans/json/strings/null). */
export function lit(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return litNumber(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return litBool(value);
  if (value instanceof Date) return litTimestamp(value);
  if (typeof value === "object") return litJson(value);
  return quoteString(value);
}
