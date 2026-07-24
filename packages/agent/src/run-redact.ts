/**
 * Operator-safe error / summary redaction (no secrets, no [object Object]).
 */

const MAX_SUMMARY = 400;
const MAX_ERROR = 500;
const MAX_DEEP_DEPTH = 10;

/** Shared secret / credential / path patterns for operator-facing strings. */
export function redactSensitiveText(text: string): string {
  return text
    // Allow hyphens in key material (e.g. sk-proj-..., sk-svcacct-...).
    .replace(/\bsk-[a-zA-Z0-9-]{6,}\b/g, "[redacted-key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "api_key=[redacted]")
    // user:pass@host credentials in URLs
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[redacted]:[redacted]@")
    // Absolute unix home/system paths that commonly leak from provider/runtime errors
    .replace(
      /(?:^|[\s"'`=(])(\/(?:home|Users|tmp|var|private|opt|root)\/[^\s"'`)]+)/g,
      (match, pathPart: string) => match.replace(pathPart, "[redacted-path]"),
    )
    // Windows absolute paths
    .replace(/\b[A-Za-z]:\\[^\s"']+/g, "[redacted-path]");
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

/** Redact obvious secrets and collapse whitespace for UI summaries. */
export function sanitizeSummary(raw: unknown, max = MAX_SUMMARY): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
  }
  text = redactSensitiveText(text).replace(/\s+/g, " ").trim();
  if (!text) {
    return undefined;
  }
  return truncate(text, max);
}

/**
 * Coerce unknown errors to a short operator-safe string.
 * Never return "[object Object]" — that is not actionable in Session UI.
 */
export function redactErrorMessage(error: unknown): string {
  let raw: string;
  if (error instanceof Error) {
    raw = error.message || error.name || "Error";
  } else if (typeof error === "string") {
    raw = error;
  } else if (error === null || error === undefined) {
    raw = "unknown error";
  } else if (typeof error === "object") {
    const o = error as Record<string, unknown>;
    // Prefer common error envelopes over JSON of the whole object.
    if (typeof o.message === "string" && o.message.trim()) {
      raw = o.message;
    } else if (typeof o.error === "string" && o.error.trim()) {
      raw = o.error;
    } else if (o.error instanceof Error) {
      raw = o.error.message;
    } else if (typeof o.cause === "string" && o.cause.trim()) {
      raw = o.cause;
    } else {
      try {
        raw = JSON.stringify(error);
      } catch {
        raw = "unserializable error";
      }
    }
  } else {
    raw = String(error);
  }
  if (raw === "[object Object]") {
    raw = "workflow failed (no message)";
  }
  return redactSensitiveText(raw).slice(0, MAX_ERROR);
}

/**
 * Deep-clone and redact string leaves that match secret/credential/path patterns.
 * Used for operator-facing SSE payloads and history snapshots — never mutates input.
 */
export function redactSensitiveValue<T>(value: T, depth = MAX_DEEP_DEPTH): T {
  if (depth < 0) return value;
  if (typeof value === "string") {
    return redactSensitiveText(value) as T;
  }
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry, depth - 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactSensitiveValue(entry, depth - 1);
  }
  return out as T;
}
