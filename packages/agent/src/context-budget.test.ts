/**
 * End-to-end unit checks for the Wiki Run context budget pipeline:
 * resolve target → processors → OM thresholds under hard cap.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_COMPACTION_RATIO,
  buildContextInputProcessors,
  resolveContextTargetTokens,
} from "./context-limits.js";
import {
  createWikiRunMemory,
  resolveObservationMessageTokens,
  resolveReflectionObservationTokens,
} from "./wiki-memory.js";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { resolveContextTargetForWorkspace } from "./context-limits.js";

test("full pipeline: model max → target → processors + OM under cap", () => {
  process.env.OKF_WIKI_MASTRA_STORAGE = "memory";

  const maxContextTokens = 128_000;
  const target = resolveContextTargetTokens({ maxContextTokens });
  assert.equal(target, Math.floor(maxContextTokens * CONTEXT_COMPACTION_RATIO));
  assert.ok(target !== undefined);

  const processors = buildContextInputProcessors(target!);
  assert.equal(processors.length, 2);

  const obs = resolveObservationMessageTokens(target!);
  const ref = resolveReflectionObservationTokens(target!);
  assert.ok(obs < target!);
  assert.ok(ref < target!);

  const memory = createWikiRunMemory({
    model: "openai/test",
    contextTargetTokens: target!,
  });
  assert.ok(memory.getMergedThreadConfig().observationalMemory);
});

test("full pipeline: explicit workspace target wins over model max", () => {
  const workspace = {
    limits: { requestTimeoutSeconds: 120, contextTargetTokens: 40_000 },
  } as WorkspaceConfig;
  assert.equal(resolveContextTargetForWorkspace(workspace, 200_000), 40_000);
});

test("no budget → no processors and no OM factory input", () => {
  assert.equal(resolveContextTargetTokens({}), undefined);
  assert.deepEqual(buildContextInputProcessors(0), []);
});
