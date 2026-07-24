/** Pi-native Operator Session projector (ADR 0032). */

import { type WikiProduceToolDetails, WikiProduceToolDetailsSchema } from "@okf-wiki/contract";
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
  AgentContentPart,
  AgentMessage,
  AgentSseLike,
  AgentToolCall,
  PiStreamState,
} from "./types.ts";

export function createPiStreamState(seed: AgentMessage[] = []): PiStreamState {
  let lastAssistantId: string | null = null;
  for (let i = seed.length - 1; i >= 0; i -= 1) {
    if (seed[i]?.role === "assistant") {
      lastAssistantId = seed[i]!.id;
      break;
    }
  }
  return {
    messages: seed.slice(),
    streamingMessage: null,
    lastAssistantId,
    turnActive: false,
  };
}

/** Finalized rows + optional streaming tail (UI timeline). */
export function viewMessages(state: PiStreamState): AgentMessage[] {
  if (!state.streamingMessage) return state.messages;
  return [...state.messages, state.streamingMessage];
}

function messageRole(message: unknown): string | null {
  if (!isRecord(message) || typeof message.role !== "string") return null;
  return message.role;
}

function wikiProduceDetails(value: unknown): WikiProduceToolDetails | undefined {
  if (!isRecord(value) || !isRecord(value.details)) return undefined;
  const parsed = WikiProduceToolDetailsSchema.safeParse(value.details);
  return parsed.success ? parsed.data : undefined;
}

function findMessageIndex(messages: AgentMessage[], id: string | null): number {
  if (!id) return -1;
  return messages.findIndex((m) => m.id === id);
}

/** toolCall blocks from a Pi assistant content array. */
function extractToolCallsFromMessage(
  message: unknown,
  prevTools?: AgentToolCall[],
): AgentToolCall[] | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return prevTools;
  }
  const prevById = new Map((prevTools ?? []).map((t) => [t.id, t]));
  const tools: AgentToolCall[] = [];
  const seen = new Set<string>();
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    const id = typeof block.id === "string" ? block.id : makeId("tool");
    const name = typeof block.name === "string" ? block.name : "tool";
    const prev = prevById.get(id);
    const args = "arguments" in block ? block.arguments : "args" in block ? block.args : undefined;
    tools.push({
      id,
      name,
      input: compactToolInput(args) ?? prev?.input,
      output: prev?.output,
      ...(prev?.details ? { details: prev.details } : {}),
      status: prev?.status ?? "pending",
    });
    seen.add(id);
  }
  // Keep tools that only arrived via tool_execution_* (not yet in content).
  for (const t of prevTools ?? []) {
    if (!seen.has(t.id)) tools.push(t);
  }
  return tools.length > 0 ? tools : prevTools;
}

/**
 * Build chronological parts from Pi content[] (text / thinking / toolCall order).
 * Tools that only exist via tool_execution_* (not yet in content) append at end.
 */
function extractPartsFromMessage(
  message: unknown,
  tools: AgentToolCall[] | undefined,
  prevParts?: AgentContentPart[],
): AgentContentPart[] | undefined {
  const parts: AgentContentPart[] = [];
  if (isRecord(message) && Array.isArray(message.content)) {
    let textBuf = "";
    let thinkingBuf = "";
    const flushText = () => {
      if (textBuf) {
        parts.push({ type: "text", text: textBuf });
        textBuf = "";
      }
    };
    const flushThinking = () => {
      if (thinkingBuf) {
        parts.push({ type: "thinking", thinking: thinkingBuf });
        thinkingBuf = "";
      }
    };
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        flushText();
        thinkingBuf += block.thinking;
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        flushThinking();
        textBuf += block.text;
        continue;
      }
      if (block.type === "toolCall") {
        flushText();
        flushThinking();
        const id = typeof block.id === "string" ? block.id : makeId("tool");
        parts.push({ type: "tool", toolId: id });
      }
    }
    flushText();
    flushThinking();
  }

  // Preserve tools that only arrived via tool_execution_* (append if missing).
  const seenTool = new Set(
    parts
      .filter((p): p is { type: "tool"; toolId: string } => p.type === "tool")
      .map((p) => p.toolId),
  );
  for (const t of tools ?? []) {
    if (!seenTool.has(t.id)) {
      parts.push({ type: "tool", toolId: t.id });
      seenTool.add(t.id);
    }
  }

  // If snapshot had no content array but we had prior parts, keep prior structure
  // and merge new tool ids (tool_execution before content toolCall block).
  if (parts.length === 0 && prevParts?.length) {
    const merged = prevParts.slice();
    const priorToolIds = new Set(
      merged
        .filter((p): p is { type: "tool"; toolId: string } => p.type === "tool")
        .map((p) => p.toolId),
    );
    for (const t of tools ?? []) {
      if (!priorToolIds.has(t.id)) {
        merged.push({ type: "tool", toolId: t.id });
        priorToolIds.add(t.id);
      }
    }
    return merged;
  }

  return parts.length > 0 ? parts : undefined;
}

