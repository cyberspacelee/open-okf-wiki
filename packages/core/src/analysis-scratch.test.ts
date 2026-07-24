import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  analysisReceiptsDir,
  analysisScratchDir,
  listAnalysisReceipts,
  readAnalysisReceipt,
  writeAnalysisReceipt,
} from "./analysis-scratch.js";

const sampleReceipt = (runId: string, nodeId: string) =>
  ({
    version: 1 as const,
    runId,
    nodeId,
    parentId: "root",
    attempt: 1,
    status: "complete" as const,
    scope: "staged wiki",
    summary: "NO_DEFECTS",
    findings: ["clean"],
    evidence: [],
    childReceipts: [],
    openQuestions: [],
  });

test("writeAnalysisReceipt stores validated JSON under analysis/receipts only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-scratch-"));
  const filePath = await writeAnalysisReceipt(root, sampleReceipt("run-1", "reviewer"));

  assert.equal(
    filePath,
    path.join(analysisReceiptsDir(root, "run-1"), "reviewer.json"),
  );
  assert.ok(filePath.startsWith(analysisReceiptsDir(root, "run-1")));
  assert.ok(filePath.startsWith(analysisScratchDir(root, "run-1")));

  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw) as { nodeId: string; status: string };
  assert.equal(data.nodeId, "reviewer");
  assert.equal(data.status, "complete");

  // No dual-write to flat analysis/*.json
  const analysisNames = await readdir(analysisScratchDir(root, "run-1"));
  assert.deepEqual(analysisNames.filter((n) => n.endsWith(".json")), []);
  assert.ok(analysisNames.includes("receipts"));
});

test("listAnalysisReceipts and readAnalysisReceipt round-trip", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-scratch-list-"));
  await writeAnalysisReceipt(root, {
    version: 1,
    runId: "run-2",
    nodeId: "domain-core",
    parentId: "root",
    attempt: 1,
    status: "complete",
    scope: "core modules",
    summary: "Found entrypoints",
    findings: ["a", "b"],
    evidence: [],
    childReceipts: ["analysis/receipts/leaf-1.json"],
    openQuestions: ["q?"],
  });
  const list = await listAnalysisReceipts(root, "run-2");
  assert.equal(list.length, 1);
  assert.equal(list[0]!.nodeId, "domain-core");
  assert.equal(list[0]!.relativePath, "receipts/domain-core.json");
  assert.equal(list[0]!.findingsCount, 2);

  const one = await readAnalysisReceipt(root, "run-2", "domain-core");
  assert.ok(one);
  assert.equal(one!.summary, "Found entrypoints");
  assert.equal(one!.findings?.length, 2);

  const viaRel = await readAnalysisReceipt(root, "run-2", "receipts/domain-core.json");
  assert.ok(viaRel);
  assert.equal(viaRel!.nodeId, "domain-core");
});

test("listAnalysisReceipts ignores missing receipts dir", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-scratch-empty-"));
  const list = await listAnalysisReceipts(root, "no-such-run");
  assert.deepEqual(list, []);
});
