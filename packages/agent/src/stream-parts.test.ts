import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixtureStreamParts,
  projectMastraChunk,
  sanitizeSummary,
} from "./stream-parts.js";

test("projectMastraChunk maps text-delta", () => {
  const parts = projectMastraChunk({
    type: "text-delta",
    payload: { text: "Hello **wiki**" },
  });
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.type, "text");
  assert.equal(parts[0]!.text, "Hello **wiki**");
});

test("projectMastraChunk maps tool-call and redacts large content bodies", () => {
  const parts = projectMastraChunk({
    type: "tool-call",
    payload: {
      toolName: "write_wiki",
      toolCallId: "c1",
      args: { path: "overview.md", content: "x".repeat(900) },
    },
  });
  assert.equal(parts[0]!.type, "tool");
  assert.equal(parts[0]!.toolName, "write_wiki");
  assert.ok(parts[0]!.inputSummary?.includes("overview.md"));
  assert.ok(
    parts[0]!.inputSummary?.includes("[omitted]") ||
      (parts[0]!.inputSummary?.length ?? 0) <= 400,
  );
});

test("projectMastraChunk drops reasoning chunks", () => {
  assert.deepEqual(
    projectMastraChunk({ type: "reasoning-delta", payload: { text: "secret" } }),
    [],
  );
});

test("sanitizeSummary redacts api keys", () => {
  const s = sanitizeSummary("Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789");
  assert.ok(s);
  assert.ok(!s!.includes("sk-abcdefghijklmnopqrstuvwxyz"));
});

test("fixtureStreamParts includes text tool and subagent", () => {
  const parts = [...fixtureStreamParts("run-1")];
  assert.ok(parts.some((p) => p.type === "text"));
  assert.ok(parts.some((p) => p.toolName === "list_source"));
  assert.ok(parts.some((p) => p.toolName === "delegate_domain"));
  assert.ok(parts.some((p) => p.toolName === "write_wiki"));
});
