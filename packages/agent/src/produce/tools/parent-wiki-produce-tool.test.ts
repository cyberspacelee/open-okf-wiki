import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beginParentWikiProduceTool, WIKI_PRODUCE_TOOL_NAME } from "./parent-wiki-produce-tool.js";

describe("beginParentWikiProduceTool", () => {
  it("emits Pi tool lifecycle and appends assistant + toolResult messages", () => {
    const messages: unknown[] = [];
    const events: Array<Record<string, unknown>> = [];
    const handle = beginParentWikiProduceTool({
      sessionManager: {
        appendMessage: (m) => {
          messages.push(m);
          return `id_${messages.length}`;
        },
      },
      emit: (e) => {
        events.push(e);
      },
      runId: "run_test",
    });

    assert.equal(handle.toolName, WIKI_PRODUCE_TOOL_NAME);
    assert.ok(handle.toolCallId.includes("wiki_produce"));
    assert.equal(messages.length, 1);
    const asst = messages[0] as { role: string; content: Array<{ type: string; name: string }> };
    assert.equal(asst.role, "assistant");
    assert.equal(asst.content[0]?.type, "toolCall");
    assert.equal(asst.content[0]?.name, WIKI_PRODUCE_TOOL_NAME);

    const types = events.map((e) => e.type);
    assert.ok(types.includes("message_start"));
    assert.ok(types.includes("tool_execution_start"));

    handle.onUpdate({
      role: "planner",
      status: "running",
      unitId: "planner",
      task: "discover",
    });
    assert.ok(events.some((e) => e.type === "tool_execution_update"));

    handle.complete({
      details: {
        role: "root",
        status: "settled",
        unitId: "root",
        summary: "done",
        children: [{ role: "planner", status: "settled", unitId: "planner" }],
      },
      summaryText: "done",
    });
    assert.equal(messages.length, 2);
    const tr = messages[1] as {
      role: string;
      toolName: string;
      details: { status: string };
    };
    assert.equal(tr.role, "toolResult");
    assert.equal(tr.toolName, WIKI_PRODUCE_TOOL_NAME);
    assert.equal(tr.details.status, "settled");
    assert.ok(events.some((e) => e.type === "tool_execution_end"));
  });
});
