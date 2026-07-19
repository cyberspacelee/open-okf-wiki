import type { IncomingMessage, ServerResponse } from "node:http";

/** Vite (and similar) on loopback. */
const LOOPBACK_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

/**
 * Private / link-local HTTP origins (LAN). Only used when
 * `OKF_WIKI_ALLOW_LAN=1` so the API is not open to arbitrary sites by default.
 */
const PRIVATE_LAN_ORIGIN_RE =
  /^http:\/\/((10\.\d{1,3}\.\d{1,3}\.\d{1,3})|(192\.168\.\d{1,3}\.\d{1,3})|(172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})|(\[[0-9a-fA-F:]+\])):\d+$/;

export function isLanAccessEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.OKF_WIKI_ALLOW_LAN ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function isAllowedCorsOrigin(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (LOOPBACK_ORIGIN_RE.test(origin)) {
    return true;
  }
  if (isLanAccessEnabled(env) && PRIVATE_LAN_ORIGIN_RE.test(origin)) {
    return true;
  }
  return false;
}

export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && isAllowedCorsOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, error: string, details?: unknown): void {
  sendJson(res, status, details === undefined ? { error } : { error, details });
}

export async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limitBytes) {
      throw new BodyTooLargeError(`body exceeds ${limitBytes} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InvalidJsonError("invalid JSON body");
  }
}

export class InvalidJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonError";
  }
}

export class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

export function matchRoute(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const pathParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  if (pathParts.length !== patternParts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i]!;
    const actual = pathParts[i]!;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}
