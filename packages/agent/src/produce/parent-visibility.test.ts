import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachWorkUnitSink,
  createParentVisibilityReducer,
  messageFromPiContent,
} from "./parent-visibility.js";
import { recordingProduceEvents } from "./events.js";

describe("parent-visibility", () => {
  it("extracts thinking/text from Pi content blocks", () => {
    const msg = messageFromPiContent([
      { type: "thinking", thinking: "plan first" },
      { type: "text", text: "hello" },
    ]);
    assert.deepEqual(msg, { thinking: "plan first", text: "hello" });
  });

  it("snapshot-replaces message on message_update", () => {
    const r = createParentVisibilityReducer({
      unitId: "leaf-1",
      role: "leaf",
      task: "research",
      runId: "run-1",
    });
    r.open();
    r.onPiEvent("message_update", {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
    });
    assert.equal(r.getUnit().message?.text, "first");

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
    const u = r.getUnit();
    assert.equal(u.message?.thinking, "hmm");
    assert.equal(u.message?.text, "second");
    assert.equal(u.status, "running");
  });

  it("tracks tools by toolCallId through start/update/end", () => {
    const r = createParentVisibilityReducer({
      unitId: "leaf-tools",
      role: "leaf",
      runId: "run-1",
    });
    r.open();
    r.onPiEvent("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "read",
      args: { path: "src/a.ts" },
    });
    let tools = r.getUnit().tools ?? [];
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
    tools = r.getUnit().tools ?? [];
    assert.deepEqual(tools[0]!.output, { chunk: 1 });

    r.onPiEvent("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "read",
      result: { content: "file body" },
      isError: false,
    });
    tools = r.getUnit().tools ?? [];
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
    tools = r.getUnit().tools ?? [];
    assert.equal(tools.length, 2);
    const errTool = tools.find((t) => t.toolCallId === "tc2");
    assert.equal(errTool?.state, "output-error");
    assert.equal(errTool?.errorText, "boom");
  });

  it("settle and fail are terminal; late Pi events ignored for status", () => {
    const r = createParentVisibilityReducer({
      unitId: "planner",
      role: "planner",
      runId: "run-1",
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
    assert.equal(r.getUnit().status, "settled");
    assert.equal(r.getUnit().message, undefined);

    const f = createParentVisibilityReducer({
      unitId: "leaf-x",
      role: "leaf",
      runId: "run-1",
    });
    f.open();
    const failed = f.fail("provider down");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "provider down");
    f.onPiEvent("agent_start", {});
    assert.equal(f.getUnit().status, "failed");
  });

  it("agent_start / message_start mark running without inventing prose", () => {
    const r = createParentVisibilityReducer({
      unitId: "domain-1",
      role: "domain",
      runId: "run-1",
    });
    assert.equal(r.getUnit().status, "pending");
    r.onPiEvent("agent_start", { type: "agent_start" });
    const u = r.getUnit();
    assert.equal(u.status, "running");
    assert.equal(u.message, undefined);
    assert.equal(u.tools, undefined);
  });

  it("concurrent unitIds stay independent", () => {
    const a = createParentVisibilityReducer({
      unitId: "leaf-a",
      role: "leaf",
      parentId: "domain-1",
      runId: "run-1",
    });
    const b = createParentVisibilityReducer({
      unitId: "leaf-b",
      role: "leaf",
      parentId: "domain-1",
      runId: "run-1",
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
    assert.equal(a.getUnit().unitId, "leaf-a");
    assert.equal(a.getUnit().message?.text, "from A");
    assert.equal(a.getUnit().tools, undefined);
    assert.equal(b.getUnit().unitId, "leaf-b");
    assert.equal(b.getUnit().message, undefined);
    assert.equal(b.getUnit().tools?.[0]?.toolCallId, "t-b");
  });

  it("attachWorkUnitSink records work_unit only", () => {
    const { sink, events } = recordingProduceEvents();
    const unit = attachWorkUnitSink(sink, {
      unitId: "planner",
      role: "planner",
      task: "draft plan",
      runId: "run-z",
    });
    unit.open();
    unit.onPiEvent("message_update", {
      message: { content: [{ type: "text", text: "scanning" }] },
    });
    unit.settle("done");

    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.every((k) => k === "work_unit"));
    assert.equal(events.length, 3);
    const last = events[2]!.payload as { status: string; runId: string };
    assert.equal(last.status, "settled");
    assert.equal(last.runId, "run-z");
  });
});
