import assert from "node:assert/strict";
import { test } from "node:test";
import { toolSummaryTitle } from "./tool-summary.ts";

test("toolSummaryTitle for list_source includes path and count", () => {
  const title = toolSummaryTitle(
    "list_source",
    { path: "src", sourceId: "main" },
    { sourceId: "main", entries: [{ name: "a" }, { name: "b" }] },
    "output-available",
  );
  assert.match(title, /List main:src/);
  assert.match(title, /2 entries/);
});

test("toolSummaryTitle for write_wiki uses path and bytes", () => {
  const title = toolSummaryTitle(
    "write_wiki",
    { path: "overview.md", contentPreview: "# Hi", contentChars: 4 },
    { path: "overview.md", bytes: 12 },
    "output-available",
  );
  assert.match(title, /Write overview\.md/);
  assert.match(title, /12 B/);
});

test("toolSummaryTitle for read_source includes char count", () => {
  const title = toolSummaryTitle(
    "read_source",
    { path: "a.ts" },
    { path: "a.ts", content: "x", contentChars: 100, truncated: true },
    "output-available",
  );
  assert.match(title, /Read a\.ts/);
  assert.match(title, /100 chars/);
});

