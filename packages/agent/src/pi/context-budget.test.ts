import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactionSettingsFromBudget,
  resolveContextBudget,
} from "./context-budget.js";

describe("context-budget", () => {
  it("defaults to 128k window and 85% target", () => {
    const b = resolveContextBudget({});
    assert.equal(b.contextWindow, 128_000);
    assert.equal(b.contextTarget, Math.floor(128_000 * 0.85));
    assert.equal(b.reserveTokens, b.contextWindow - b.contextTarget);
    assert.ok(b.reserveTokens >= 2048);
  });

  it("uses maxContextTokens from profile", () => {
    const b = resolveContextBudget({ maxContextTokens: 64_000 });
    assert.equal(b.contextWindow, 64_000);
    assert.equal(b.contextTarget, Math.floor(64_000 * 0.85));
  });

  it("honors explicit contextTargetTokens", () => {
    const b = resolveContextBudget({
      maxContextTokens: 100_000,
      contextTargetTokens: 70_000,
    });
    assert.equal(b.contextWindow, 100_000);
    assert.equal(b.contextTarget, 70_000);
    assert.equal(b.reserveTokens, 30_000);
  });

  it("clamps target below window", () => {
    const b = resolveContextBudget({
      maxContextTokens: 10_000,
      contextTargetTokens: 50_000,
    });
    assert.ok(b.contextTarget < b.contextWindow);
    assert.ok(b.reserveTokens >= 2048);
  });

  it("builds compaction settings", () => {
    const b = resolveContextBudget({ maxContextTokens: 80_000 });
    const c = compactionSettingsFromBudget(b);
    assert.equal(c.enabled, true);
    assert.equal(c.reserveTokens, b.reserveTokens);
    assert.equal(c.keepRecentTokens, b.keepRecentTokens);
  });
});
