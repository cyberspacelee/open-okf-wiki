/**
 * Project parent Pi events into main timeline mutations.
 * Produce bodies arrive via product work_unit (ADR 0031).
 */

import {
  compactToolInput,
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  formatToolResultText,
  isRecord,
  makeId,
  nowIso,
} from "./format.ts";
import type {
  AgentMessage,
  AgentToolCall,
  StreamCursor,
  StreamingRefs,
} from "./types.ts";

function messageRole(message: unknown): string | null {
  if (!isRecord(message) || typeof message.role !== "string") return null;
  return message.role;
}

function findMessageIndex(messages: AgentMessage[], id: string | null): number {
  if (!id) return -1;
  return messages.findIndex((m) => m.id === id);
}

function lastAssistantIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "assistant") return i;
  }
  return -1;
}

/** Last user or assistant row (ignore product/system strips). */
function lastChatIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "user" || m?.role === "assistant") return i;
  }
  return -1;
}

function ensureAssistantBubble(
  prev: AgentMessage[],
  cursor: StreamCursor,
  ts: string,
): { messages: AgentMessage[]; assistantId: string } {
  const streamingIdx = findMessageIndex(prev, cursor.streamingAssistantId);
  if (streamingIdx >= 0) {
    return { messages: prev, assistantId: prev[streamingIdx]!.id };
  }
  const lastIdx = findMessageIndex(prev, cursor.lastAssistantId);
  // Reuse the turn's assistant while streaming OR while the parent turn is
  // still open (post-tool text_delta after message_end must not open a peer).
  if (
    lastIdx >= 0 &&
    (prev[lastIdx]!.status === "streaming" || cursor.turnActive)
  ) {
    cursor.streamingAssistantId = prev[lastIdx]!.id;
    return { messages: prev, assistantId: prev[lastIdx]!.id };
  }
  const id = makeId("asst");
  cursor.streamingAssistantId = id;
  cursor.lastAssistantId = id;
  return {
    messages: [
      ...prev,
      {
        id,
        role: "assistant",
        content: "",
        createdAt: ts,
        status: "streaming",
        tools: [],
      },
    ],
    assistantId: id,
  };
}

/**
 * Merge a final segment into existing bubble content.
 * Same-segment streaming partials supersede; later turn segments append.
 */
function mergeTurnSegment(existing: string, finalText: string): string {
  if (!finalText) return existing;
  if (!existing) return finalText;
  if (existing === finalText) return existing;
  // Same segment: streaming partial replaced by full final text.
  if (finalText.startsWith(existing) || existing.startsWith(finalText)) {
    return finalText.length >= existing.length ? finalText : existing;
  }
  // Post-tool deltas already appended the segment.
  if (existing.endsWith(finalText)) return existing;
  // message_start may have left a segment boundary separator.
  if (existing.endsWith("\n\n") || existing.endsWith("\n")) {
    return existing + finalText;
  }
  return `${existing}\n\n${finalText}`;
}

function finalizeAssistantContent(input: {
  text: string;
  existing: string;
  fixtureNote?: string;
  errorMessage?: string;
  isError: boolean;
}): string {
  if (input.isError) {
    if (input.text) return input.text;
    if (input.errorMessage) return input.errorMessage;
    if (input.existing) return input.existing;
    return "";
  }
  if (input.text && input.existing) {
    return mergeTurnSegment(input.existing, input.text);
  }
  if (input.text) return input.text;
  if (input.existing) return input.existing;
  if (input.fixtureNote) return input.fixtureNote;
  return "";
}

/** Prepare bubble content when a later segment of the same turn reopens it. */
function continueTurnContent(existing: string, initial: string): string {
  if (!existing.trim()) return initial || existing;
  if (!initial) {
    return existing.endsWith("\n") ? existing : `${existing}\n\n`;
  }
  if (existing.endsWith(initial)) return existing;
  const sep = existing.endsWith("\n") ? "" : "\n\n";
  return `${existing}${sep}${initial}`;
}

