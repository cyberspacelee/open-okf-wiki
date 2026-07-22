/**
 * Regression: Pi SSE projection must not invent multiple cards for one turn.
 *
 * Replays a tool-using agent turn (user → assistant+tools → toolResult → assistant)
 * and asserts card counts match pi-web semantics.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPiEvent,
  applyProductEvent,
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  isTerminalOrWaitingPhase,
  type AgentMessage,
  type StreamingRefs,
} from "./project-agent-events.ts";

function refs(): StreamingRefs {
  return { streamingAssistantId: null, lastAssistantId: null };
}

function assistantCount(messages: AgentMessage[]): number {
  return messages.filter((m) => m.role === "assistant").length;
}

function applyAll(
  events: Array<{ kind: string; payload?: unknown }>,
  r: StreamingRefs = refs(),
): AgentMessage[] {
  let messages: AgentMessage[] = [];
  for (const e of events) {
    messages = applyPiEvent(messages, e.kind, e.payload, r);
  }
  return messages;
}

describe("extractMessageText", () => {
  it("joins text blocks from Pi content array", () => {
    assert.equal(
      extractMessageText({
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "toolCall", id: "t1", name: "read" },
          { type: "text", text: " world" },
        ],
      }),
      "Hello world",
    );
  });
});

describe("extractMessageThinking / extractAssistantError", () => {
  it("joins thinking blocks", () => {
    assert.equal(
      extractMessageThinking({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hi" },
          { type: "thinking", thinking: " more" },
        ],
      }),
      "hmm more",
    );
  });

  it("detects stopReason error + errorMessage", () => {
    const err = extractAssistantError({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "OpenAI API error (403): blocked",
    });
    assert.equal(err.isError, true);
    assert.equal(err.errorMessage, "OpenAI API error (403): blocked");
  });
});

describe("applyPiEvent — single turn with tools", () => {
  it("does not create cards for user or toolResult message_* events", () => {
    const messages = applyAll([
      { kind: "agent_start" },
      {
        kind: "message_start",
        payload: {
          type: "message_start",
          message: { role: "user", content: "hi" },
        },
      },
      {
        kind: "message_end",
        payload: {
          type: "message_end",
          message: { role: "user", content: "hi" },
        },
      },
      {
        kind: "message_start",
        payload: {
          type: "message_start",
          message: { role: "assistant", content: [] },
        },
      },
      {
        kind: "message_update",
        payload: {
          type: "message_update",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Working" }],
          },
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Working",
          },
        },
      },
      {
        kind: "message_end",
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Working" },
              { type: "toolCall", id: "tc1", name: "ls" },
            ],
          },
        },
      },
      {
        kind: "tool_execution_start",
        payload: {
          type: "tool_execution_start",
          toolCallId: "tc1",
          toolName: "ls",
          args: { path: "." },
        },
      },
      {
        kind: "tool_execution_end",
        payload: {
          type: "tool_execution_end",
          toolCallId: "tc1",
          toolName: "ls",
          result: { entries: [] },
          isError: false,
        },
      },
      {
        kind: "message_start",
        payload: {
          type: "message_start",
          message: {
            role: "toolResult",
            toolCallId: "tc1",
            content: [{ type: "text", text: "ok" }],
          },
        },
      },
      {
        kind: "message_end",
        payload: {
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId: "tc1",
            content: [{ type: "text", text: "ok" }],
          },
        },
      },
      {
        kind: "message_start",
        payload: {
          type: "message_start",
          message: { role: "assistant", content: [] },
        },
      },
      {
        kind: "message_update",
        payload: {
          type: "message_update",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
          },
          assistantMessageEvent: { type: "text_delta", delta: "Done." },
        },
      },
      {
        kind: "message_end",
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
          },
        },
      },
      { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
    ]);

    // Exactly two assistant bubbles: pre-tool and post-tool. No empties for
    // user / toolResult / tool-only invent.
    assert.equal(assistantCount(messages), 2);
    assert.equal(messages[0]!.role, "assistant");
    assert.equal(messages[0]!.content, "Working");
    assert.equal(messages[0]!.tools?.length, 1);
    assert.equal(messages[0]!.tools?.[0]?.name, "ls");
    assert.equal(messages[0]!.tools?.[0]?.status, "done");
    assert.equal(messages[1]!.content, "Done.");
    assert.equal(messages[1]!.status, "done");
  });

  it("streams text_delta into a single assistant bubble", () => {
    const r = refs();
    let messages: AgentMessage[] = [];
    messages = applyPiEvent(
      messages,
      "message_start",
      {
        type: "message_start",
        message: { role: "assistant", content: [] },
      },
      r,
    );
    messages = applyPiEvent(
      messages,
      "message_update",
      {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
        assistantMessageEvent: { type: "text_delta", delta: "Hel" },
      },
      r,
    );
    messages = applyPiEvent(
      messages,
      "message_update",
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
        assistantMessageEvent: { type: "text_delta", delta: "lo" },
      },
      r,
    );
    messages = applyPiEvent(
      messages,
      "message_end",
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      },
      r,
    );

    assert.equal(assistantCount(messages), 1);
    assert.equal(messages[0]!.content, "Hello");
    assert.equal(messages[0]!.status, "done");
  });

  it("nests tools under last assistant even after message_end clears streaming id", () => {
    const r = refs();
    let messages: AgentMessage[] = [];
    messages = applyPiEvent(
      messages,
      "message_start",
      {
        type: "message_start",
        message: { role: "assistant", content: [] },
      },
      r,
    );
    messages = applyPiEvent(
      messages,
      "message_end",
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "call tool" }],
        },
      },
      r,
    );
    assert.equal(r.streamingAssistantId, null);
    assert.ok(r.lastAssistantId);

    messages = applyPiEvent(
      messages,
      "tool_execution_start",
      {
        type: "tool_execution_start",
        toolCallId: "x",
        toolName: "read",
        args: {},
      },
      r,
    );

    assert.equal(assistantCount(messages), 1);
    assert.equal(messages[0]!.tools?.[0]?.name, "read");
  });

  it("surfaces assistant stopReason errorMessage instead of empty done bubble", () => {
    const messages = applyAll([
      {
        kind: "message_start",
        payload: {
          type: "message_start",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "OpenAI API error (403): 403 Your request was blocked.",
          },
        },
      },
      {
        kind: "message_end",
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "OpenAI API error (403): 403 Your request was blocked.",
          },
        },
      },
      {
        kind: "error",
        payload: {
          message: "OpenAI API error (403): 403 Your request was blocked.",
        },
      },
      { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
    ]);

    assert.equal(assistantCount(messages), 1);
    assert.equal(messages[0]!.status, "error");
    assert.match(messages[0]!.content, /403/);
    assert.match(messages[0]!.errorMessage ?? "", /blocked/);
    // Same error must not also spawn a system card.
    assert.equal(
      messages.filter((m) => m.role === "system" && m.status === "error")
        .length,
      0,
    );
  });

  it("streams thinking_delta into assistant.thinking", () => {
    const r = refs();
    let messages: AgentMessage[] = [];
    messages = applyPiEvent(
      messages,
      "message_start",
      {
        type: "message_start",
        message: { role: "assistant", content: [] },
      },
      r,
    );
    messages = applyPiEvent(
      messages,
      "message_update",
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Let" }],
        },
        assistantMessageEvent: { type: "thinking_delta", delta: "Let" },
      },
      r,
    );
    messages = applyPiEvent(
      messages,
      "message_update",
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Let me" }],
        },
        assistantMessageEvent: { type: "thinking_delta", delta: " me" },
      },
      r,
    );
    messages = applyPiEvent(
      messages,
      "message_update",
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me" },
            { type: "text", text: "Hi" },
          ],
        },
        assistantMessageEvent: { type: "text_delta", delta: "Hi" },
      },
      r,
    );
    messages = applyPiEvent(
      messages,
      "message_end",
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me" },
            { type: "text", text: "Hi" },
          ],
          stopReason: "stop",
        },
      },
      r,
    );

    assert.equal(messages[0]!.thinking, "Let me");
    assert.equal(messages[0]!.thinkingStatus, "done");
    assert.equal(messages[0]!.content, "Hi");
    assert.equal(messages[0]!.status, "done");
  });
});

describe("applyProductEvent", () => {
  it("upserts consecutive run_phase cards for the same run", () => {
    let messages: AgentMessage[] = [];
    messages = applyProductEvent(messages, {
      kind: "run_phase",
      phase: "planning",
      runId: "run-1",
      status: "running",
    });
    messages = applyProductEvent(messages, {
      kind: "run_phase",
      phase: "writing",
      runId: "run-1",
      status: "running",
    });
    messages = applyProductEvent(messages, {
      kind: "run_phase",
      phase: "awaiting_publish",
      runId: "run-1",
      status: "awaiting_publication",
    });

    const phaseCards = messages.filter((m) => m.product?.kind === "run_phase");
    assert.equal(phaseCards.length, 1);
    assert.equal(phaseCards[0]!.product?.phase, "awaiting_publish");
    assert.match(phaseCards[0]!.content, /awaiting_publish/);
  });

  it("upserts consecutive gate cards of the same kind", () => {
    let messages: AgentMessage[] = [];
    messages = applyProductEvent(messages, {
      kind: "gate",
      gate: "publication",
      runId: "run-1",
      question: "Review produced pages",
      pages: ["overview.md"],
    });
    messages = applyProductEvent(messages, {
      kind: "gate",
      gate: "publication",
      runId: "run-1",
      question: "resume_gate approve",
      pages: ["overview.md", "concepts.md"],
    });
    const gates = messages.filter((m) => m.product?.kind === "gate");
    assert.equal(gates.length, 1);
    assert.equal(gates[0]!.product?.pages?.length, 2);
  });
});

describe("isTerminalOrWaitingPhase", () => {
  it("marks planning/writing as busy and gates as waiting", () => {
    assert.equal(isTerminalOrWaitingPhase("planning"), false);
    assert.equal(isTerminalOrWaitingPhase("writing"), false);
    assert.equal(isTerminalOrWaitingPhase("awaiting_plan"), true);
    assert.equal(isTerminalOrWaitingPhase("awaiting_publish"), true);
    assert.equal(isTerminalOrWaitingPhase("done"), true);
  });
});
