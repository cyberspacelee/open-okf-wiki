import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOperatorFixtureModel } from "./operator-fixture-model.js";

const context = {
  systemPrompt: "fixture",
  messages: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Produce the wiki" }],
      timestamp: Date.now(),
    },
  ],
};

describe("Operator fixture model", () => {
  it("queues a genuine model tool call and final response", async () => {
    const fixture = await createOperatorFixtureModel();
    fixture.queueWikiProduceTurn("Focus on architecture");

    const toolCall = await fixture.modelRuntime.completeSimple(fixture.model, context);
    assert.equal(toolCall.stopReason, "toolUse");
    assert.deepEqual(toolCall.content[0], {
      type: "toolCall",
      id: (toolCall.content[0] as { id: string }).id,
      name: "wiki_produce",
      arguments: { notes: "Focus on architecture" },
    });

    const final = await fixture.modelRuntime.completeSimple(fixture.model, context);
    assert.equal(final.content[0]?.type, "text");
    assert.equal(final.content[0]?.type === "text" ? final.content[0].text : "", "Wiki published.");
  });
});
