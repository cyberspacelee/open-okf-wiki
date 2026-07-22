import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPhaseSteps,
  noteSourceHit,
  roleFromAgentId,
  summarizePrompt,
} from "./run-timeline.js";

test("buildPhaseSteps marks active/complete relative to phase", () => {
  const steps = buildPhaseSteps("writing", { written: 1, total: 3 });
  const write = steps.find((s) => s.id === "writing");
  assert.equal(write?.status, "active");
  assert.match(write?.label ?? "", /1\/3/);
  const plan = steps.find((s) => s.id === "planning");
  assert.equal(plan?.status, "complete");
});

test("roleFromAgentId classifies roles", () => {
  assert.equal(roleFromAgentId("domainResearcher"), "domain");
  assert.equal(roleFromAgentId("okf-wiki-leaf"), "leaf");
  assert.equal(roleFromAgentId("okf-wiki-reviewer-1"), "reviewer");
});

test("noteSourceHit dedupes paths", () => {
  const map = new Map();
  noteSourceHit(map, { path: "a.ts", sourceId: "main" });
  noteSourceHit(map, { path: "a.ts", sourceId: "main", lines: "L1" });
  assert.equal(map.size, 1);
  assert.equal(map.get("main:a.ts")?.lines, "L1");
});

test("summarizePrompt truncates", () => {
  assert.ok(summarizePrompt("x".repeat(200), 50).endsWith("…"));
});
