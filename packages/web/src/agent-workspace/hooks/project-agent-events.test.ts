/**
 * Regression: Pi SSE projection must not invent multiple cards for one turn.
 * Wave 3: work_unit fold only (no dual-path child stream authority).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPiEvent,
  applyProductEvent,
  applyWorkUnit,
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  formatPayloadText,
  formatToolDisplay,
  isTerminalOrWaitingPhase,
  mergeWorkUnitsIntoTimeline,
  workUnitHasBody,
  workUnitsFromList,
  type AgentMessage,
  type StreamingRefs,
  type WorkUnits,
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
    const messages = applyAll([
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
    ]);

    assert.equal(assistantCount(messages), 2);
    assert.equal(messages[0]!.content, "first");
    assert.equal(messages[1]!.content, "second");
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
    // No product work_run chip from Pi alone.
    assert.equal(
      messages.filter((m) => m.product?.kind === "work_run").length,
      0,
    );
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
    const d = formatToolDisplay(
      "bash",
      JSON.stringify({ command: "ls -la packages/web" }),
    );
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

describe("applyProductEvent — work_run chip from work_unit", () => {
  it("folds multiple work_unit into one work_run card", () => {
    let messages: AgentMessage[] = [];
    messages = applyProductEvent(messages, {
      kind: "work_unit",
      runId: "run-1",
      unitId: "planner",
      role: "planner",
      status: "running",
      task: "draft spec",
    });
    messages = applyProductEvent(messages, {
      kind: "work_unit",
      runId: "run-1",
      unitId: "leaf-d1-1",
      role: "leaf",
      status: "running",
      parentId: "domain-1",
      task: "q1",
    });
    messages = applyProductEvent(messages, {
      kind: "work_unit",
      runId: "run-1",
      unitId: "planner",
      role: "planner",
      status: "settled",
      summary: "done planning",
    });
    const works = messages.filter((m) => m.product?.kind === "work_run");
    assert.equal(works.length, 1);
    assert.equal(works[0]!.product?.agents?.length, 2);
    // First-seen order: planner then leaf (newest does not jump above history).
    assert.deepEqual(
      works[0]!.product?.agents?.map((a) => a.agentId),
      ["planner", "leaf-d1-1"],
    );
    const planner = works[0]!.product?.agents?.find(
      (a) => a.agentId === "planner",
    );
    assert.equal(planner?.status, "settled");
    assert.equal(planner?.detail, "done planning");
    // work_unit must not emit standalone product cards of kind work_unit.
    assert.equal(
      messages.filter((m) => m.status === "work_unit").length,
      0,
    );
  });

  it("late unit for an earlier run attaches to that run, not a new Work chip", () => {
    let messages: AgentMessage[] = [];
    messages = applyProductEvent(messages, {
      kind: "work_unit",
      runId: "run-1",
      unitId: "planner",
      role: "planner",
      status: "settled",
    });
    messages = applyProductEvent(messages, {
      kind: "work_unit",
      runId: "run-1",
      unitId: "leaf-1",
      role: "leaf",
      status: "settled",
    });
    messages = applyProductEvent(messages, {
      kind: "work_unit",
      runId: "run-2",
      unitId: "planner",
      role: "planner",
      status: "running",
    });
    // Late leaf for run-1 after run-2 Work chip exists — must not open a 3rd card.
    messages = applyProductEvent(messages, {
      kind: "work_unit",
      runId: "run-1",
      unitId: "leaf-2",
      role: "leaf",
      status: "running",
    });
    const works = messages.filter((m) => m.product?.kind === "work_run");
    assert.equal(works.length, 2);
    const r1 = works.find((m) => m.product?.runId === "run-1");
    const r2 = works.find((m) => m.product?.runId === "run-2");
    assert.ok(r1 && r2);
    assert.deepEqual(
      r1!.product?.agents?.map((a) => a.agentId),
      ["planner", "leaf-1", "leaf-2"],
    );
    assert.deepEqual(r2!.product?.agents?.map((a) => a.agentId), ["planner"]);
  });

  it("mergeWorkUnitsIntoTimeline restores all cold units onto one Work chip", () => {
    // Simulate sparse trajectory (only last unit) + full fold cache after refresh.
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
    messages = mergeWorkUnitsIntoTimeline(messages, units);
    const works = messages.filter((m) => m.product?.kind === "work_run");
    assert.equal(works.length, 1);
    assert.equal(works[0]!.product?.agents?.length, 3);
    assert.ok(
      works[0]!.product?.agents?.some((a) => a.agentId === "planner"),
    );
    assert.ok(works[0]!.product?.agents?.some((a) => a.agentId === "leaf-1"));
    assert.ok(
      works[0]!.product?.agents?.some((a) => a.agentId === "reviewer-1"),
    );
  });
});
