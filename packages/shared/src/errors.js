export class StudioError extends Error {
  constructor(code, message, { hint = null, details = null } = {}) {
    super(message);
    this.name = 'StudioError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export function toErrorPayload(err) {
  return {
    ok: false,
    code: err && err.code ? err.code : 'error',
    message: err && err.message ? err.message : String(err),
    hint: err && err.hint ? err.hint : null,
    details: err && err.details ? err.details : null,
  };
}
