import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import {
  evaluateWikiPublishable,
  hasBlockingDefects,
  mergeDefectReports,
  parseDefectReportFromText,
  writeMergedDefects,
} from "./defects.js";
import { writeWikiRunSpec } from "./spec-store.js";

test("parseDefectReportFromText recognizes NO_DEFECTS", () => {
  const r = parseDefectReportFromText("All good.\nNO_DEFECTS\n", "r1");
  assert.equal(r.clean, true);
  assert.equal(r.defects.length, 0);
});

test("parseDefectReportFromText parses fenced JSON", () => {
  const r = parseDefectReportFromText(
    [
      "```json",
      JSON.stringify({
        clean: false,
        defects: [
          {
            severity: "blocking",
            code: "thin_page",
            path: "overview.md",
            issue: "Too thin",
          },
        ],
      }),
      "```",
    ].join("\n"),
    "r1",
  );
  assert.equal(r.clean, false);
  assert.equal(r.defects[0]!.severity, "blocking");
  assert.equal(r.defects[0]!.path, "overview.md");
});

test("mergeDefectReports dedupes and ranks", () => {
  const a = parseDefectReportFromText(
    "severity: blocking path: a.md issue one",
    "a",
  );
  const b = parseDefectReportFromText(
    "severity: minor path: b.md issue two",
    "b",
  );
  const m = mergeDefectReports([a, b]);
  assert.equal(m.reviewerIds.length, 2);
  assert.ok(m.defects.length >= 1);
  assert.equal(hasBlockingDefects(m), true);
});

test("evaluateWikiPublishable fails without pages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-score-"));
  const wikiRoot = path.join(root, "wiki");
  await mkdir(wikiRoot, { recursive: true });
  const scored = await evaluateWikiPublishable({
    wikiRoot,
    workspaceRoot: root,
    runId: "run-1",
    sources: [],
    requireReviewReceipt: false,
  });
  assert.equal(scored.publishable, false);
  assert.ok(scored.reasons.some((r) => /no staged/i.test(r)));
});

test("evaluateWikiPublishable passes with page + clean defects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-score-ok-"));
  const wikiRoot = path.join(root, "wiki");
  await mkdir(wikiRoot, { recursive: true });
  await writeFile(
    path.join(wikiRoot, "overview.md"),
    "---\ntype: Overview\ntitle: Overview\n---\n\n# Overview\n\nHello ([Source](repo:README.md#L1-L1)).\n",
    "utf8",
  );
  const sourcePath = path.join(root, "src");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# hi\n", "utf8");

  const spec = defaultWikiRunSpec("Demo");
  await writeWikiRunSpec(root, "run-ok", spec);
  await writeMergedDefects(root, "run-ok", {
    version: 1,
    clean: true,
    defects: [],
    reviewerIds: ["r1"],
    summary: "NO_DEFECTS",
  });

  const scored = await evaluateWikiPublishable({
    wikiRoot,
    workspaceRoot: root,
    runId: "run-ok",
    sources: [{ id: "main", path: sourcePath }],
    spec,
    requireReviewReceipt: true,
  });
  assert.equal(scored.publishable, true, scored.reasons.join("; "));
});
