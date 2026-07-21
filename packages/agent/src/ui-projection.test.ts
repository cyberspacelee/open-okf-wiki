import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessageChunk } from "ai";
import {
  buildPhaseProgressData,
  buildPlanProgressData,
  projectListOutput,
  projectReadOutput,
  projectSessionMessages,
  projectToolInput,
  projectToolOutput,
  projectUiMessageChunk,
  projectWriteWikiInput,
  writePathFromToolFields,
  UI_LIST_ENTRIES_MAX,
  UI_READ_CONTENT_MAX,
  UI_WRITE_PREVIEW_MAX,
} from "./ui-projection.js";

test("projectWriteWikiInput drops full content for preview", () => {
  const long = "x".repeat(UI_WRITE_PREVIEW_MAX + 500);
  const out = projectWriteWikiInput({
    path: "overview.md",
    content: long,
  }) as Record<string, unknown>;
  assert.equal(out.path, "overview.md");
  assert.equal(out.content, undefined);
  assert.equal(typeof out.contentPreview, "string");
  assert.ok(String(out.contentPreview).length <= UI_WRITE_PREVIEW_MAX);
  assert.equal(out.contentChars, long.length);
  assert.equal(out.truncated, true);
});

test("projectWriteWikiInput keeps short content as preview only", () => {
  const out = projectWriteWikiInput({
    path: "a.md",
    content: "# Hi\n",
  }) as Record<string, unknown>;
  assert.equal(out.content, undefined);
  assert.equal(out.contentPreview, "# Hi\n");
  assert.equal(out.truncated, false);
  assert.equal(out.contentChars, 5);
});

test("projectReadOutput truncates large content", () => {
  const body = "y".repeat(UI_READ_CONTENT_MAX + 100);
  const out = projectReadOutput({
    path: "src/a.ts",
    sourceId: "main",
    content: body,
  }) as Record<string, unknown>;
  assert.equal(out.path, "src/a.ts");
  assert.equal(out.sourceId, "main");
  assert.ok(String(out.content).length <= UI_READ_CONTENT_MAX);
  assert.equal(out.truncated, true);
  assert.equal(out.contentChars, body.length);
});

test("projectListOutput caps entries", () => {
  const entries = Array.from({ length: UI_LIST_ENTRIES_MAX + 20 }, (_, i) => ({
    name: `f${i}`,
    path: `f${i}`,
    type: "file" as const,
  }));
  const out = projectListOutput({ sourceId: "main", entries }) as Record<
    string,
    unknown
  >;
  assert.ok(Array.isArray(out.entries));
  assert.equal((out.entries as unknown[]).length, UI_LIST_ENTRIES_MAX);
  assert.equal(out.entryCount, entries.length);
  assert.equal(out.truncated, true);
});

test("projectToolInput/Output dispatch by name", () => {
  const w = projectToolInput("write_wiki", {
    path: "p.md",
    content: "hello",
  }) as Record<string, unknown>;
  assert.equal(w.content, undefined);
  assert.equal(w.contentPreview, "hello");

  const r = projectToolOutput("read_source", {
    path: "a.ts",
    content: "z".repeat(UI_READ_CONTENT_MAX + 1),
  }) as Record<string, unknown>;
  assert.equal(r.truncated, true);

  const l = projectToolOutput("list_source", {
    entries: Array.from({ length: 3 }, (_, i) => ({ name: String(i) })),
  }) as Record<string, unknown>;
  assert.equal((l.entries as unknown[]).length, 3);
  assert.equal(l.truncated, undefined);
});

test("projectUiMessageChunk projects tool-input-available", () => {
  const chunk = {
    type: "tool-input-available",
    toolCallId: "c1",
    toolName: "write_wiki",
    input: { path: "x.md", content: "body ".repeat(1000) },
  } as UIMessageChunk;
  const out = projectUiMessageChunk(chunk) as UIMessageChunk & {
    input: Record<string, unknown>;
  };
  assert.equal(out.type, "tool-input-available");
  assert.equal(out.input.content, undefined);
  assert.ok(typeof out.input.contentPreview === "string");
});

test("projectSessionMessages sanitizes historical full write content", () => {
  const messages = projectSessionMessages([
    {
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-write_wiki",
          toolCallId: "t1",
          toolName: "write_wiki",
          state: "output-available",
          input: {
            path: "overview.md",
            content: "# Title\n\n" + "p".repeat(3000),
          },
          output: { path: "overview.md", bytes: 12 },
        },
      ],
      createdAt: new Date().toISOString(),
    },
  ]);
  const part = messages[0]!.parts[0] as {
    input: Record<string, unknown>;
  };
  assert.equal(part.input.content, undefined);
  assert.ok(typeof part.input.contentPreview === "string");
});

test("buildPlanProgressData marks written pages", () => {
  const data = buildPlanProgressData({
    planPages: [{ path: "overview.md" }, { path: "architecture.md" }],
    writtenPaths: ["overview.md"],
    runId: "r1",
    phase: "writing",
  });
  assert.equal(data.runId, "r1");
  assert.equal(data.phase, "writing");
  assert.equal(data.pages.find((p) => p.path === "overview.md")?.status, "written");
  assert.equal(
    data.pages.find((p) => p.path === "architecture.md")?.status,
    "pending",
  );
});

test("buildPhaseProgressData and writePathFromToolFields", () => {
  const phase = buildPhaseProgressData({ phase: "planning", runId: "r1" });
  assert.equal(phase.phase, "planning");
  assert.equal(
    writePathFromToolFields({ path: "./a.md" }, { path: "a.md", bytes: 1 }),
    "a.md",
  );
});

test("projectWorkflowDataPart strips workspace dumps", async () => {
  const { projectWorkflowDataPart } = await import("./ui-projection.js");
  const slim = projectWorkflowDataPart({
    name: "wikiRunWorkflow",
    status: "failed",
    steps: {
      "plan-gate": {
        name: "plan-gate",
        status: "failed",
        input: {
          workspace: { rootPath: "/secret", sources: [{ path: "/x" }] },
        },
        error: { message: "plan aborted" },
      },
    },
  }) as Record<string, unknown>;
  assert.equal(slim.name, "wikiRunWorkflow");
  assert.equal(slim.status, "failed");
  const steps = slim.steps as Record<string, { error?: string; status?: string }>;
  assert.equal(steps["plan-gate"]?.status, "failed");
  assert.match(steps["plan-gate"]?.error ?? "", /plan aborted/);
  assert.equal(
    JSON.stringify(slim).includes("rootPath"),
    false,
    "must not leak workspace rootPath",
  );
});
