import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "ai";
import { extractRunTimelineChrome } from "./run-timeline-extract.ts";

test("extractRunTimelineChrome pulls phase steps, pages, sources", () => {
  const parts = [
    {
      type: "data-progress",
      data: {
        phase: "writing",
        label: "Writing",
        steps: [
          { id: "planning", label: "Plan", status: "complete" },
          { id: "writing", label: "Write", status: "active" },
        ],
      },
    },
    {
      type: "data-plan-progress",
      data: {
        pages: [
          { path: "overview.md", status: "written" },
          { path: "arch.md", status: "pending" },
        ],
      },
    },
    {
      type: "data-sources-index",
      data: {
        sources: [{ path: "README.md", sourceId: "main" }],
      },
    },
    {
      type: "data-agent-span",
      data: {
        spanId: "1",
        agentId: "domainResearcher",
        role: "domain",
        status: "complete",
      },
    },
    { type: "data-plan", data: { summary: "s" } },
  ] as UIMessage["parts"];

  const chrome = extractRunTimelineChrome(parts);
  assert.equal(chrome.phaseSteps.length, 2);
  assert.equal(chrome.pages.length, 2);
  assert.equal(chrome.sources.length, 1);
  assert.equal(chrome.agentSpans.length, 1);
  assert.equal(chrome.hasPlan, true);
});
