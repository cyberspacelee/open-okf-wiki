/**
 * Operator-safe error string coercion (no secrets, no [object Object]).
 */

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
  return raw
    // Allow hyphens in key material (e.g. sk-proj-..., sk-svcacct-...).
    .replace(/\bsk-[a-zA-Z0-9-]{10,}\b/g, "[redacted-key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "api_key=[redacted]")
    .slice(0, 500);
}
