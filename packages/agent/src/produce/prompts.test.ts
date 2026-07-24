import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import { plannerPrompt } from "./prompts.js";

const layout: RunWorkdirLayout = {
  runWorkDir: "/run",
  sourcesDir: "/run/sources",
  skillDir: "/run/skill",
  wikiDir: "/run/wiki",
  analysisDir: "/run/analysis",
  sourceMounts: new Map([["main", "/run/sources/main"]]),
};

describe("planner prompt", () => {
  it("includes operator notes in the initial planning request", () => {
    const prompt = plannerPrompt({
      layout,
      workspaceName: "Demo",
      operatorNotes: "Focus on the runtime boundary.",
    });

    assert.match(prompt, /Operator-requested focus:\nFocus on the runtime boundary\./);
  });
});
