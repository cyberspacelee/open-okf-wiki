import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mapRunGateToGateUi,
  mapSuspendToGateUi,
  optionsForPlanGate,
  optionsForPublishGate,
} from "./gate-ui.js";

const samplePlan = {
  summary: "S",
  pages: [
    { path: "overview.md", purpose: "Overview" },
    { path: "architecture.md", purpose: "Arch" },
  ],
};

test("mapSuspendToGateUi: plan gate options and text", () => {
  const ui = mapSuspendToGateUi({ gate: "plan", plan: samplePlan });
  assert.ok(ui);
  assert.equal(ui!.gate, "plan");
  assert.equal(ui!.plan, samplePlan);
  assert.equal(ui!.pending.mode, "choice_or_input");
  assert.deepEqual(
    ui!.pending.options.map((o) => o.id),
    ["approve", "revise", "deny"],
  );
  assert.match(ui!.pending.options[0]!.label, /Write 2 page/);
  assert.match(ui!.text, /wiki plan/);
});

test("mapSuspendToGateUi: publication gate options", () => {
  const ui = mapSuspendToGateUi({
    gate: "publication",
    pages: ["overview.md"],
    summary: "done",
  });
  assert.ok(ui);
  assert.equal(ui!.gate, "publication");
  assert.equal(ui!.pending.mode, "choice_only");
  assert.deepEqual(
    ui!.pending.options.map((o) => o.id),
    ["approve", "deny"],
  );
  assert.match(ui!.text, /Staged \*\*1\*\* page/);
});

test("mapSuspendToGateUi: unknown / incomplete returns null", () => {
  assert.equal(mapSuspendToGateUi(null), null);
  assert.equal(mapSuspendToGateUi({ gate: "plan" }), null);
  assert.equal(mapSuspendToGateUi({ gate: "other" }), null);
  assert.equal(mapSuspendToGateUi({}), null);
});

test("mapRunGateToGateUi mirrors suspend map options", () => {
  const fromSuspend = mapSuspendToGateUi({ gate: "plan", plan: samplePlan });
  const fromRun = mapRunGateToGateUi({ gate: "plan", plan: samplePlan });
  assert.deepEqual(fromRun?.pending.options, fromSuspend?.pending.options);
  assert.deepEqual(
    mapRunGateToGateUi({ gate: "publication", pages: ["a.md"] })?.pending
      .options,
    optionsForPublishGate(),
  );
});

test("option builders are stable single source", () => {
  assert.equal(optionsForPlanGate(samplePlan).length, 3);
  assert.equal(optionsForPublishGate().length, 2);
});