/**
 * Build thin AgentMessage from a Pi assistant message snapshot.
 * Snapshot is authority for text/thinking/toolCall list; prior tools keep
 * execution status/output. `parts` preserves content[] interleaving.
 */
function assistantFromSnapshot(
  message: unknown,
  opts: {
    id: string;
    prev?: AgentMessage | null;
    status: "streaming" | "done" | "error";
    ts: string;
  },
): AgentMessage {
  const text = extractMessageText(message);
  const thinking = extractMessageThinking(message);
  const err = extractAssistantError(message);
  const isError = err.isError || opts.status === "error";
  const tools = extractToolCallsFromMessage(message, opts.prev?.tools);
  const parts = extractPartsFromMessage(message, tools, opts.prev?.parts);

  let thinkingStatus = opts.prev?.thinkingStatus;
  if (thinking) {
    thinkingStatus = opts.status === "streaming" ? "streaming" : "done";
  } else if (opts.status !== "streaming") {
    thinkingStatus = thinkingStatus === "streaming" ? "done" : thinkingStatus;
  }

  return {
    id: opts.id,
    role: "assistant",
    content:
      text ||
      (isError ? (err.errorMessage ?? opts.prev?.content ?? "") : (opts.prev?.content ?? "")),
    thinking: thinking || opts.prev?.thinking,
    thinkingStatus: thinking ? thinkingStatus : opts.prev?.thinkingStatus,
    createdAt: opts.prev?.createdAt ?? opts.ts,
    tools,
    parts,
    status: isError ? "error" : opts.status,
    errorMessage: err.errorMessage ?? opts.prev?.errorMessage,
  };
}

function patchToolsOnAssistant(
  msg: AgentMessage,
  toolCallId: string,
  patch: Partial<AgentToolCall> & { name?: string },
): AgentMessage {
  const tools = [...(msg.tools ?? [])];
  const idx = tools.findIndex((t) => t.id === toolCallId);
  if (idx >= 0) {
    tools[idx] = { ...tools[idx]!, ...patch, id: toolCallId };
  } else {
    tools.push({
      id: toolCallId,
      name: patch.name ?? "tool",
      input: patch.input,
      output: patch.output,
      status: patch.status ?? "running",
    });
  }
  // Keep parts in chronological order: add tool part if missing.
  let parts = msg.parts?.slice();
  if (parts) {
    const has = parts.some((p) => p.type === "tool" && p.toolId === toolCallId);
    if (!has) parts = [...parts, { type: "tool", toolId: toolCallId }];
  } else {
    parts = [{ type: "tool", toolId: toolCallId }];
  }
  return { ...msg, tools, parts };
}

function updateToolInState(
  state: PiStreamState,
  toolCallId: string,
  patch: Partial<AgentToolCall> & { name?: string },
): PiStreamState {
  // Prefer streaming assistant, then last finalized assistant.
  if (state.streamingMessage) {
    return {
      ...state,
      streamingMessage: patchToolsOnAssistant(state.streamingMessage, toolCallId, patch),
    };
  }
  const idx = findMessageIndex(state.messages, state.lastAssistantId);
  if (idx >= 0 && state.messages[idx]!.role === "assistant") {
    const next = state.messages.slice();
    next[idx] = patchToolsOnAssistant(next[idx]!, toolCallId, patch);
    return { ...state, messages: next };
  }
  // No assistant yet — open a streaming shell for the tool.
  const id = makeId("asst");
  const shell: AgentMessage = {
    id,
    role: "assistant",
    content: "",
    createdAt: nowIso(),
    status: "streaming",
    tools: [
      {
        id: toolCallId,
        name: patch.name ?? "tool",
        input: patch.input,
        output: patch.output,
        status: patch.status ?? "running",
      },
    ],
  };
  return {
    ...state,
    streamingMessage: shell,
    lastAssistantId: id,
  };
}

/**
 * Reduce one parent Pi event into stream state (snapshot authority).
 * Pure: returns a new state object (streamingMessage may share tool arrays).
 */
