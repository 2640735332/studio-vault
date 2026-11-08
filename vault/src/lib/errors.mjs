// Typed errors shared by the Vault service, CLI scripts and tests.
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, details) { return new ApiError(400, "bad_request", message, details); }
export function unauthorized(message = "missing or invalid token") { return new ApiError(401, "unauthorized", message); }
export function forbidden(code, message) { return new ApiError(403, code, message); }
export function notFound(message = "not found") { return new ApiError(404, "not_found", message); }
export function conflict(code, message, details) { return new ApiError(409, code, message, details); }
export function tooLarge(message = "payload too large") { return new ApiError(413, "payload_too_large", message); }
export function internal(message = "internal error", details) { return new ApiError(500, "internal_error", message, details); }
