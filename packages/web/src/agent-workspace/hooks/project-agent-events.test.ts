/**
 * Pi snapshot projection + thin product strips + produce unit fold (ADR 0031 WP6).
 * No work_unit fold / string-delta machine.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en } from "../../i18n/en.ts";
import { zh } from "../../i18n/zh.ts";
import {
  type AgentMessage,
  applyProductEvent,
  createPiStreamState,
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  foldProduceUnit,
  formatPayloadText,
  formatProductCardContent,
  formatToolDisplay,
  formatToolResultText,
  isTerminalOrWaitingPhase,
  type PiStreamState,
  type ProduceUnit,
  parseProduceUnitPayload,
  reducePiEvent,
  seedProduceUnits,
  viewMessages,
} from "./project-agent-events.ts";

function applyAll(
  events: Array<{ kind: string; payload?: unknown }>,
  seed: PiStreamState = createPiStreamState(),
): PiStreamState {
  let state = seed;
  for (const e of events) {
    state = reducePiEvent(state, e.kind, e.payload);
  }
  return state;
}

function assistantCount(messages: AgentMessage[]): number {
  return messages.filter((m) => m.role === "assistant").length;
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

describe("reducePiEvent — snapshot streaming", () => {
  it("message_update replaces content from full message snapshot (not delta append)", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
      assistantMessageEvent: { type: "text_delta", delta: "Hel" },
    });
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      // Full snapshot — if we appended deltas we'd get HelHel lo
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
    });
    assert.equal(state.streamingMessage?.content, "Hello");
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        stopReason: "stop",
      },
    });
    const view = viewMessages(state);
    assert.equal(assistantCount(view), 1);
    assert.equal(view[0]!.content, "Hello");
    assert.equal(view[0]!.status, "done");
    assert.equal(state.streamingMessage, null);
  });

  it("streams thinking from snapshot then finalizes", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "plan A" }],
      },
      assistantMessageEvent: { type: "thinking_delta", delta: "plan A" },
    });
    assert.equal(state.streamingMessage?.thinking, "plan A");
    assert.equal(state.streamingMessage?.thinkingStatus, "streaming");
    // Empty content while streaming must not invent "thinking" label in UI —
    // content stays empty; thinking is separate.
    assert.equal(state.streamingMessage?.content, "");
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan A" },
          { type: "text", text: "done" },
        ],
      },
    });
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan A" },
          { type: "text", text: "done" },
        ],
        stopReason: "stop",
      },
    });
    const m = viewMessages(state)[0]!;
    assert.equal(m.thinking, "plan A");
    assert.equal(m.content, "done");
    assert.equal(m.thinkingStatus, "done");
  });

  it("attaches tools via tool_execution_* on the streaming assistant", () => {
    const state = applyAll([
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
            content: [
              { type: "text", text: "Working" },
              { type: "toolCall", id: "tc1", name: "ls", arguments: { path: "." } },
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
          result: { content: [{ type: "text", text: "ok" }] },
          isError: false,
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
              { type: "toolCall", id: "tc1", name: "ls", arguments: { path: "." } },
            ],
            stopReason: "stop",
          },
        },
      },
      { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
    ]);

    const view = viewMessages(state);
    assert.equal(assistantCount(view), 1);
    assert.equal(view[0]!.content, "Working");
    assert.equal(view[0]!.tools?.length, 1);
    assert.equal(view[0]!.tools?.[0]?.name, "ls");
    assert.equal(view[0]!.tools?.[0]?.status, "done");
    assert.equal(view[0]!.tools?.[0]?.output, "ok");
  });

  it("opens a new assistant card on the next turn after agent_end", () => {
    let state = applyAll([
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
    ]);
    // Optimistic user row between turns.
    state = {
      ...state,
      messages: [
        ...state.messages,
        {
          id: "user_2",
          role: "user",
          content: "again",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    };
    state = applyAll(
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
      state,
    );

    const assts = viewMessages(state).filter((m) => m.role === "assistant");
    assert.equal(assts.length, 2);
    assert.equal(assts[0]!.content, "first");
    assert.equal(assts[1]!.content, "second");
  });

  it("provider error finalizes one error assistant; error event does not duplicate", () => {
    const state = applyAll([
      { kind: "agent_start" },
      {
        kind: "message_start",
        payload: {
          type: "message_start",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "OpenAI API error (403): blocked",
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
            errorMessage: "OpenAI API error (403): blocked",
          },
        },
      },
      {
        kind: "error",
        payload: { message: "OpenAI API error (403): blocked" },
      },
      { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
    ]);
    const view = viewMessages(state);
    const assistants = view.filter((m) => m.role === "assistant");
    const systems = view.filter((m) => m.role === "system" && m.status === "error");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0]!.status, "error");
    assert.match(assistants[0]!.content, /403/);
    assert.equal(systems.length, 0);
  });

  it("empty streaming snapshot does not invent content", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    assert.equal(state.streamingMessage?.content, "");
    assert.equal(state.streamingMessage?.thinking, undefined);
    assert.equal(state.streamingMessage?.status, "streaming");
  });

  it("late message_end after agent_end does not open a second assistant card", () => {
    // Pi agent-loop emits message_end then agent_end; host/retry/ring can
    // redeliver message_end after turnActive is cleared. Must not peer-bubble.
    const final = {
      role: "assistant" as const,
      content: [
        { type: "thinking" as const, thinking: "plan" },
        { type: "text" as const, text: "Hello" },
      ],
      stopReason: "stop" as const,
    };
    const state = applyAll([
      { kind: "agent_start" },
      {
        kind: "message_start",
        payload: { type: "message_start", message: { role: "assistant", content: [] } },
      },
      {
        kind: "message_update",
        payload: { type: "message_update", message: final },
      },
      { kind: "message_end", payload: { type: "message_end", message: final } },
      { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
      // late / ring redelivery
      { kind: "message_end", payload: { type: "message_end", message: final } },
    ]);
    const assts = viewMessages(state).filter((m) => m.role === "assistant");
    assert.equal(assts.length, 1);
    assert.equal(assts[0]!.content, "Hello");
    assert.equal(assts[0]!.thinking, "plan");
  });

  it("message_end without agent_start does not duplicate a completed last assistant", () => {
    // Host wiki_produce and partial ring dumps may omit agent_start; after the
    // first finalize, a second message_end must not invent a peer card.
    const msg = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "A" }],
      stopReason: "stop" as const,
    };
    const state = applyAll([
      {
        kind: "message_start",
        payload: { type: "message_start", message: msg },
      },
      { kind: "message_end", payload: { type: "message_end", message: msg } },
      { kind: "message_end", payload: { type: "message_end", message: msg } },
    ]);
    assert.equal(assistantCount(viewMessages(state)), 1);
  });

  it("cold history + ring message_end without agent_start stays single card", () => {
    // Bootstrap skip should avoid this; projector must still be safe if a
    // completed hist_* row is present when message_end is applied.
    let state = createPiStreamState([
      {
        id: "hist_asst_1",
        role: "assistant",
        content: "Hello",
        thinking: "plan",
        thinkingStatus: "done",
        createdAt: new Date().toISOString(),
        status: "done",
      },
    ]);
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "Hello" },
        ],
        stopReason: "stop",
      },
    });
    const assts = viewMessages(state).filter((m) => m.role === "assistant");
    assert.equal(assts.length, 1);
    assert.equal(assts[0]!.id, "hist_asst_1");
    assert.equal(assts[0]!.thinking, "plan");
  });

  it("tool-loop second assistant after first finalize still opens a new card", () => {
    // Within one agent_start, tool results then a second model message must
    // not be swallowed by the completed-last-assistant guard.
    const state = applyAll([
      { kind: "agent_start" },
      {
        kind: "message_start",
        payload: {
          type: "message_start",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a" } },
            ],
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
              { type: "text", text: "calling" },
              { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a" } },
            ],
            stopReason: "toolUse",
          },
        },
      },
      {
        kind: "tool_execution_end",
        payload: {
          type: "tool_execution_end",
          toolCallId: "tc1",
          toolName: "read",
          result: { content: [{ type: "text", text: "file" }] },
          isError: false,
        },
      },
      {
        kind: "message_start",
        payload: {
          type: "message_start",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      },
      {
        kind: "message_end",
        payload: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
          },
        },
      },
      { kind: "agent_end", payload: { type: "agent_end", messages: [] } },
    ]);
    const assts = viewMessages(state).filter((m) => m.role === "assistant");
    assert.equal(assts.length, 2);
    assert.equal(assts[0]!.content, "calling");
    assert.equal(assts[1]!.content, "done");
  });
});

describe("applyProductEvent — thin strips only", () => {
  it("upserts run_phase per runId", () => {
    let messages: AgentMessage[] = [];
    messages = applyProductEvent(messages, {
      kind: "run_phase",
      phase: "planning",
      runId: "run-1",
    });
    messages = applyProductEvent(messages, {
      kind: "run_phase",
      phase: "writing",
      runId: "run-1",
    });
    assert.equal(messages.filter((m) => m.product?.kind === "run_phase").length, 1);
    assert.equal(messages[0]!.product?.phase, "writing");
  });

  it("projects gate and plan_progress", () => {
    let messages: AgentMessage[] = [];
    messages = applyProductEvent(messages, {
      kind: "gate",
      gate: "plan",
      runId: "run-1",
      pages: ["a.md", "b.md"],
    });
    messages = applyProductEvent(messages, {
      kind: "plan_progress",
      runId: "run-1",
      pages: [
        { path: "a.md", status: "done" },
        { path: "b.md", status: "writing" },
      ],
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.product?.kind, "gate");
    assert.equal(messages[1]!.product?.kind, "plan_progress");
  });

  it("ignores removed body-channel kinds", () => {
    let messages: AgentMessage[] = [];
    messages = applyProductEvent(messages, {
      // @ts-expect-error — intentionally invalid kind
      kind: "work_unit",
      unitId: "planner",
    });
    assert.equal(messages.length, 0);
  });
});

describe("isTerminalOrWaitingPhase", () => {
  it("marks gate and terminal phases as waiting", () => {
    assert.equal(isTerminalOrWaitingPhase("awaiting_plan"), true);
    assert.equal(isTerminalOrWaitingPhase("awaiting_publish"), true);
    assert.equal(isTerminalOrWaitingPhase("done"), true);
    assert.equal(isTerminalOrWaitingPhase("writing"), false);
  });
});

describe("foldProduceUnit / seedProduceUnits", () => {
  it("folds last-by-unitId and merges partial patches", () => {
    let units: ProduceUnit[] = [];
    units = foldProduceUnit(units, {
      role: "leaf",
      status: "running",
      unitId: "leaf-1",
      task: "write overview",
      parentId: "domain-1",
    });
    assert.equal(units.length, 1);
    units = foldProduceUnit(units, {
      role: "leaf",
      status: "running",
      unitId: "leaf-1",
      message: { text: "drafting" },
      tools: [{ toolCallId: "t1", toolName: "read", state: "running" }],
    });
    assert.equal(units.length, 1);
    assert.equal(units[0]!.task, "write overview");
    assert.equal(units[0]!.message?.text, "drafting");
    assert.equal(units[0]!.tools?.length, 1);

    units = foldProduceUnit(units, {
      role: "leaf",
      status: "settled",
      unitId: "leaf-1",
      summary: "done",
    });
    assert.equal(units[0]!.status, "settled");
    assert.equal(units[0]!.summary, "done");
    assert.equal(units[0]!.task, "write overview");
    assert.equal(units[0]!.tools?.length, 1);

    units = foldProduceUnit(units, {
      role: "domain",
      status: "failed",
      unitId: "domain-1",
      error: "nope",
    });
    assert.equal(units.length, 2);
    assert.equal(units[1]!.error, "nope");
  });

  it("seeds from cold-load array and ignores garbage", () => {
    const units = seedProduceUnits([
      { role: "planner", status: "settled", unitId: "planner", summary: "ok" },
      { not: "a unit" },
      null,
      { role: "leaf", status: "settled", unitId: "leaf-1" },
    ]);
    assert.equal(units.length, 2);
    assert.equal(units[0]!.unitId, "planner");
    assert.equal(units[1]!.unitId, "leaf-1");
  });

  it("parses SSE payload shape", () => {
    assert.equal(parseProduceUnitPayload(null), null);
    assert.equal(parseProduceUnitPayload({ role: "leaf" }), null);
    const u = parseProduceUnitPayload({
      role: "leaf",
      status: "running",
      unitId: "leaf-1",
      task: "t",
    });
    assert.ok(u);
    assert.equal(u!.unitId, "leaf-1");
  });

  it("snapshot: settled produce unit retains summary after fold chain", () => {
    // Snapshot-style: end state after live patches + settle.
    const chain: ProduceUnit[] = [
      { role: "leaf", status: "pending", unitId: "leaf-1", task: "page" },
      { role: "leaf", status: "running", unitId: "leaf-1" },
      {
        role: "leaf",
        status: "settled",
        unitId: "leaf-1",
        summary: "wrote overview",
        receiptPath: "analysis/receipts/leaf-1.json",
      },
    ];
    let units: ProduceUnit[] = [];
    for (const p of chain) units = foldProduceUnit(units, p);
    assert.deepEqual(
      {
        unitId: units[0]!.unitId,
        role: units[0]!.role,
        status: units[0]!.status,
        task: units[0]!.task,
        summary: units[0]!.summary,
        receiptPath: units[0]!.receiptPath,
      },
      {
        unitId: "leaf-1",
        role: "leaf",
        status: "settled",
        task: "page",
        summary: "wrote overview",
        receiptPath: "analysis/receipts/leaf-1.json",
      },
    );
  });
});

describe("formatPayloadText", () => {
  it("pretty-prints JSON objects", () => {
    const out = formatPayloadText('{"a":1,"b":[2]}');
    assert.match(out, /\n/);
    assert.match(out, /"a": 1/);
  });

  it("truncates overlong payloads with a clear marker", () => {
    const body = JSON.stringify({ x: "y".repeat(200) });
    const out = formatPayloadText(body, 80);
    assert.ok(out.length < body.length + 40);
    assert.match(out, /…\[truncated \d+ chars\]$/);
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
  });

  it("bash is console kind with command on subtitle", () => {
    const d = formatToolDisplay("bash", JSON.stringify({ command: "ls -la packages/web" }));
    assert.equal(d.title, "shell");
    assert.match(d.subtitle ?? "", /ls -la/);
    assert.equal(d.kind, "console");
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

    const gateEn = formatProductCardContent(
      { kind: "gate", gate: "plan", pages: ["a.md", "b.md"] },
      en.agentWorkspace,
    );
    assert.match(gateEn, /2 page/);
  });
});
