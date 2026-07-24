import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWikiRunSpec } from "./run.js";
import { WikiProduceToolDetailsSchema } from "./wiki-produce.js";

test("WikiProduceToolDetailsSchema exposes only stable Run and gate facts", () => {
  const details = WikiProduceToolDetailsSchema.parse({
    status: "awaiting_plan",
    runId: "run-1",
    spec: defaultWikiRunSpec("demo"),
    pages: [],
    summary: "Awaiting WikiRunSpec approval",
    defects: null,
  });
  assert.equal(details.status, "awaiting_plan");
  assert.equal(details.spec?.pages.length, 1);
});

test("WikiProduceToolDetailsSchema accepts optional children projection", () => {
  const details = WikiProduceToolDetailsSchema.parse({
    status: "planning",
    runId: "run-1",
    summary: "Planning WikiRunSpec",
    children: [
      {
        id: "plan",
        role: "plan",
        status: "running",
        summary: "Inspecting sources…",
        items: [
          { type: "text", text: "Looking at sources/main" },
          { type: "toolCall", name: "ls", argsSummary: "sources/", status: "done" },
        ],
        usage: { turns: 1, contextTokens: 1200 },
      },
    ],
  });
  assert.equal(details.children?.[0]?.role, "plan");
  assert.equal(details.children?.[0]?.items?.length, 2);
});

test("WikiProduceToolDetailsSchema rejects duplicate Pi framing and phase", () => {
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "planning",
      toolCallId: "call-1",
    }).success,
    false,
  );
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "planning",
      phase: "planning",
    }).success,
    false,
  );
});
