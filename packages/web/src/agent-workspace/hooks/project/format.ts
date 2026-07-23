/**
 * String / message extractors for projection surfaces.
 */

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function safeStringify(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract plain text from a Pi assistant/user message content array or string. */
export function extractMessageText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/** Extract thinking blocks from a Pi assistant message content array. */
export function extractMessageThinking(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts.join("");
}

/**
 * Pi assistant error fields (stopReason + errorMessage).
 * Used when the provider fails without throwing from session.prompt().
 */
export function extractAssistantError(message: unknown): {
  isError: boolean;
  errorMessage?: string;
  stopReason?: string;
} {
  if (!isRecord(message)) return { isError: false };
  const stopReason =
    typeof message.stopReason === "string" ? message.stopReason : undefined;
  const errorMessage =
    typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : undefined;
  const isError =
    stopReason === "error" ||
    stopReason === "aborted" ||
    Boolean(errorMessage);
  return { isError, errorMessage, stopReason };
}

/** Default cap for tool / payload surfaces (pretty JSON can grow fast). */
export const PAYLOAD_TEXT_MAX = 12_000;

/**
 * Pretty-print complete JSON object/array strings for tool / payload surfaces.
 * Incomplete or non-JSON text is returned as-is. Overlong results are truncated
 * with a clear marker (avoids crushing the layout with multi-MB blobs).
 */
export function formatPayloadText(
  raw: string | undefined,
  max = PAYLOAD_TEXT_MAX,
): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  let out = raw;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      out = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // keep original (incomplete stream, non-JSON braces, etc.)
    }
  }
  if (max > 0 && out.length > max) {
    const omitted = out.length - max;
    return `${out.slice(0, max)}\n…[truncated ${omitted} chars]`;
  }
  return out;
}
