import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import fsp from "node:fs/promises";

/**
 * MinIO / S3-compatible object store driver (AWS Signature Version 4, path-style URLs).
 *
 * Design intent (see docs/DATABASE.md):
 *   - Same content-addressed key layout as the fs driver: <prefix>/<sha[0:2]>/<sha[2:4]>/<sha>
 *   - Bucket per Vault deployment (VAULT_MINIO_BUCKET, default "vault"); object key mirrors the
 *     fs path so switching backends does not change blobs.object_key semantics.
 *   - Zero npm dependencies: SigV4 is implemented with node:crypto.
 *
 * Status: unit-tested against the AWS SigV4 canonical-request/signature vectors; live MinIO /
 * S3 verification is env-gated (VAULT_MINIO_TEST_ENDPOINT) because the default deployment runs
 * the filesystem driver (MinIO wiring is a later deployment step).
 */

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

function amzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return iso; // YYYYMMDDTHHMMSSZ
}

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function uriEncode(value, encodeSlash = true) {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return encodeSlash ? encoded : encoded.replace(/%2F/g, "/");
}

/**
 * Canonical request per AWS SigV4 spec (S3 variant: sorted headers, URI-encoded path with
 * single-encoding, sorted query parameters).
 */
export function buildCanonicalRequest({ method, path, query, headers, payloadHash }) {
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) normalized[name.toLowerCase()] = String(value).trim();
  const headerNames = Object.keys(normalized).sort();
  const canonicalHeaders = headerNames.map((name) => name + ":" + normalized[name] + "\n").join("");
  const signedHeaders = headerNames.join(";");
  const queryText = Object.entries(query || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [uriEncode(String(key)), uriEncode(String(value))])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => key + "=" + value)
    .join("&");
  const canonicalUri = path
    .split("/")
    .map((segment) => uriEncode(segment))
    .join("/");
  const canonicalRequest = [method, canonicalUri, queryText, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  return { canonicalRequest, signedHeaders, canonicalUri, canonicalQuery: queryText, canonicalHeaders };
}

export function buildStringToSign({ canonicalRequest, amzDateValue, scope }) {
  return ["AWS4-HMAC-SHA256", amzDateValue, scope, sha256Hex(canonicalRequest)].join("\n");
}

export function signingKey({ secretKey, dateStampValue, region, service }) {
  const kDate = hmac("AWS4" + secretKey, dateStampValue);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * Sign an HTTP request for S3-compatible storage and return the headers to send.
 * Returns { headers, canonicalRequest, stringToSign, creditScope } for unit tests.
 */
export function signRequest({ method, path, query = {}, headers = {}, payloadHash, accessKey, secretKey, region = "us-east-1", service = "s3", now = new Date() }) {
  const amzDateValue = amzDate(now);
  const dateStampValue = dateStamp(now);
  const scope = dateStampValue + "/" + region + "/" + service + "/aws4_request";
  const allHeaders = { ...headers, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDateValue };
  const built = buildCanonicalRequest({ method, path, query, headers: allHeaders, payloadHash });
  const stringToSign = buildStringToSign({ canonicalRequest: built.canonicalRequest, amzDateValue, scope });
  const key = signingKey({ secretKey, dateStampValue, region, service });
  const signature = crypto.createHmac("sha256", key).update(stringToSign).digest("hex");
  const authorization =
    "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + scope + ", SignedHeaders=" + built.signedHeaders + ", Signature=" + signature;
  return {
    headers: { ...allHeaders, authorization },
    canonicalRequest: built.canonicalRequest,
    signedHeaders: built.signedHeaders,
    canonicalUri: built.canonicalUri,
    canonicalQuery: built.canonicalQuery,
    stringToSign,
    signature,
    scope,
  };
}

function requestBuffer(url, { method, headers, body, timeoutMs = 20000, insecureTls = false }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method,
        path: url.pathname + (url.search || ""),
        headers,
        timeout: timeoutMs,
        rejectUnauthorized: !insecureTls,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
      },
    );
    request.on("timeout", () => request.destroy(new Error("minio request timeout")));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

export class MinioObjectStore {
  driver = "minio";

  constructor(config) {
    const minioConfig = (config && config.minio) || {};
    if (!minioConfig.endpoint) throw new Error("VAULT_OBJECT_STORE=minio requires VAULT_MINIO_ENDPOINT");
    if (!minioConfig.user || !minioConfig.password) throw new Error("VAULT_OBJECT_STORE=minio requires VAULT_MINIO_USER/VAULT_MINIO_PASSWORD");
    if (!minioConfig.bucket) throw new Error("VAULT_OBJECT_STORE=minio requires VAULT_MINIO_BUCKET");
    this.endpoint = new URL(minioConfig.endpoint);
    this.bucket = minioConfig.bucket;
    this.accessKey = minioConfig.user;
    this.secretKey = minioConfig.password;
    this.region = minioConfig.region || "us-east-1";
    this.prefix = (minioConfig.prefix || "").replace(/^\/+|\/+$/g, "");
    this.timeoutMs = Number(minioConfig.timeoutMs || 20000);
    this.insecureTls = String(minioConfig.insecureTls || "") === "1";
  }

