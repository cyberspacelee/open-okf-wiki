import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import {
  enterPlanGate,
  isTerminalPhase,
  markAwaitingPublish,
  markCancelled,
  markFailed,
  markHardValidate,
  markProducing,
  markPublished,
  resumeGate,
  shellPhaseLabel,
  startShell,
} from "./wiki-run-shell.js";

function samplePlan() {
  return defaultWikiRunSpec("Test Wiki");
}

describe("WikiRunShell phase machine", () => {
  it("startShell idle without plan", () => {
    const s = startShell();
    assert.equal(s.phase, "idle");
    assert.equal(s.pendingGate, undefined);
    assert.equal(isTerminalPhase(s.phase), false);
  });

  it("startShell with plan awaits plan gate", () => {
    const plan = samplePlan();
    const s = startShell({ plan });
    assert.equal(s.phase, "awaiting_plan");
    assert.equal(s.pendingGate, "plan");
    assert.equal(s.plan?.summary, plan.summary);
  });

  it("startShell skipPlanConfirm is ready to produce", () => {
    const plan = samplePlan();
    const s = startShell({ plan, skipPlanConfirm: true });
    assert.equal(s.phase, "idle");
    assert.ok(s.plan);
    const producing = markProducing(s);
    assert.equal(producing.phase, "producing");
  });

  it("plan approve → produce → hard-validate → publish approve", () => {
    let s = startShell({ plan: samplePlan() });
    s = resumeGate(s, { step: "plan", action: "approve", plan: s.plan });
    assert.equal(s.phase, "idle");
    assert.equal(s.pendingGate, undefined);

    s = markProducing(s);
    assert.equal(s.phase, "producing");

    s = markHardValidate(s, ["index.md"], "wrote index");
    assert.equal(s.phase, "hard_validate");
    assert.deepEqual(s.pages, ["index.md"]);

    s = markAwaitingPublish(s);
    assert.equal(s.phase, "awaiting_publish");
    assert.equal(s.pendingGate, "publish");

    s = resumeGate(s, { step: "publish", action: "approve" });
    assert.equal(s.phase, "published");
    assert.equal(isTerminalPhase(s.phase), true);
  });

  it("plan deny cancels", () => {
    let s = startShell({ plan: samplePlan() });
    s = resumeGate(s, { step: "plan", action: "deny" });
    assert.equal(s.phase, "cancelled");
    assert.match(s.summary ?? "", /declined/i);
  });

  it("plan revise keeps awaiting_plan with feedback notes", () => {
    let s = startShell({ plan: samplePlan() });
    s = resumeGate(s, {
      step: "plan",
      action: "revise",
      feedback: "Add a concepts page",
    });
    assert.equal(s.phase, "awaiting_plan");
    assert.equal(s.pendingGate, "plan");
    assert.equal(s.revisionFeedback, "Add a concepts page");
    assert.match(s.plan?.notes ?? "", /Add a concepts page/);
  });

  it("publish deny → publication_declined", () => {
    let s = startShell({ plan: samplePlan(), skipPlanConfirm: true });
    s = markProducing(s);
    s = markHardValidate(s, ["overview.md"]);
    s = markAwaitingPublish(s);
    s = resumeGate(s, { step: "publish", action: "deny" });
    assert.equal(s.phase, "publication_declined");
  });

  it("auto-publish path via markPublished after hard_validate", () => {
    let s = startShell({ plan: samplePlan(), skipPlanConfirm: true });
    s = markProducing(s);
    s = markHardValidate(s, ["index.md"]);
    s = markPublished(s, "auto published");
    assert.equal(s.phase, "published");
    assert.equal(s.summary, "auto published");
  });

  it("markFailed and markCancelled terminals", () => {
    let s = startShell();
    s = markFailed(s, "boom");
    assert.equal(s.phase, "failed");
    assert.equal(s.error, "boom");

    s = startShell();
    s = markCancelled(s, "stop");
    assert.equal(s.phase, "cancelled");
  });

  it("rejects illegal transitions", () => {
    const s = startShell();
    assert.throws(() => markProducing(s), /plan required|invalid/);
    assert.throws(() => resumeGate(s, { step: "plan", action: "approve" }), /invalid/);
    assert.throws(
      () =>
        resumeGate(startShell({ plan: samplePlan() }), {
          step: "publish",
          action: "revise",
        }),
      /does not support revise/,
    );
  });

  it("enterPlanGate from idle", () => {
    let s = startShell();
    s = enterPlanGate(s, samplePlan());
    assert.equal(s.phase, "awaiting_plan");
    assert.equal(shellPhaseLabel(s.phase), "Awaiting plan confirmation");
  });

  it("rejects resume after terminal", () => {
    let s = startShell({ plan: samplePlan() });
    s = resumeGate(s, { step: "plan", action: "deny" });
    assert.throws(
      () => resumeGate(s, { step: "plan", action: "approve", plan: samplePlan() }),
      /terminal/,
    );
  });
});
