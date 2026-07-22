import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlanFromAgentText } from "./run.js";

test("parsePlanFromAgentText extracts markdown list pages", () => {
  const plan = parsePlanFromAgentText(
    [
      "Source-grounded overview for Demo.",
      "",
      "### Pages",
      "- `overview.md` — Project purpose and navigation",
      "- `architecture.md` — Runtime layout and modules",
      "- concepts.md: Domain vocabulary",
    ].join("\n"),
    { workspaceName: "Demo" },
  );
  assert.equal(plan.summary, "Source-grounded overview for Demo.");
  assert.equal(plan.pages.length, 3);
  assert.equal(plan.pages[0]!.path, "overview.md");
  assert.equal(plan.pages[1]!.path, "architecture.md");
  assert.equal(plan.pages[2]!.path, "concepts.md");
  assert.match(plan.pages[2]!.purpose, /vocabulary/i);
});

test("parsePlanFromAgentText prefers fenced JSON pages", () => {
  const plan = parsePlanFromAgentText(
    [
      "Here is the plan:",
      "```json",
      JSON.stringify({
        summary: "JSON plan",
        pages: [
          { path: "overview.md", purpose: "Intro" },
          { path: "api.md", purpose: "HTTP surface" },
        ],
      }),
      "```",
    ].join("\n"),
    { workspaceName: "Demo" },
  );
  assert.equal(plan.summary, "JSON plan");
  assert.equal(plan.pages.length, 2);
  assert.equal(plan.pages[1]!.path, "api.md");
});

test("parsePlanFromAgentText falls back to prior pages", () => {
  const plan = parsePlanFromAgentText("No list here, just prose.", {
    workspaceName: "Demo",
    prior: {
      version: 1,
      summary: "Prior",
      audience: "Engineers",
      domains: [],
      pages: [
        {
          path: "overview.md",
          purpose: "Keep me",
          domainIds: [],
          questions: [],
          critical: true,
        },
      ],
      openQuestions: [],
      acceptance: {
        reviewRequired: true,
        maxRepairRounds: 2,
        blockingSeverities: ["blocking"],
      },
      changelog: [],
      notes: "Operator revision feedback:\nadd concepts",
    },
  });
  assert.equal(plan.pages.length, 1);
  assert.equal(plan.pages[0]!.path, "overview.md");
  assert.match(plan.notes ?? "", /revision feedback/i);
});

test("parsePlanFromAgentText default overview when empty", () => {
  const plan = parsePlanFromAgentText("", { workspaceName: "Empty" });
  assert.equal(plan.pages.length, 1);
  assert.equal(plan.pages[0]!.path, "overview.md");
  assert.match(plan.summary, /Empty/);
});