  keyFor(sha256) {
    const base = sha256.slice(0, 2) + "/" + sha256.slice(2, 4) + "/" + sha256;
    return this.prefix ? this.prefix + "/" + base : base;
  }

  objectPath(key) {
    const encodedBucket = encodeURIComponent(this.bucket);
    const encodedKey = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return "/" + encodedBucket + "/" + encodedKey;
  }

  bucketPath() {
    return "/" + encodeURIComponent(this.bucket);
  }

  async #request(method, path, { body, query, payloadHash, contentType } = {}) {
    const hash = payloadHash || sha256Hex(body || Buffer.alloc(0));
    const headers = {};
    if (contentType) headers["content-type"] = contentType;
    if (body) headers["content-length"] = String(body.length);
    const signed = signRequest({
      method,
      path,
      query: query || {},
      headers,
      payloadHash: hash,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      region: this.region,
    });
    const url = new URL(this.endpoint.toString());
    url.pathname = path;
    if (signed.canonicalQuery) url.search = signed.canonicalQuery;
    return requestBuffer(url, { method, headers: signed.headers, body, timeoutMs: this.timeoutMs, insecureTls: this.insecureTls });
  }

  async init() {
    const head = await this.#request("HEAD", this.bucketPath());
    if (head.status === 200) return { created: false, bucket: this.bucket };
    if (head.status === 404) {
      const put = await this.#request("PUT", this.bucketPath());
      if (put.status !== 200 && put.status !== 201 && put.status !== 204) {
        throw new Error("minio bucket create failed: HTTP " + put.status);
      }
      return { created: true, bucket: this.bucket };
    }
    throw new Error("minio bucket probe failed: HTTP " + head.status);
  }

  async has(sha256) {
    const response = await this.#request("HEAD", this.objectPath(this.keyFor(sha256)));
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw new Error("minio HEAD failed: HTTP " + response.status);
  }

  async stat(sha256) {
    const response = await this.#request("HEAD", this.objectPath(this.keyFor(sha256)));
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error("minio HEAD failed: HTTP " + response.status);
    return { sha256, key: this.keyFor(sha256), sizeBytes: Number(response.headers["content-length"] || 0) };
  }

  async putFile(sha256, sourcePath) {
    const buffer = await fsp.readFile(sourcePath);
    const digest = sha256Hex(buffer);
    if (digest !== sha256) throw new Error("object hash mismatch for " + sourcePath + ": expected " + sha256 + " got " + digest);
    return this.putBuffer(sha256, buffer);
  }

  async putBuffer(sha256, buffer) {
    const digest = sha256Hex(buffer);
    if (digest !== sha256) throw new Error("object hash mismatch: expected " + sha256 + " got " + digest);
    const response = await this.#request("PUT", this.objectPath(this.keyFor(sha256)), {
      body: buffer,
      payloadHash: sha256,
      contentType: "application/octet-stream",
    });
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      throw new Error("minio PUT failed: HTTP " + response.status);
    }
    return { created: true, sha256, key: this.keyFor(sha256), sizeBytes: buffer.length };
  }

  async readBuffer(sha256) {
    const response = await this.#request("GET", this.objectPath(this.keyFor(sha256)));
    if (response.status === 404) throw new Error("object not found in minio: " + sha256);
    if (response.status !== 200) throw new Error("minio GET failed: HTTP " + response.status);
    const digest = sha256Hex(response.body);
    if (digest !== sha256) throw new Error("minio object hash mismatch: expected " + sha256 + " got " + digest);
    return response.body;
  }

  async delete(sha256) {
    const response = await this.#request("DELETE", this.objectPath(this.keyFor(sha256)));
    if (response.status === 204 || response.status === 200) return true;
    if (response.status === 404) return false;
    throw new Error("minio DELETE failed: HTTP " + response.status);
  }

  async health() {
    try {
      const response = await this.#request("HEAD", this.bucketPath());
      return { driver: this.driver, ok: response.status === 200, bucket: this.bucket, endpoint: this.endpoint.origin };
    } catch (error) {
      return { driver: this.driver, ok: false, error: String(error && error.message ? error.message : error) };
    }
  }
}
