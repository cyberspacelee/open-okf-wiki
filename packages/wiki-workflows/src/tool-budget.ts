/** Default caps for workflow child-agent tool results (token pressure control). */
export const TOOL_RESULT_MAX_LINES = 400;
export const TOOL_RESULT_MAX_BYTES = 48 * 1024;
export const TOOL_RESULT_MAX_MATCH_LINES = 80;

/**
 * Bound a tool result's text so survey/research transcripts cannot explode the
 * context window. Keeps head + tail when truncating.
 */
export function boundToolResultText(
  text: string,
  options: { maxLines?: number; maxBytes?: number; label?: string } = {},
): { text: string; truncated: boolean } {
  const maxLines = options.maxLines ?? TOOL_RESULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? TOOL_RESULT_MAX_BYTES;
  const label = options.label ?? "output";
  const lines = text.split("\n");
  let truncated = false;
  let next = text;

  if (lines.length > maxLines) {
    const headCount = Math.max(1, Math.floor(maxLines * 0.7));
    const tailCount = Math.max(1, maxLines - headCount - 1);
    const omitted = lines.length - headCount - tailCount;
    next = [
      ...lines.slice(0, headCount),
      `... [${omitted} ${label} lines omitted; narrow the path or pattern] ...`,
      ...lines.slice(-tailCount),
    ].join("\n");
    truncated = true;
  }

  if (Buffer.byteLength(next, "utf8") > maxBytes) {
    const encoded = Buffer.from(next, "utf8");
    const headBytes = Math.floor(maxBytes * 0.7);
    const tailBytes = Math.max(0, maxBytes - headBytes - 80);
    const head = encoded.subarray(0, headBytes).toString("utf8");
    const tail = tailBytes > 0 ? encoded.subarray(encoded.byteLength - tailBytes).toString("utf8") : "";
    next = `${head}\n... [truncated to ${maxBytes} bytes; re-read a smaller range] ...\n${tail}`;
    truncated = true;
  }

  return { text: next, truncated };
}

/** Apply budget to a Pi-style tool result object. */
export function boundToolExecutionResult(result: unknown, toolName: string): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as { content?: unknown; details?: unknown; terminate?: unknown };
  if (!Array.isArray(record.content)) return result;
  const maxLines = toolName === "grep" || toolName === "find" || toolName === "ls"
    ? TOOL_RESULT_MAX_MATCH_LINES
    : TOOL_RESULT_MAX_LINES;
  let changed = false;
  const content = record.content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string") return part;
    const bounded = boundToolResultText(block.text, { maxLines, label: toolName });
    if (!bounded.truncated) return part;
    changed = true;
    return { ...block, text: bounded.text };
  });
  if (!changed) return result;
  return { ...record, content };
}