/**
 * Project one Pi event into **main timeline** mutations.
 * Parent chat only — produce bodies arrive via product work_unit.
 * Mutates `refs` in place (streaming ids).
 */
export function applyPiEvent(
  prev: AgentMessage[],
  kind: string,
  payload: unknown,
  refs: StreamingRefs,
): AgentMessage[] {
  const body = isRecord(payload) ? payload : {};
  const message = "message" in body ? body.message : undefined;
  const role = messageRole(message);
  const ts = nowIso();
  const cursor = refs;

  // --- message_update: stream text / thinking into the current assistant ----
  if (kind === "message_update") {
    // Only assistant messages stream; ignore anything else.
    if (role && role !== "assistant") return prev;

    // Same-turn replay onto a completed hist_* assistant: ignore stream deltas.
    if (
      cursor.turnActive &&
      cursor.lastAssistantId &&
      !cursor.streamingAssistantId
    ) {
      const idx = findMessageIndex(prev, cursor.lastAssistantId);
      if (
        idx >= 0 &&
        (prev[idx]!.status === "done" || prev[idx]!.status === "error")
      ) {
        return prev;
      }
    }

    const ame = isRecord(body.assistantMessageEvent)
      ? body.assistantMessageEvent
      : null;

    if (ame?.type === "text_delta" && typeof ame.delta === "string") {
      const delta = ame.delta;
      const ensured = ensureAssistantBubble(prev, cursor, ts);
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? {
              ...m,
              content: m.content + delta,
              status: "streaming",
            }
          : m,
      );
    }

    if (ame?.type === "thinking_start") {
      const ensured = ensureAssistantBubble(prev, cursor, ts);
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? {
              ...m,
              thinking: m.thinking ?? "",
              thinkingStatus: "streaming" as const,
              status: "streaming",
            }
          : m,
      );
    }

    if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
      const delta = ame.delta;
      const ensured = ensureAssistantBubble(prev, cursor, ts);
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? {
              ...m,
              thinking: (m.thinking ?? "") + delta,
              thinkingStatus: "streaming" as const,
              status: "streaming",
            }
          : m,
      );
    }

    if (ame?.type === "thinking_end") {
      const ensured = ensureAssistantBubble(prev, cursor, ts);
      const endContent =
        typeof ame.content === "string" ? ame.content : undefined;
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? {
              ...m,
              thinking:
                endContent && endContent.length > 0
                  ? endContent
                  : (m.thinking ?? ""),
              thinkingStatus: "done" as const,
              status: "streaming",
            }
          : m,
      );
    }

    // Snapshot path (pi-web style): replace content from partial message.
    // Only when there is no typed delta event — never append on top of deltas
    // (that would double text/thinking when providers send full snapshots).
    if (message && !ame) {
      const text = extractMessageText(message);
      const thinking = extractMessageThinking(message);
      if (
        text.length === 0 &&
        thinking.length === 0 &&
        !cursor.streamingAssistantId
      ) {
        return prev;
      }
      const ensured = ensureAssistantBubble(prev, cursor, ts);
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? {
              ...m,
              // Replace (not append) — snapshot is the full partial message.
              content: text.length > 0 ? text : m.content,
              thinking: thinking.length > 0 ? thinking : m.thinking,
              thinkingStatus:
                thinking.length > 0
                  ? ("streaming" as const)
                  : m.thinkingStatus,
              status: "streaming",
            }
          : m,
      );
    }
    return prev;
  }

  // --- message_start --------------------------------------------------------
  if (kind === "message_start") {
    // User prompts are optimistic on the client; never invent a bubble.
    if (role === "user") return prev;
    // Tool results are mirrored via tool_execution_*; skip empty cards.
    if (role === "toolResult" || role === "tool") return prev;

    const initial = extractMessageText(message);
    const thinking = extractMessageThinking(message);
    const err = extractAssistantError(message);
    const isError = err.isError;

    // Reuse an in-flight assistant bubble (e.g. early thinking_delta opened one
    // via ensureAssistantBubble before message_start). Creating a second card
    // here is what users see as duplicated thinking + answer after the turn.
    //
    // Within an active parent turn (agent_start … agent_end), always reuse the
    // turn's last assistant — pre-tool and post-tool text share one bubble so
    // tool loops do not project multi-card mid-stream (Pi TUI aligned).
    let reuseId: string | null = null;
    const streamingIdx = findMessageIndex(prev, cursor.streamingAssistantId);
    if (streamingIdx >= 0) {
      reuseId = prev[streamingIdx]!.id;
    } else {
      const lastIdx = findMessageIndex(prev, cursor.lastAssistantId);
      if (lastIdx >= 0) {
        const last = prev[lastIdx]!;
        if (cursor.turnActive) {
          reuseId = last.id;
        } else {
          // Outside a known turn: only reuse empty/streaming shells or when
          // tools are still nesting (legacy / missing agent_start).
          const toolsRunning = last.tools?.some(
            (t) => t.status === "running" || t.status === "pending",
          );
          if (
            last.status === "streaming" ||
            (toolsRunning &&
              !last.content?.trim() &&
              !last.thinking?.trim())
          ) {
            reuseId = last.id;
          }
        }
      }
    }

    // Replay guard: cold JSONL already has a completed assistant as the last
    // chat row; ring-buffer re-sends the same turn after agent_start cleared
    // cursors. Live multi-turn always inserts a user row after the prior asst
    // (optimistic send), so a trailing done-assistant means "replay, not turn 2".
    if (!reuseId && cursor.turnActive) {
      const chatIdx = lastChatIndex(prev);
      if (chatIdx >= 0) {
        const lastChat = prev[chatIdx]!;
        if (
          lastChat.role === "assistant" &&
          (lastChat.status === "done" || lastChat.status === "error")
        ) {
          // Point cursors at hist_* but leave status done and body untouched.
          // streamingAssistantId stays null so message_update also no-ops.
          cursor.streamingAssistantId = null;
          cursor.lastAssistantId = lastChat.id;
          return prev;
        }
      }
    }

    if (reuseId) {
      cursor.streamingAssistantId = reuseId;
      cursor.lastAssistantId = reuseId;
      return prev.map((m) => {
        if (m.id !== reuseId) return m;
        const continuing =
          cursor.turnActive &&
          Boolean(m.content?.trim()) &&
          m.status !== "streaming" &&
          !isError;
        return {
          ...m,
          content: isError
            ? finalizeAssistantContent({
                text: initial,
                existing: m.content,
                errorMessage: err.errorMessage,
                isError: true,
              })
            : continuing
              ? continueTurnContent(m.content, initial)
              : initial || m.content,
          thinking: thinking || m.thinking,
          thinkingStatus: thinking
            ? isError
              ? ("done" as const)
              : ("streaming" as const)
            : m.thinkingStatus,
          status: isError ? "error" : "streaming",
          errorMessage: err.errorMessage ?? m.errorMessage,
          tools: m.tools ?? [],
        };
      });
    }

    // Assistant (or unknown role with assistant-shaped content): new bubble.
    const id = makeId("asst");
    cursor.streamingAssistantId = id;
    cursor.lastAssistantId = id;
    return [
      ...prev,
      {
        id,
        role: "assistant",
        content: isError
          ? finalizeAssistantContent({
              text: initial,
              existing: "",
              errorMessage: err.errorMessage,
              isError: true,
            })
          : initial,
        thinking: thinking || undefined,
        thinkingStatus: thinking
          ? isError
            ? ("done" as const)
            : ("streaming" as const)
          : undefined,
        createdAt: ts,
        status: isError ? "error" : "streaming",
        errorMessage: err.errorMessage,
        tools: [],
      },
    ];
  }

  // --- message_end ----------------------------------------------------------
  if (kind === "message_end") {
    if (role === "user") {
      // Do not touch streaming ids — user end is not an assistant boundary
      // that should orphan the next tool batch (those attach to lastAssistant).
      return prev;
    }
    if (role === "toolResult" || role === "tool") {
      return prev;
    }

    // Replay onto completed hist_*: keep body, just clear streaming cursor.
    if (
      cursor.turnActive &&
      cursor.lastAssistantId &&
      !cursor.streamingAssistantId
    ) {
      const idx = findMessageIndex(prev, cursor.lastAssistantId);
      if (
        idx >= 0 &&
        (prev[idx]!.status === "done" || prev[idx]!.status === "error")
      ) {
        return prev;
      }
    }

    // Fixture mode: server emits note without prior streaming deltas.
    const fixtureNote =
      typeof body.note === "string"
        ? body.note
        : typeof body.mode === "string" && body.mode === "fixture"
          ? "fixture mode — prompt recorded (no LLM)"
          : undefined;

    const finalText = extractMessageText(message);
    const finalThinking = extractMessageThinking(message);
    const err = extractAssistantError(message);
    const isError = err.isError;
    const status = isError ? "error" : "done";

    // Prefer the streaming cursor; fall back to lastAssistant so that
    // agent_end/agent_settled (which clear streamingAssistantId) or a
    // duplicate message_end cannot invent a second thinking+answer card.
    let id = cursor.streamingAssistantId;
    if (!id || findMessageIndex(prev, id) < 0) {
      id = cursor.lastAssistantId;
    }
    if (!id || findMessageIndex(prev, id) < 0) {
      const idx = lastAssistantIndex(prev);
      if (idx >= 0) id = prev[idx]!.id;
    }

    const targetIdx = id ? findMessageIndex(prev, id) : -1;
    if (targetIdx >= 0) {
      const existing = prev[targetIdx]!;
      // Fixture-only ends (no LLM message body) after a settled turn must open a
      // new card — otherwise turn 2 would rewrite the previous assistant.
      const fixtureOnlyOnSettled =
        Boolean(fixtureNote) &&
        !finalText &&
        !finalThinking &&
        !isError &&
        existing.status !== "streaming";

      if (!fixtureOnlyOnSettled) {
        cursor.streamingAssistantId = null;
        cursor.lastAssistantId = existing.id;
        // Keep lastAssistantId so tools that arrive after message_end still nest.
        return prev.map((m) => {
          if (m.id !== existing.id) return m;
          const content = finalizeAssistantContent({
            text: finalText,
            existing: m.content,
            fixtureNote,
            errorMessage: err.errorMessage,
            isError,
          });
          const thinking = finalThinking || m.thinking || undefined;
          return {
            ...m,
            content,
            thinking,
            thinkingStatus: thinking ? ("done" as const) : m.thinkingStatus,
            status,
            errorMessage: err.errorMessage ?? m.errorMessage,
          };
        });
      }
    }

    if (fixtureNote || finalText || finalThinking || isError) {
      const newId = makeId("asst");
      cursor.lastAssistantId = newId;
      cursor.streamingAssistantId = null;
      const content = finalizeAssistantContent({
        text: finalText,
        existing: "",
        fixtureNote,
        errorMessage: err.errorMessage,
        isError,
      });
      return [
        ...prev,
        {
          id: newId,
          role: "assistant",
          content,
          thinking: finalThinking || undefined,
          thinkingStatus: finalThinking ? ("done" as const) : undefined,
          createdAt: ts,
          status,
          errorMessage: err.errorMessage,
        },
      ];
    }
    return prev;
  }

  // --- tool_execution_start -------------------------------------------------
  if (kind === "tool_execution_start") {
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : makeId("tool");
    const toolName =
      typeof body.toolName === "string" ? body.toolName : "tool";
    const input = compactToolInput(body.args);
    const tool: AgentToolCall = {
      id: toolCallId,
      name: toolName,
      input,
      status: "running",
    };

    // Prefer streaming assistant, then last assistant, then create once.
    let assistantId = cursor.streamingAssistantId;
    if (!assistantId || findMessageIndex(prev, assistantId) < 0) {
      assistantId = cursor.lastAssistantId;
    }
    if (!assistantId || findMessageIndex(prev, assistantId) < 0) {
      const idx = lastAssistantIndex(prev);
      if (idx >= 0) assistantId = prev[idx]!.id;
    }

    if (!assistantId || findMessageIndex(prev, assistantId) < 0) {
      // No assistant yet (tool-only edge case) — open one bubble.
      const ensured = ensureAssistantBubble(prev, cursor, ts);
      return ensured.messages.map((m) =>
        m.id === ensured.assistantId
          ? {
              ...m,
              tools: [tool],
              status: "streaming",
            }
          : m,
      );
    }

    cursor.lastAssistantId = assistantId;
    return prev.map((m) => {
      if (m.id !== assistantId) return m;
      const tools = [...(m.tools ?? [])];
      const idx = tools.findIndex((t) => t.id === toolCallId);
      if (idx >= 0) {
        tools[idx] = { ...tools[idx], ...tool };
      } else {
        tools.push(tool);
      }
      return {
        ...m,
        tools,
      };
    });
  }

  if (kind === "tool_execution_update") {
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return prev;
    const partial = formatToolResultText(body.partialResult);
    return prev.map((m) => {
      if (!m.tools?.some((t) => t.id === toolCallId)) return m;
      return {
        ...m,
        tools: m.tools.map((t) =>
          t.id === toolCallId
            ? { ...t, output: partial ?? t.output, status: "running" as const }
            : t,
        ),
      };
    });
  }

  if (kind === "tool_execution_end") {
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return prev;
    const output = formatToolResultText(body.result);
    const isError = body.isError === true;
    return prev.map((m) => {
      if (!m.tools?.some((t) => t.id === toolCallId)) return m;
      return {
        ...m,
        tools: m.tools.map((t) =>
          t.id === toolCallId
            ? {
                ...t,
                output: output ?? t.output,
                status: isError ? ("error" as const) : ("done" as const),
              }
            : t,
        ),
      };
    });
  }

  if (kind === "error") {
    const errMessage =
      typeof body.message === "string" ? body.message : "Agent error";
    // Dedupe: assistant bubble already carries the same provider error.
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      const m = prev[i]!;
      if (m.role === "assistant") {
        if (
          m.status === "error" &&
          (m.errorMessage === errMessage || m.content === errMessage)
        ) {
          return prev;
        }
        break;
      }
      if (m.role === "system" && m.status === "error" && m.content === errMessage) {
        return prev;
      }
    }
    return [
      ...prev,
      {
        id: makeId("sys"),
        role: "system",
        content: errMessage,
        createdAt: ts,
        status: "error",
        errorMessage: errMessage,
      },
    ];
  }

  if (kind === "agent_end" || kind === "agent_settled") {
    // End the turn; leave lastAssistant for late tools / late message_end.
    // Do not clobber status "error" on failed assistant turns.
    cursor.streamingAssistantId = null;
    cursor.turnActive = false;
    return prev.map((m) => {
      if (m.status !== "streaming") return m;
      return { ...m, status: "done" };
    });
  }

  if (kind === "agent_start") {
    // New parent turn: do not reuse the previous turn's assistant bubble.
    // Clear lastAssistant so the first message_start of this turn opens a card;
    // late tools from the prior turn already attached before this event.
    cursor.turnActive = true;
    cursor.streamingAssistantId = null;
    cursor.lastAssistantId = null;
    return prev;
  }

  // prompt / session_ready / turn_* — no transcript rows.
  return prev;
}
