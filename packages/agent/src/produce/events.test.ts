import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachProgress,
  createProgressTracker,
  messageFromPiContent,
  recordingProduceEvents,
} from "./events.js";

describe("produce progress (onProgress)", () => {
  it("extracts thinking/text from Pi content blocks", () => {
    const msg = messageFromPiContent([
      { type: "thinking", thinking: "plan first" },
      { type: "text", text: "hello" },
    ]);
    assert.deepEqual(msg, { thinking: "plan first", text: "hello" });
  });

  it("snapshot-replaces message on message_update", () => {
    const r = createProgressTracker({
      unitId: "leaf-1",
      role: "leaf",
      task: "research",
    });
    r.open();
    r.onPiEvent("message_update", {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
    });
    assert.equal(r.get().message?.text, "first");

    r.onPiEvent("message_update", {
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "second" },
        ],
      },
    });
    const u = r.get();
    assert.equal(u.message?.thinking, "hmm");
    assert.equal(u.message?.text, "second");
    assert.equal(u.status, "running");
  });

  it("tracks tools by toolCallId through start/update/end", () => {
    const r = createProgressTracker({
      unitId: "leaf-tools",
      role: "leaf",
    });
    r.open();
    r.onPiEvent("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "read",
      args: { path: "src/a.ts" },
    });
    let tools = r.get().tools ?? [];
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.toolCallId, "tc1");
    assert.equal(tools[0]!.state, "input-available");
    assert.deepEqual(tools[0]!.input, { path: "src/a.ts" });

    r.onPiEvent("tool_execution_update", {
      type: "tool_execution_update",
      toolCallId: "tc1",
      toolName: "read",
      args: { path: "src/a.ts" },
      partialResult: { chunk: 1 },
    });
    tools = r.get().tools ?? [];
    assert.deepEqual(tools[0]!.output, { chunk: 1 });

    r.onPiEvent("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "read",
      result: { content: "file body" },
      isError: false,
    });
    tools = r.get().tools ?? [];
    assert.equal(tools[0]!.state, "output-available");
    assert.deepEqual(tools[0]!.output, { content: "file body" });

    r.onPiEvent("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "tc2",
      toolName: "grep",
      args: { pattern: "foo" },
    });
    r.onPiEvent("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tc2",
      toolName: "grep",
      result: "boom",
      isError: true,
    });
    tools = r.get().tools ?? [];
    assert.equal(tools.length, 2);
    const errTool = tools.find((t) => t.toolCallId === "tc2");
    assert.equal(errTool?.state, "output-error");
    assert.equal(errTool?.errorText, "boom");
  });

  it("settle and fail are terminal; late Pi events ignored for status", () => {
    const r = createProgressTracker({
      unitId: "planner",
      role: "planner",
    });
    r.open();
    const settled = r.settle("plan ready", {
      receiptPath: "analysis/receipts/planner.json",
    });
    assert.equal(settled.status, "settled");
    assert.equal(settled.summary, "plan ready");
    assert.equal(settled.receiptPath, "analysis/receipts/planner.json");

    r.onPiEvent("message_update", {
      message: { content: [{ type: "text", text: "late" }] },
    });
    assert.equal(r.get().status, "settled");
    assert.equal(r.get().message, undefined);

    const f = createProgressTracker({
      unitId: "leaf-x",
      role: "leaf",
    });
    f.open();
    const failed = f.fail("provider down");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "provider down");
    f.onPiEvent("agent_start", {});
    assert.equal(f.get().status, "failed");
  });

  it("agent_start / message_start mark running without inventing prose", () => {
    const r = createProgressTracker({
      unitId: "domain-1",
      role: "domain",
    });
    assert.equal(r.get().status, "pending");
    r.onPiEvent("agent_start", { type: "agent_start" });
    const u = r.get();
    assert.equal(u.status, "running");
    assert.equal(u.message, undefined);
    assert.equal(u.tools, undefined);
  });

  it("concurrent unitIds stay independent", () => {
    const a = createProgressTracker({
      unitId: "leaf-a",
      role: "leaf",
      parentId: "domain-1",
    });
    const b = createProgressTracker({
      unitId: "leaf-b",
      role: "leaf",
      parentId: "domain-1",
    });
    a.open();
    b.open();
    a.onPiEvent("message_update", {
      message: { content: [{ type: "text", text: "from A" }] },
    });
    b.onPiEvent("tool_execution_start", {
      toolCallId: "t-b",
      toolName: "ls",
      args: {},
    });
    assert.equal(a.get().unitId, "leaf-a");
    assert.equal(a.get().message?.text, "from A");
    assert.equal(a.get().tools, undefined);
    assert.equal(b.get().unitId, "leaf-b");
    assert.equal(b.get().message, undefined);
    assert.equal(b.get().tools?.[0]?.toolCallId, "t-b");
  });

  it("attachProgress records onProgress only (never work_unit)", () => {
    const { sink, events } = recordingProduceEvents();
    const unit = attachProgress(sink, {
      unitId: "planner",
      role: "planner",
      task: "draft plan",
    });
    unit.open();
    unit.onPiEvent("message_update", {
      message: { content: [{ type: "text", text: "scanning" }] },
    });
    unit.settle("done");

    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.every((k) => k === "onProgress"));
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => e.kind !== "work_unit"));
    const last = events[2]!.payload as { status: string; unitId?: string };
    assert.equal(last.status, "settled");
    assert.equal(last.unitId, "planner");
  });
});
