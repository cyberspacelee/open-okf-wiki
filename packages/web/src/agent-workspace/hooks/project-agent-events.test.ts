/**
 * Regression: Pi SSE projection must not invent multiple cards for one turn.
 * Wave 3: work_unit fold only (no dual-path child stream authority).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en } from "../../i18n/en.ts";
import { zh } from "../../i18n/zh.ts";
import {
  type AgentMessage,
  applyPiEvent,
  applyProductEvent,
  applyWorkUnit,
  ensureWorkBlockAnchors,
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  formatPayloadText,
  formatProductCardContent,
  formatToolDisplay,
  formatToolResultText,
  isTerminalOrWaitingPhase,
  type StreamingRefs,
  unitRecentActivity,
  unitsForRun,
  type WorkUnits,
  type WorkUnitView,
  workBlockProgress,
  workUnitHasBody,
  workUnitsFromList,
} from "./project-agent-events.ts";

function refs(): StreamingRefs {
  return {
    streamingAssistantId: null,
    lastAssistantId: null,
    turnActive: false,
  };
}

function assistantCount(messages: AgentMessage[]): number {
  return messages.filter((m) => m.role === "assistant").length;
}

function applyAll(
  events: Array<{ kind: string; payload?: unknown }>,
  r: StreamingRefs = refs(),
  seed: AgentMessage[] = [],
): AgentMessage[] {
  let messages: AgentMessage[] = seed.slice();
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
  it("keeps text → tool → text as one assistant bubble (no multi-card)", () => {
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

    // One assistant bubble for the whole turn: pre-tool + post-tool text,
    // tools nested. No empties for user / toolResult.
    assert.equal(assistantCount(messages), 1);
    assert.equal(messages[0]!.role, "assistant");
    assert.match(messages[0]!.content, /Working/);
    assert.match(messages[0]!.content, /Done\./);
    assert.equal(messages[0]!.tools?.length, 1);
    assert.equal(messages[0]!.tools?.[0]?.name, "ls");
    assert.equal(messages[0]!.tools?.[0]?.status, "done");
    assert.equal(messages[0]!.status, "done");
  });

  it("opens a new assistant card on the next turn after agent_end", () => {
    // Production always has a user row between turns (optimistic send).
    const r = refs();
    let messages = applyAll(
      [
        { kind: "agent_start" },
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
              content: [{ type: "text", text: "first" }],
            },
            assistantMessageEvent: { type: "text_delta", delta: "first" },
          },
        },
        {
          kind: "message_end",
          payload: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "first" }],
              stopReason: "stop",
            },
          },
        },
        { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
      ],
      r,
    );
    messages = [
      ...messages,
      {
        id: "user_2",
        role: "user",
        content: "again",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ];
    messages = applyAll(
      [
        { kind: "agent_start" },
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
              content: [{ type: "text", text: "second" }],
            },
            assistantMessageEvent: { type: "text_delta", delta: "second" },
          },
        },
        {
          kind: "message_end",
          payload: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "second" }],
              stopReason: "stop",
            },
          },
        },
        { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
      ],
      r,
      messages,
    );

    assert.equal(assistantCount(messages), 2);
    const assts = messages.filter((m) => m.role === "assistant");
    assert.equal(assts[0]!.content, "first");
    assert.equal(assts[1]!.content, "second");
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
    assert.equal(messages.filter((m) => m.role === "system" && m.status === "error").length, 0);
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

  it("does not invent a second card when agent_end clears streaming before message_end", () => {
    // Symptom: after the answer finishes, thinking + message each appear twice.
    // agent_end/agent_settled clear streamingAssistantId; a late message_end must
    // finalize lastAssistant, not append a duplicate bubble.
    const messages = applyAll([
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
            content: [{ type: "thinking", thinking: "think" }],
          },
          assistantMessageEvent: { type: "thinking_delta", delta: "think" },
        },
      },
      {
        kind: "message_update",
        payload: {
          type: "message_update",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "think" },
              { type: "text", text: "hi" },
            ],
          },
          assistantMessageEvent: { type: "text_delta", delta: "hi" },
        },
      },
      { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
      {
        kind: "message_end",
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "think" },
              { type: "text", text: "hi" },
            ],
            stopReason: "stop",
          },
        },
      },
    ]);

    assert.equal(assistantCount(messages), 1);
    assert.equal(messages[0]!.thinking, "think");
    assert.equal(messages[0]!.content, "hi");
    assert.equal(messages[0]!.status, "done");
  });

  it("does not open a peer assistant when replaying a turn on top of cold history", () => {
    // Cold JSONL already has the completed turn (hist_*), then the SSE ring
    // re-sends agent_start → message_start → … → message_end for the same turn.
    const r = refs();
    let messages: AgentMessage[] = [
      {
        id: "hist_0",
        role: "user",
        content: "hi hi",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "hist_1",
        role: "assistant",
        content: "Hi! What can I help you with?",
        thinking: "casual greeting",
        createdAt: "2026-01-01T00:00:01.000Z",
        status: "done",
      },
    ];
    messages = applyAll(
      [
        { kind: "agent_start", payload: { type: "agent_start" } },
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
              content: [{ type: "text", text: "Hi! What can I help you with?" }],
            },
            assistantMessageEvent: {
              type: "text_delta",
              delta: "Hi! What can I help you with?",
            },
          },
        },
        {
          kind: "message_end",
          payload: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hi! What can I help you with?" }],
              stopReason: "stop",
            },
          },
        },
        { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
      ],
      r,
      messages,
    );
    assert.equal(assistantCount(messages), 1);
    assert.equal(messages.find((m) => m.role === "assistant")?.id, "hist_1");
    assert.equal(
      messages.find((m) => m.role === "assistant")?.content,
      "Hi! What can I help you with?",
    );
  });

  it("still opens a new assistant after a new user turn (multi-turn)", () => {
    const r = refs();
    let messages: AgentMessage[] = [
      {
        id: "hist_0",
        role: "user",
        content: "hi",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "hist_1",
        role: "assistant",
        content: "Hello!",
        createdAt: "2026-01-01T00:00:01.000Z",
        status: "done",
      },
      {
        id: "user_opt",
        role: "user",
        content: "next",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ];
    messages = applyAll(
      [
        { kind: "agent_start", payload: { type: "agent_start" } },
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
              content: [{ type: "text", text: "Sure." }],
            },
            assistantMessageEvent: { type: "text_delta", delta: "Sure." },
          },
        },
        {
          kind: "message_end",
          payload: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Sure." }],
              stopReason: "stop",
            },
          },
        },
      ],
      r,
      messages,
    );
    assert.equal(assistantCount(messages), 2);
    assert.equal(messages.filter((m) => m.role === "assistant")[1]?.content, "Sure.");
  });

  it("is idempotent on duplicate message_end (no second thinking/answer card)", () => {
    const finalPayload = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "think" },
          { type: "text", text: "hi" },
        ],
        stopReason: "stop",
      },
    };
    const messages = applyAll([
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
            content: [
              { type: "thinking", thinking: "think" },
              { type: "text", text: "hi" },
            ],
          },
          assistantMessageEvent: { type: "text_delta", delta: "hi" },
        },
      },
      { kind: "message_end", payload: finalPayload },
      { kind: "message_end", payload: finalPayload },
    ]);

    assert.equal(assistantCount(messages), 1);
    assert.equal(messages[0]!.thinking, "think");
    assert.equal(messages[0]!.content, "hi");
  });

  it("reuses streaming bubble when thinking_delta arrives before message_start", () => {
    const messages = applyAll([
      { kind: "agent_start" },
      {
        kind: "message_update",
        payload: {
          type: "message_update",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "think" }],
          },
          assistantMessageEvent: { type: "thinking_delta", delta: "think" },
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
            content: [
              { type: "thinking", thinking: "think" },
              { type: "text", text: "hi" },
            ],
          },
          assistantMessageEvent: { type: "text_delta", delta: "hi" },
        },
      },
      {
        kind: "message_end",
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "think" },
              { type: "text", text: "hi" },
            ],
            stopReason: "stop",
          },
        },
      },
      { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
    ]);

    assert.equal(assistantCount(messages), 1);
    assert.equal(messages[0]!.thinking, "think");
    assert.equal(messages[0]!.content, "hi");
    assert.equal(messages[0]!.status, "done");
  });

  it("fixture message_end after a settled turn still opens a new card", () => {
    const r = refs();
    let messages = applyAll(
      [
        {
          kind: "message_start",
          payload: {
            type: "message_start",
            message: { role: "assistant", content: [] },
          },
        },
        {
          kind: "message_end",
          payload: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "first" }],
              stopReason: "stop",
            },
          },
        },
      ],
      r,
    );
    messages = applyPiEvent(
      messages,
      "message_end",
      {
        type: "message_end",
        mode: "fixture",
        note: "fixture mode — prompt recorded (no LLM)",
      },
      r,
    );

    assert.equal(assistantCount(messages), 2);
    assert.equal(messages[0]!.content, "first");
    assert.match(messages[1]!.content, /fixture mode/);
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
    // work_block anchor + single upserted phase card
    assert.equal(phaseCards.length, 1);
    assert.equal(phaseCards[0]!.product?.phase, "awaiting_publish");
    assert.equal(phaseCards[0]!.product?.status, "awaiting_publication");
    assert.ok(
      messages.some((m) => m.product?.kind === "work_block"),
      "run_phase with runId should open a work_block anchor",
    );
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

  it("skips idle agent-session-created bootstrap strip", () => {
    let messages: AgentMessage[] = [];
    messages = applyProductEvent(messages, {
      kind: "run_phase",
      phase: "idle",
      message: "agent session created",
    });
    assert.equal(messages.length, 0);
    messages = applyProductEvent(messages, {
      kind: "run_phase",
      phase: "planning",
      runId: "run-1",
      message: "planning",
    });
    assert.equal(messages.filter((m) => m.product?.kind === "run_phase").length, 1);
  });

  it("upserts run_link and progress strips (no scroller spam)", () => {
    let messages: AgentMessage[] = [];
    messages = applyProductEvent(messages, {
      kind: "run_link",
      runId: "run-1",
      status: "running",
    });
    messages = applyProductEvent(messages, {
      kind: "run_link",
      runId: "run-1",
      status: "running",
    });
    messages = applyProductEvent(messages, {
      kind: "run_link",
      runId: "run-1",
      status: "cancelled",
    });
    messages = applyProductEvent(messages, {
      kind: "progress",
      runId: "run-1",
      phase: "planning",
      label: "materialize",
    });
    messages = applyProductEvent(messages, {
      kind: "progress",
      runId: "run-1",
      phase: "planning",
      label: "materialize + analyze sources",
    });
    messages = applyProductEvent(messages, {
      kind: "progress",
      runId: "run-1",
      phase: "writing",
      label: "domain research",
    });

    const links = messages.filter((m) => m.product?.kind === "run_link");
    assert.equal(links.length, 1);
    assert.equal(links[0]!.product?.status, "cancelled");

    const progress = messages.filter((m) => m.product?.kind === "progress");
    assert.equal(progress.length, 1);
    assert.equal(progress[0]!.product?.phase, "writing");
    assert.equal(progress[0]!.product?.label, "domain research");
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

describe("applyWorkUnit — Work surface fold cache", () => {
  it("folds last-write by unitId and keeps concurrent units isolated", () => {
    let units: WorkUnits = {};
    units = applyWorkUnit(units, {
      unitId: "planner",
      role: "planner",
      status: "running",
      runId: "run-1",
      message: { thinking: "plan A" },
    });
    units = applyWorkUnit(units, {
      unitId: "leaf-d1-1",
      role: "leaf",
      status: "running",
      runId: "run-1",
      parentId: "domain-1",
      message: { text: "leaf1" },
      tools: [
        {
          toolCallId: "t1",
          toolName: "read",
          state: "input-available",
          input: { path: "x.ts" },
        },
      ],
    });
    units = applyWorkUnit(units, {
      unitId: "leaf-d1-2",
      role: "leaf",
      status: "running",
      runId: "run-1",
      message: { text: "leaf2" },
    });
    units = applyWorkUnit(units, {
      unitId: "planner",
      role: "planner",
      status: "settled",
      runId: "run-1",
      summary: "done planning",
      message: { thinking: "plan A", text: "spec ready" },
    });

    assert.equal(units.planner?.status, "settled");
    assert.equal(units.planner?.summary, "done planning");
    assert.equal(units.planner?.message?.text, "spec ready");
    assert.equal(units["leaf-d1-1"]?.message?.text, "leaf1");
    assert.equal(units["leaf-d1-2"]?.message?.text, "leaf2");
    assert.equal(units["leaf-d1-1"]?.tools?.length, 1);
    assert.equal(units["leaf-d1-2"]?.tools?.length ?? 0, 0);
    assert.equal(Object.keys(units).length, 3);
  });

  it("empty running unit is not labeled as having body (no Thinking chrome)", () => {
    const units = applyWorkUnit(
      {},
      {
        unitId: "planner",
        role: "planner",
        status: "running",
        runId: "run-1",
      },
    );
    assert.equal(units.planner?.status, "running");
    assert.equal(workUnitHasBody(units.planner), false);
    // Drawer uses workUnitHasBody — empty running must never imply thinking.
    assert.equal(Boolean(units.planner?.message?.thinking), false);
  });

  it("workUnitsFromList seeds cold-load fold", () => {
    const units = workUnitsFromList([
      {
        unitId: "planner",
        role: "planner",
        status: "settled",
        summary: "ok",
      },
      {
        unitId: "leaf-1",
        role: "leaf",
        status: "failed",
        error: "boom",
      },
    ]);
    assert.equal(units.planner?.summary, "ok");
    assert.equal(units["leaf-1"]?.error, "boom");
  });
});

describe("main timeline isolation", () => {
  it("parent Pi projection never invents peer bubbles for work units", () => {
    // Produce bodies arrive only via product work_unit — parent Pi alone
    // cannot create unit chips. Concurrent parent chat stays single-stream.
    const r = refs();
    let messages: AgentMessage[] = [];
    messages = applyPiEvent(
      messages,
      "message_update",
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "parent" }],
        },
        assistantMessageEvent: { type: "text_delta", delta: "parent" },
      },
      r,
    );
    assert.equal(assistantCount(messages), 1);
    assert.equal(messages[0]!.content, "parent");
    // No work_block from Pi alone.
    assert.equal(messages.filter((m) => m.product?.kind === "work_block").length, 0);
  });
});

describe("formatPayloadText", () => {
  it("pretty-prints JSON objects", () => {
    const out = formatPayloadText('{"a":1,"b":[2]}');
    assert.match(out, /\n/);
    assert.match(out, /"a": 1/);
  });

  it("pretty-prints JSON arrays", () => {
    const out = formatPayloadText("[1,2,3]");
    assert.equal(out, "[\n  1,\n  2,\n  3\n]");
  });

  it("leaves non-JSON and incomplete braces alone", () => {
    assert.equal(formatPayloadText("not json"), "not json");
    assert.equal(formatPayloadText("{not-closed"), "{not-closed");
    assert.equal(formatPayloadText(""), "");
    assert.equal(formatPayloadText(undefined), "");
  });

  it("truncates overlong payloads with a clear marker", () => {
    const body = JSON.stringify({ x: "y".repeat(200) });
    const out = formatPayloadText(body, 80);
    assert.ok(out.length < body.length + 40);
    assert.match(out, /…\[truncated \d+ chars\]$/);
    assert.ok(out.startsWith("{\n"));
  });
});

describe("formatToolResultText", () => {
  it("extracts text from Pi content array envelope", () => {
    const out = formatToolResultText({
      content: [{ type: "text", text: "line one\nline two" }],
      isError: false,
    });
    assert.equal(out, "line one\nline two");
  });

  it("peels JSON string envelopes once", () => {
    const raw = JSON.stringify({
      content: [{ type: "text", text: "hello file" }],
    });
    assert.equal(formatToolResultText(raw), "hello file");
  });

  it("returns undefined for opaque objects without text", () => {
    assert.equal(formatToolResultText({ foo: 1, bar: true }), undefined);
  });
});

describe("formatToolDisplay", () => {
  it("read is header-only: filename + args, no input dump", () => {
    const d = formatToolDisplay(
      "read",
      JSON.stringify({ path: "wiki/overview.md", offset: 1, limit: 20 }),
    );
    assert.equal(d.title, "read");
    assert.equal(d.subtitle, "overview.md");
    assert.deepEqual(d.args, ["offset=1", "limit=20"]);
    assert.equal(d.kind, "output-only");
    assert.equal(d.headerOnly, true);
    assert.equal(d.writePreview, undefined);
  });

  it("bash is console kind with command on subtitle", () => {
    const d = formatToolDisplay("bash", JSON.stringify({ command: "ls -la packages/web" }));
    assert.equal(d.title, "shell");
    assert.match(d.subtitle ?? "", /ls -la/);
    assert.equal(d.kind, "console");
    assert.equal(d.command, "ls -la packages/web");
  });

  it("grep puts pattern on the trigger line, not as JSON body", () => {
    const d = formatToolDisplay(
      "grep",
      JSON.stringify({ pattern: "handleDelete", path: "packages/server" }),
    );
    assert.equal(d.title, "grep");
    assert.equal(d.kind, "output-only");
    // path as subtitle, pattern as arg (OpenCode layout) — or pattern as subtitle
    assert.ok(
      d.subtitle === "server" ||
        d.subtitle === "handleDelete" ||
        (d.args ?? []).some((a) => a.includes("handleDelete")),
    );
  });
});

describe("formatProductCardContent i18n", () => {
  it("localizes gate and failed phase for en and zh", () => {
    const failed = formatProductCardContent(
      {
        kind: "run_phase",
        phase: "failed",
        label: "freeze failed: dirty worktree",
      },
      en.agentWorkspace,
    );
    assert.match(failed, /Failed|freeze failed/);

    const failedZh = formatProductCardContent(
      {
        kind: "run_phase",
        phase: "failed",
        label: "freeze failed: dirty worktree",
      },
      zh.agentWorkspace,
    );
    assert.match(failedZh, /失败/);
    assert.match(failedZh, /freeze failed/);

    const gateEn = formatProductCardContent(
      { kind: "gate", gate: "plan", pages: ["a.md", "b.md"] },
      en.agentWorkspace,
    );
    assert.match(gateEn, /2 page/);

    const gateZh = formatProductCardContent(
      { kind: "gate", gate: "plan", pages: ["a.md", "b.md"] },
      zh.agentWorkspace,
    );
    assert.match(gateZh, /2 个页面|计划已就绪/);
  });
});

describe("unitRecentActivity + workBlockProgress (main tracks subagents)", () => {
  it("prefers last tool name for live progress line", () => {
    const unit: WorkUnitView = {
      unitId: "leaf-1",
      role: "leaf",
      status: "running",
      tools: [
        {
          toolCallId: "t1",
          toolName: "read",
          state: "output-available",
        },
        {
          toolCallId: "t2",
          toolName: "grep",
          state: "input-available",
        },
      ],
    };
    assert.equal(unitRecentActivity(unit), "grep…");
  });

  it("falls back to summary when settled", () => {
    const unit: WorkUnitView = {
      unitId: "planner",
      role: "planner",
      status: "settled",
      summary: "Planned 12 pages for the repo overview",
    };
    assert.match(unitRecentActivity(unit) ?? "", /Planned 12 pages/);
  });

  it("aggregates work block progress counts", () => {
    const p = workBlockProgress([
      { unitId: "a", role: "planner", status: "settled" },
      { unitId: "b", role: "leaf", status: "running" },
      { unitId: "c", role: "leaf", status: "pending" },
      { unitId: "d", role: "reviewer", status: "failed" },
    ]);
    assert.deepEqual(p, {
      total: 4,
      running: 1,
      settled: 1,
      failed: 1,
      pending: 1,
    });
  });
});

describe("applyProductEvent — work_block anchors + units fold", () => {
  it("multiple work_unit for one run share one work_block anchor", () => {
    let messages: AgentMessage[] = [];
    let units: WorkUnits = {};
    const applyUnit = (ev: {
      kind: "work_unit";
      runId: string;
      unitId: string;
      role: string;
      status: string;
      task?: string;
      parentId?: string;
      summary?: string;
    }) => {
      messages = applyProductEvent(messages, ev);
      units = applyWorkUnit(units, ev);
    };
    applyUnit({
      kind: "work_unit",
      runId: "run-1",
      unitId: "planner",
      role: "planner",
      status: "running",
      task: "draft spec",
    });
    applyUnit({
      kind: "work_unit",
      runId: "run-1",
      unitId: "leaf-d1-1",
      role: "leaf",
      status: "running",
      parentId: "domain-1",
      task: "q1",
    });
    applyUnit({
      kind: "work_unit",
      runId: "run-1",
      unitId: "planner",
      role: "planner",
      status: "settled",
      summary: "done planning",
    });
    const blocks = messages.filter((m) => m.product?.kind === "work_block");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.product?.runId, "run-1");
    const list = unitsForRun(units, "run-1");
    assert.equal(list.length, 2);
    assert.equal(units.planner?.status, "settled");
    assert.equal(units.planner?.summary, "done planning");
    assert.equal(messages.filter((m) => m.status === "work_unit").length, 0);
  });

  it("two runs get two work_block anchors; units fold stays per runId", () => {
    let messages: AgentMessage[] = [];
    let units: WorkUnits = {};
    const applyUnit = (ev: {
      kind: "work_unit";
      runId: string;
      unitId: string;
      role: string;
      status: string;
    }) => {
      messages = applyProductEvent(messages, ev);
      units = applyWorkUnit(units, ev);
    };
    // unitId is global fold key — must be unique across concurrent runs.
    applyUnit({
      kind: "work_unit",
      runId: "run-1",
      unitId: "run-1/planner",
      role: "planner",
      status: "settled",
    });
    applyUnit({
      kind: "work_unit",
      runId: "run-1",
      unitId: "run-1/leaf-1",
      role: "leaf",
      status: "settled",
    });
    applyUnit({
      kind: "work_unit",
      runId: "run-2",
      unitId: "run-2/planner",
      role: "planner",
      status: "running",
    });
    applyUnit({
      kind: "work_unit",
      runId: "run-1",
      unitId: "run-1/leaf-2",
      role: "leaf",
      status: "running",
    });
    const blocks = messages.filter((m) => m.product?.kind === "work_block");
    assert.equal(blocks.length, 2);
    assert.equal(unitsForRun(units, "run-1").length, 3);
    assert.equal(unitsForRun(units, "run-2").length, 1);
  });

  it("ensureWorkBlockAnchors restores anchors from cold units fold", () => {
    let messages: AgentMessage[] = [];
    messages = applyProductEvent(messages, {
      kind: "work_unit",
      runId: "run-1",
      unitId: "reviewer-1",
      role: "reviewer",
      status: "settled",
      summary: "NO_DEFECTS",
    });
    const units = workUnitsFromList([
      {
        kind: "work_unit",
        unitId: "planner",
        role: "planner",
        status: "settled",
        runId: "run-1",
        summary: "planned",
      },
      {
        kind: "work_unit",
        unitId: "leaf-1",
        role: "leaf",
        status: "settled",
        runId: "run-1",
        summary: "leaf done",
      },
      {
        kind: "work_unit",
        unitId: "reviewer-1",
        role: "reviewer",
        status: "settled",
        runId: "run-1",
        summary: "NO_DEFECTS",
      },
    ]);
    messages = ensureWorkBlockAnchors(messages, units);
    const blocks = messages.filter((m) => m.product?.kind === "work_block");
    assert.equal(blocks.length, 1);
    assert.equal(unitsForRun(units, "run-1").length, 3);
    assert.ok(units.planner);
    assert.ok(units["leaf-1"]);
    assert.ok(units["reviewer-1"]);
  });
});
