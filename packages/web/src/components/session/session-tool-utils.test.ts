import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "ai";
import {
  agentDisplayName,
  groupPartsForRender,
  isAgentToolName,
  REGISTERED_TOOL_BODY_NAMES,
  unwrapToolPayload,
  writtenPathsFromMessages,
} from "./session-tool-utils.ts";

test("writtenPathsFromMessages aggregates across messages", () => {
  const messages = [
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-write_wiki",
          toolName: "write_wiki",
          state: "output-available",
          input: { path: "overview.md", contentPreview: "x" },
          output: { path: "overview.md", bytes: 1 },
        },
      ],
    },
    {
      id: "a2",
      role: "assistant",
      parts: [
        {
          type: "tool-write_wiki",
          toolName: "write_wiki",
          state: "output-available",
          input: { path: "./architecture.md" },
          output: { path: "architecture.md", bytes: 2 },
        },
      ],
    },
  ] as UIMessage[];

  const paths = writtenPathsFromMessages(messages);
  assert.equal(paths.size, 2);
  assert.ok(paths.has("overview.md"));
  assert.ok(paths.has("architecture.md"));
});

test("groupPartsForRender batches consecutive completed reads", () => {
  const parts = [
    { type: "text", text: "hi" },
    {
      type: "tool-read_source",
      toolName: "read_source",
      state: "output-available",
      input: { path: "a.ts" },
      output: { path: "a.ts", content: "1" },
    },
    {
      type: "tool-read_source",
      toolName: "read_source",
      state: "output-available",
      input: { path: "b.ts" },
      output: { path: "b.ts", content: "2" },
    },
    {
      type: "tool-list_source",
      toolName: "list_source",
      state: "output-available",
      input: { path: "" },
      output: { entries: [] },
    },
  ] as UIMessage["parts"];

  const items = groupPartsForRender(parts);
  assert.equal(items[0]!.kind, "single");
  assert.equal(items[1]!.kind, "batch");
  if (items[1]!.kind === "batch") {
    assert.equal(items[1].toolName, "read_source");
    assert.equal(items[1].parts.length, 2);
  }
  assert.equal(items[2]!.kind, "single");
});

test("isAgentToolName detects domain/leaf/reviewer", () => {
  assert.equal(isAgentToolName("domainResearcher"), true);
  assert.equal(isAgentToolName("agent-leafResearcher"), true);
  assert.equal(isAgentToolName("read_source"), false);
  assert.equal(agentDisplayName("domainResearcher"), "Domain Researcher");
});

test("unwrapToolPayload peels thin result envelopes", () => {
  const inner = { entries: [{ name: "a", path: "a", type: "file" }] };
  assert.deepEqual(unwrapToolPayload({ result: inner }), inner);
  assert.deepEqual(unwrapToolPayload(inner), inner);
});

test("REGISTERED_TOOL_BODY_NAMES lists wiki discovery tools", () => {
  assert.ok(REGISTERED_TOOL_BODY_NAMES.includes("list_source"));
  assert.ok(REGISTERED_TOOL_BODY_NAMES.includes("write_wiki"));
  assert.ok(REGISTERED_TOOL_BODY_NAMES.includes("glob_source"));
  assert.ok(REGISTERED_TOOL_BODY_NAMES.includes("search_source"));
});

test("writtenPathsFromMessages includes data-plan-progress written pages", () => {
  const messages = [
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "data-plan-progress",
          data: {
            pages: [
              { path: "overview.md", status: "written" },
              { path: "x.md", status: "pending" },
            ],
          },
        },
      ],
    },
  ] as UIMessage[];
  const paths = writtenPathsFromMessages(messages);
  assert.ok(paths.has("overview.md"));
  assert.equal(paths.has("x.md"), false);
});