export function reducePiEvent(state: PiStreamState, kind: string, payload: unknown): PiStreamState {
  const body = isRecord(payload) ? payload : {};
  const message = "message" in body ? body.message : undefined;
  const role = messageRole(message);
  const ts = nowIso();

  // --- message_update: replace streaming from full message snapshot ---------
  if (kind === "message_update") {
    if (role && role !== "assistant") return state;

    if (!message) return state;

    const text = extractMessageText(message);
    const thinking = extractMessageThinking(message);
    const hasToolCalls =
      isRecord(message) &&
      Array.isArray(message.content) &&
      message.content.some((b) => isRecord(b) && b.type === "toolCall");

    // Empty snapshot with no open stream — wait (do not invent thinking chrome).
    if (!text && !thinking && !hasToolCalls && !state.streamingMessage) {
      return state;
    }

    const id = state.streamingMessage?.id ?? makeId("asst");
    const next = assistantFromSnapshot(message, {
      id,
      prev: state.streamingMessage,
      status: "streaming",
      ts,
    });
    return {
      ...state,
      streamingMessage: next,
      lastAssistantId: id,
    };
  }

  // --- message_start --------------------------------------------------------
  if (kind === "message_start") {
    if (role === "user") return state;
    if (role === "toolResult" || role === "tool") return state;

    // Reuse open streaming shell (e.g. tool opened one early).
    if (state.streamingMessage) {
      if (!message) return state;
      const next = assistantFromSnapshot(message, {
        id: state.streamingMessage.id,
        prev: state.streamingMessage,
        status: "streaming",
        ts,
      });
      return { ...state, streamingMessage: next, lastAssistantId: next.id };
    }

    const err = extractAssistantError(message);
    const id = makeId("asst");
    const next = assistantFromSnapshot(message ?? { role: "assistant", content: [] }, {
      id,
      prev: null,
      status: err.isError ? "error" : "streaming",
      ts,
    });
    return {
      ...state,
      streamingMessage: next,
      lastAssistantId: id,
    };
  }

  // --- message_end ----------------------------------------------------------
  if (kind === "message_end") {
    if (role === "user") return state;
    if (role === "toolResult" || role === "tool") {
      // Attach tool result text onto last assistant tool row when present.
      if (isRecord(message) && typeof message.toolCallId === "string") {
        const toolCallId = message.toolCallId;
        const output = formatToolResultText(message.content) ?? formatToolResultText(message);
        const details = wikiProduceDetails(message);
        const isError = message.isError === true;
        return updateToolInState(state, toolCallId, {
          output: output,
          ...(details ? { details } : {}),
          status: isError ? "error" : "done",
          name: typeof message.toolName === "string" ? message.toolName : undefined,
        });
      }
      return state;
    }

    const err = extractAssistantError(message);
    const isError = err.isError;
    const status = isError ? ("error" as const) : ("done" as const);

    if (state.streamingMessage) {
      const finalized = message
        ? assistantFromSnapshot(message, {
            id: state.streamingMessage.id,
            prev: state.streamingMessage,
            status,
            ts,
          })
        : {
            ...state.streamingMessage,
            status,
            thinkingStatus: state.streamingMessage.thinking
              ? ("done" as const)
              : state.streamingMessage.thinkingStatus,
          };

      return {
        ...state,
        messages: [...state.messages, finalized],
        streamingMessage: null,
        lastAssistantId: finalized.id,
      };
    }

    // No streaming shell: open from final snapshot if meaningful.
    if (message || isError) {
      const newId = makeId("asst");
      const card = message
        ? assistantFromSnapshot(message, { id: newId, prev: null, status, ts })
        : {
            id: newId,
            role: "assistant" as const,
            content: err.errorMessage ?? "",
            createdAt: ts,
            status,
            errorMessage: err.errorMessage,
          };
      return {
        ...state,
        messages: [...state.messages, card],
        streamingMessage: null,
        lastAssistantId: newId,
      };
    }
    return state;
  }

  // --- tool_execution_* -----------------------------------------------------
  if (kind === "tool_execution_start") {
    const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : makeId("tool");
    const toolName = typeof body.toolName === "string" ? body.toolName : "tool";
    const input = compactToolInput(body.args);
    return updateToolInState(state, toolCallId, {
      name: toolName,
      input,
      status: "running",
    });
  }

  if (kind === "tool_execution_update") {
    const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return state;
    const partial = formatToolResultText(body.partialResult);
    const details = wikiProduceDetails(body.partialResult);
    return updateToolInState(state, toolCallId, {
      output: partial,
      ...(details ? { details } : {}),
      status: "running",
    });
  }

  if (kind === "tool_execution_end") {
    const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return state;
    const output = formatToolResultText(body.result);
    const details = wikiProduceDetails(body.result);
    const isError = body.isError === true;
    return updateToolInState(state, toolCallId, {
      output: output,
      ...(details ? { details } : {}),
      status: isError ? "error" : "done",
    });
  }

  if (kind === "error") {
    const errMessage = typeof body.message === "string" ? body.message : "Agent error";
    // Dedupe: assistant bubble already carries the same provider error.
    const view = viewMessages(state);
    for (let i = view.length - 1; i >= 0; i -= 1) {
      const m = view[i]!;
      if (m.role === "assistant") {
        if (m.status === "error" && (m.errorMessage === errMessage || m.content === errMessage)) {
          return state;
        }
        break;
      }
      if (m.role === "system" && m.status === "error" && m.content === errMessage) {
        return state;
      }
    }
    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: makeId("sys"),
          role: "system",
          content: errMessage,
          createdAt: ts,
          status: "error",
          errorMessage: errMessage,
        },
      ],
    };
  }

  if (kind === "agent_end" || kind === "agent_settled") {
    // Finalize any open stream; leave lastAssistant for late tools.
    let messages = state.messages;
    let lastAssistantId = state.lastAssistantId;
    if (state.streamingMessage) {
      const done: AgentMessage = {
        ...state.streamingMessage,
        status: state.streamingMessage.status === "error" ? "error" : "done",
        thinkingStatus: state.streamingMessage.thinking
          ? "done"
          : state.streamingMessage.thinkingStatus,
      };
      messages = [...messages, done];
      lastAssistantId = done.id;
    } else {
      messages = messages.map((m) =>
        m.status === "streaming" ? { ...m, status: "done" as const } : m,
      );
    }
    return {
      messages,
      streamingMessage: null,
      lastAssistantId,
      turnActive: false,
    };
  }

  if (kind === "agent_start") {
    // New parent turn: do not reuse prior assistant as streaming target.
    return {
      ...state,
      turnActive: true,
      streamingMessage: null,
      lastAssistantId: null,
    };
  }

  // prompt / session_ready / turn_* — no transcript rows.
  return state;
}

