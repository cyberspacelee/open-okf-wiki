import assert from "node:assert/strict";
import test from "node:test";
import { truncateUtf8 } from "../dist/delegate-contracts.js";
import { decodeUtf8Fatal, summarizeWikiMarkdown } from "../dist/wiki-work-files.js";

test("truncateUtf8 respects ASCII, Han, emoji, and combining code point boundaries", () => {
  assert.equal(truncateUtf8("abcd", 3), "abc");
  assert.equal(truncateUtf8("中文", 5), "中");
  assert.equal(truncateUtf8("A😀B", 5), "A😀");
  assert.equal(truncateUtf8("e\u0301x", 2), "e");
  assert.equal(Buffer.byteLength(truncateUtf8("中😀e\u0301", 8), "utf8") <= 8, true);
  assert.throws(() => truncateUtf8("x", -1), /non-negative safe integer/);
});

test("decodeUtf8Fatal decodes valid bytes and rejects malformed UTF-8", () => {
  assert.equal(decodeUtf8Fatal(Buffer.from("中文😀", "utf8")), "中文😀");
  assert.throws(() => decodeUtf8Fatal(Uint8Array.from([0xc3, 0x28])), /Malformed UTF-8/);
});

test("completion summary skips Markdown structure and remains UTF-8 bounded", () => {
  const prose = `Published current reviewed coverage ${"😀".repeat(300)}`;
  const summary = summarizeWikiMarkdown([
    "# Completion",
    "",
    "- **Status:** complete",
    "",
    prose,
  ].join("\n"), "completion.md");
  assert.equal(summary, truncateUtf8(prose, 1024));
  assert.equal(Buffer.byteLength(summary, "utf8"), 1024);
});

test("summarizeWikiMarkdown derives its summary from Skill-format substantive prose", () => {
  const summary = summarizeWikiMarkdown([
    "",
    "# Research Handoff",
    "",
    "## Scope",
    "",
    "- **Source:** source",
    "",
    "## Coverage",
    "",
    "The runtime maps each request to a pinned Source",
    "and preserves conflicts for later synthesis.",
    "",
    "## Evidence",
    "",
    "- [runtime.ts](source/runtime.ts#L1-L10)",
  ].join("\n"));
  assert.equal(summary, "The runtime maps each request to a pinned Source and preserves conflicts for later synthesis.");
});

test("summarizeWikiMarkdown accepts an outline-only body and falls back for the summary", () => {
  const summary = summarizeWikiMarkdown([
    "# Research Handoff",
    "## Scope",
    "- **Source:** source",
    "## Coverage",
    "- **Covered:** assignment-1",
  ].join("\n"));
  assert.equal(summary, "**Source:** source");
  assert.ok(Buffer.byteLength(summary, "utf8") <= 1024);
});
