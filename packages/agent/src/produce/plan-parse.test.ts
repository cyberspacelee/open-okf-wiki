import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { parsePlanFromAgentText } from "./plan.js";

test("parsePlanFromAgentText accepts a complete fenced WikiRunSpec", () => {
  const expected = defaultWikiRunSpec("Demo");
  const plan = parsePlanFromAgentText(
    ["Here is the plan:", "```json", JSON.stringify(expected), "```"].join("\n"),
  );
  assert.deepEqual(plan, expected);
});

test("parsePlanFromAgentText accepts a complete raw WikiRunSpec", () => {
  const expected = defaultWikiRunSpec("Raw");
  assert.deepEqual(parsePlanFromAgentText(JSON.stringify(expected)), expected);
});

test("parsePlanFromAgentText rejects Markdown page-list compatibility", () => {
  assert.throws(
    () =>
      parsePlanFromAgentText(
        ["### Pages", "- `overview.md` — Project purpose and navigation"].join("\n"),
      ),
    /complete JSON WikiRunSpec/,
  );
});

test("parsePlanFromAgentText rejects a thin legacy JSON plan", () => {
  assert.throws(
    () =>
      parsePlanFromAgentText(
        `\`\`\`json\n${JSON.stringify({ summary: "Thin", pages: [{ path: "x.md", purpose: "x" }] })}\n\`\`\``,
      ),
    /complete JSON WikiRunSpec/,
  );
});
