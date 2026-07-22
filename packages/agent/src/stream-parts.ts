/**
 * Shared redaction helpers for operator-facing strings.
 */

const MAX_SUMMARY = 400;

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
  text = text
    .replace(/\bsk-[a-zA-Z0-9-]{10,}\b/g, "[redacted-key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "api_key=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return undefined;
  }
  return truncate(text, max);
}
