/**
 * Deterministic Pi + product event scripts for UI tests (shadcn helpers idea,
 * without AI SDK — ADR 0030).
 *
 * Scripts emit the same shapes the server SSE bus uses, so applyPiEvent /
 * applyProductEvent exercise the real projection path.
 */

import type { StreamingRefs } from "../hooks/project-agent-events.ts";
import {
  applyPiEvent,
  applyProductEvent,
  type AgentMessage,
  type ProductSseLike,
} from "../hooks/project-agent-events.ts";

export type PiChatEvent = {
  source: "pi" | "product" | "server";
  kind: string;
  payload?: unknown;
  /** Product fields when source is product */
  product?: ProductSseLike;
};

export type PiAssistantWriter = {
  messageStart: (partial?: Record<string, unknown>) => void;
  textDelta: (delta: string) => void;
  thinkingDelta: (delta: string) => void;
  thinkingEnd: (content?: string) => void;
  toolStart: (toolCallId: string, toolName: string, args?: unknown) => void;
  toolEnd: (
    toolCallId: string,
    result?: unknown,
    opts?: { isError?: boolean },
  ) => void;
  messageEnd: (message?: Record<string, unknown>) => void;
  /** Provider-style failure: empty content + stopReason error. */
  providerError: (errorMessage: string) => void;
  agentEnd: () => void;
};

export type CreatePiChat = {
  user: (text: string) => CreatePiChat;
  assistant: (fn: (w: PiAssistantWriter) => void) => CreatePiChat;
  product: (event: ProductSseLike) => CreatePiChat;
  pi: (kind: string, payload?: unknown) => CreatePiChat;
  events: () => PiChatEvent[];
  /** Project the full script into transcript rows. */
  project: () => AgentMessage[];
};

function assistantWriter(push: (e: PiChatEvent) => void): PiAssistantWriter {
  let contentText = "";
  let thinkingText = "";

  return {
    messageStart(partial) {
      push({
        source: "pi",
        kind: "message_start",
        payload: {
          type: "message_start",
          message: {
            role: "assistant",
            content: [],
            ...partial,
          },
        },
      });
    },
    textDelta(delta) {
      contentText += delta;
      push({
        source: "pi",
        kind: "message_update",
        payload: {
          type: "message_update",
          message: {
            role: "assistant",
            content: [{ type: "text", text: contentText }],
          },
          assistantMessageEvent: { type: "text_delta", delta },
        },
      });
    },
    thinkingDelta(delta) {
      thinkingText += delta;
      push({
        source: "pi",
        kind: "message_update",
        payload: {
          type: "message_update",
          message: {
            role: "assistant",
            content: [
              ...(thinkingText
                ? [{ type: "thinking", thinking: thinkingText }]
                : []),
              ...(contentText ? [{ type: "text", text: contentText }] : []),
            ],
          },
          assistantMessageEvent: { type: "thinking_delta", delta },
        },
      });
    },
    thinkingEnd(content) {
      if (content) thinkingText = content;
      push({
        source: "pi",
        kind: "message_update",
        payload: {
          type: "message_update",
          message: {
            role: "assistant",
            content: [
              ...(thinkingText
                ? [{ type: "thinking", thinking: thinkingText }]
                : []),
              ...(contentText ? [{ type: "text", text: contentText }] : []),
            ],
          },
          assistantMessageEvent: {
            type: "thinking_end",
            content: thinkingText,
          },
        },
      });
    },
    toolStart(toolCallId, toolName, args) {
      push({
        source: "pi",
        kind: "tool_execution_start",
        payload: {
          type: "tool_execution_start",
          toolCallId,
          toolName,
          args,
        },
      });
    },
    toolEnd(toolCallId, result, opts) {
      push({
        source: "pi",
        kind: "tool_execution_end",
        payload: {
          type: "tool_execution_end",
          toolCallId,
          result,
          isError: opts?.isError === true,
        },
      });
    },
    messageEnd(message) {
      push({
        source: "pi",
        kind: "message_end",
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              ...(thinkingText
                ? [{ type: "thinking", thinking: thinkingText }]
                : []),
              ...(contentText ? [{ type: "text", text: contentText }] : []),
            ],
            stopReason: "stop",
            ...message,
          },
        },
      });
    },
    providerError(errorMessage) {
      push({
        source: "pi",
        kind: "message_start",
        payload: {
          type: "message_start",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
          },
        },
      });
      push({
        source: "pi",
        kind: "message_end",
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
          },
        },
      });
      push({
        source: "pi",
        kind: "error",
        payload: { message: errorMessage },
      });
      push({
        source: "pi",
        kind: "agent_end",
        payload: { type: "agent_end", messages: [] },
      });
    },
    agentEnd() {
      push({
        source: "pi",
        kind: "agent_end",
        payload: { type: "agent_end", messages: [] },
      });
    },
  };
}

export function createPiChat(): CreatePiChat {
  const events: PiChatEvent[] = [];
  const push = (e: PiChatEvent) => {
    events.push(e);
  };

  const api: CreatePiChat = {
    user(text) {
      // Client is optimistic for user rows; still emit pi user message_end
      // so projectors that care can ignore it (same as production).
      push({
        source: "pi",
        kind: "message_end",
        payload: {
          type: "message_end",
          message: {
            role: "user",
            content: [{ type: "text", text }],
          },
        },
      });
      return api;
    },
    assistant(fn) {
      push({ source: "pi", kind: "agent_start", payload: { type: "agent_start" } });
      fn(assistantWriter(push));
      return api;
    },
    product(event) {
      push({ source: "product", kind: event.kind, product: event });
      return api;
    },
    pi(kind, payload) {
      push({ source: "pi", kind, payload });
      return api;
    },
    events() {
      return events.slice();
    },
    project() {
      const refs: StreamingRefs = {
        streamingAssistantId: null,
        lastAssistantId: null,
        turnActive: false,
      };
      let messages: AgentMessage[] = [];
      for (const e of events) {
        if (e.source === "product" && e.product) {
          messages = applyProductEvent(messages, e.product);
        } else if (e.source === "pi") {
          messages = applyPiEvent(messages, e.kind, e.payload, refs);
        }
      }
      return messages;
    },
  };

  return api;
}

/** Canonical regression script: provider 403 with no text. */
export function scriptProvider403(): CreatePiChat {
  return createPiChat()
    .user("Say hello")
    .assistant((w) => {
      w.providerError("OpenAI API error (403): 403 Your request was blocked.");
    });
}

/** Thinking then answer. */
export function scriptThinkingThenText(): CreatePiChat {
  return createPiChat()
    .user("hi")
    .assistant((w) => {
      w.messageStart();
      w.thinkingDelta("Let me ");
      w.thinkingDelta("think");
      w.thinkingEnd();
      w.textDelta("Hello!");
      w.messageEnd();
      w.agentEnd();
    });
}
