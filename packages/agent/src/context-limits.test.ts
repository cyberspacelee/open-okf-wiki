import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_COMPACTION_RATIO,
  buildContextInputProcessors,
  resolveContextTargetForWorkspace,
  resolveContextTargetTokens,
} from "./context-limits.js";
import type { WorkspaceConfig } from "@okf-wiki/contract";

test("resolveContextTargetTokens prefers explicit workspace target", () => {
  assert.equal(
    resolveContextTargetTokens({
      contextTargetTokens: 50_000,
      maxContextTokens: 200_000,
    }),
    50_000,
  );
});

test("resolveContextTargetTokens derives 85% of model max context", () => {
  assert.equal(
    resolveContextTargetTokens({ maxContextTokens: 100_000 }),
    Math.floor(100_000 * CONTEXT_COMPACTION_RATIO),
  );
  assert.equal(
    resolveContextTargetTokens({ maxContextTokens: 128_000, ratio: 0.5 }),
    64_000,
  );
});

test("resolveContextTargetTokens returns undefined without config", () => {
  assert.equal(resolveContextTargetTokens({}), undefined);
  assert.equal(resolveContextTargetTokens({ maxContextTokens: 0 }), undefined);
  assert.equal(
    resolveContextTargetTokens({ contextTargetTokens: -1 }),
    undefined,
  );
});

test("resolveContextTargetForWorkspace reads workspace limits", () => {
  const workspace = {
    limits: { requestTimeoutSeconds: 120, contextTargetTokens: 80_000 },
  } as WorkspaceConfig;
  assert.equal(resolveContextTargetForWorkspace(workspace, 200_000), 80_000);
  assert.equal(
    resolveContextTargetForWorkspace(
      { limits: { requestTimeoutSeconds: 120 } } as WorkspaceConfig,
      200_000,
    ),
    Math.floor(200_000 * CONTEXT_COMPACTION_RATIO),
  );
});

test("buildContextInputProcessors returns ToolCallFilter + TokenLimiter", () => {
  const processors = buildContextInputProcessors(8_000);
  assert.equal(processors.length, 2);
  assert.equal(processors[0]!.id, "tool-call-filter");
  assert.equal(processors[1]!.id, "token-limiter");
  assert.deepEqual(buildContextInputProcessors(0), []);
});
