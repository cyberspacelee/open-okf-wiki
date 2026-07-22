import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OM_MIN_MESSAGE_TOKENS,
  OM_OBSERVATION_RATIO,
  OM_REFLECTION_RATIO,
  createWikiRunMemory,
  resolveObservationMessageTokens,
  resolveReflectionObservationTokens,
  wikiRunMemoryOption,
} from "./wiki-memory.js";

test("resolveObservationMessageTokens uses 40% of context target with floor", () => {
  assert.equal(
    resolveObservationMessageTokens(100_000),
    Math.floor(100_000 * OM_OBSERVATION_RATIO),
  );
  // Small budgets: clamp under 70% of target (never above hard TokenLimiter).
  assert.equal(resolveObservationMessageTokens(1_000), 700);
  assert.equal(resolveObservationMessageTokens(0), OM_MIN_MESSAGE_TOKENS);
});

test("resolveReflectionObservationTokens uses 30% of context target with floor", () => {
  assert.equal(
    resolveReflectionObservationTokens(100_000),
    Math.floor(100_000 * OM_REFLECTION_RATIO),
  );
  assert.equal(resolveReflectionObservationTokens(1_000), 700);
});

test("OM thresholds stay below TokenLimiter budget", () => {
  for (const target of [5_000, 10_000, 50_000, 128_000]) {
    const obs = resolveObservationMessageTokens(target);
    const ref = resolveReflectionObservationTokens(target);
    assert.ok(obs < target, `obs ${obs} < target ${target}`);
    assert.ok(ref < target, `ref ${ref} < target ${target}`);
    assert.ok(obs <= Math.floor(target * 0.7));
  }
});

test("wikiRunMemoryOption is run-scoped", () => {
  const opt = wikiRunMemoryOption("run-1", "root");
  assert.equal(opt.thread, "wiki-run-run-1-root");
  assert.equal(opt.resource, "wiki-run-run-1");
});

test("createWikiRunMemory builds Memory with observational config", () => {
  process.env.OKF_WIKI_MASTRA_STORAGE = "memory";
  const memory = createWikiRunMemory({
    model: "openai/test-model",
    contextTargetTokens: 50_000,
  });
  assert.ok(memory);
  assert.equal(typeof memory.getMergedThreadConfig, "function");
  const config = memory.getMergedThreadConfig();
  assert.ok(config.observationalMemory);
});
