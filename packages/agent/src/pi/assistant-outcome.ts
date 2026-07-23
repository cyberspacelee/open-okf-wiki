/**
 * Read the last assistant turn outcome from a Pi session message list.
 * Pi often completes prompt() without throwing when stopReason is "error".
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
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

function thinkingFromContent(content: unknown): string {
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

export type AssistantOutcome = {
  text: string;
  thinking: string;
  isError: boolean;
  errorMessage?: string;
  stopReason?: string;
};

/**
 * Scan messages newest-first for the last assistant row and extract text/error.
 */
export function lastAssistantOutcome(messages: readonly unknown[]): AssistantOutcome | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!isRecord(msg) || msg.role !== "assistant") continue;
    const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : undefined;
    const errorMessage =
      typeof msg.errorMessage === "string" && msg.errorMessage.trim()
        ? msg.errorMessage.trim()
        : undefined;
    const isError = stopReason === "error" || stopReason === "aborted" || Boolean(errorMessage);
    return {
      text: textFromContent(msg.content),
      thinking: thinkingFromContent(msg.content),
      isError,
      errorMessage,
      stopReason,
    };
  }
  return null;
}

/** Prefer streamed text, then final content text, never invent success. */
export function resolveAssistantSummary(input: {
  streamedText: string;
  messages: readonly unknown[];
  roleLabel: string;
}): { summary: string; isError: boolean; errorMessage?: string } {
  const outcome = lastAssistantOutcome(input.messages);
  const text = input.streamedText.trim() || outcome?.text.trim() || "";
  if (outcome?.isError) {
    const errorMessage =
      outcome.errorMessage || `assistant stopReason=${outcome.stopReason ?? "error"}`;
    return {
      summary: text || errorMessage,
      isError: true,
      errorMessage,
    };
  }
  if (!text) {
    return {
      summary: `(${input.roleLabel} completed with empty summary)`,
      isError: false,
    };
  }
  return { summary: text, isError: false };
}