function historyTimestamp(row: unknown): string {
  if (!isRecord(row) || typeof row.timestamp !== "number") return nowIso();
  const date = new Date(row.timestamp);
  return Number.isNaN(date.getTime()) ? nowIso() : date.toISOString();
}

/** Project the durable branch returned by Pi SessionManager (opaque Pi messages). */
export function projectPiHistory(rows: readonly unknown[]): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!isRecord(row)) continue;
    const createdAt = historyTimestamp(row);
    const role = typeof row.role === "string" ? row.role : null;

    if (role === "user") {
      messages.push({
        id: `hist_user_${index + 1}`,
        role: "user",
        content: extractMessageText(row),
        createdAt,
        status: "done",
      });
      continue;
    }

    if (role === "assistant") {
      const error = extractAssistantError(row);
      messages.push(
        assistantFromSnapshot(row, {
          id: `hist_asst_${index + 1}`,
          status: error.isError ? "error" : "done",
          ts: createdAt,
        }),
      );
      continue;
    }

    if (role !== "toolResult" || typeof row.toolCallId !== "string") continue;
    const output = formatToolResultText(row.content) ?? formatToolResultText(row);
    const details = wikiProduceDetails(row);
    const toolCallId = row.toolCallId;
    const toolName = typeof row.toolName === "string" ? row.toolName : undefined;
    const isError = row.isError === true;
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex]!;
      if (message.role !== "assistant") continue;
      if (!message.tools?.some((tool) => tool.id === toolCallId)) continue;
      messages[messageIndex] = patchToolsOnAssistant(message, toolCallId, {
        name: toolName,
        output,
        ...(details ? { details } : {}),
        status: isError ? "error" : "done",
      });
      break;
    }
  }

  return messages;
}

/**
 * Fold the only three accepted transport shapes:
 * current server snapshot, genuine Pi event, and heartbeat.
 */
export function projectAgentEvent(state: PiStreamState, event: AgentSseLike): PiStreamState {
  if (event.source === "server" && event.kind === "snapshot") {
    const rows = Array.isArray(event.payload.messages) ? event.payload.messages : [];
    const snapshot = createPiStreamState(projectPiHistory(rows));
    const activeTool = event.payload.activeTool;
    if (!activeTool) return snapshot;
    return updateToolInState(snapshot, activeTool.toolCallId, {
      name: activeTool.toolName,
      details: activeTool.details,
      output: activeTool.details.summary,
      status: "running",
    });
  }
  if (event.source === "pi" && typeof event.kind === "string") {
    return reducePiEvent(state, event.kind, event.payload);
  }
  return state;
}
