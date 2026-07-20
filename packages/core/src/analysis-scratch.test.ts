import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  analysisScratchDir,
  writeAnalysisReceipt,
} from "./analysis-scratch.js";

test("writeAnalysisReceipt stores validated JSON under analysis scratch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-scratch-"));
  const filePath = await writeAnalysisReceipt(root, {
    version: 1,
    runId: "run-1",
    nodeId: "reviewer",
    parentId: "root",
    attempt: 1,
    status: "complete",
    scope: "staged wiki",
    summary: "NO_DEFECTS",
    findings: ["clean"],
    evidence: [],
    childReceipts: [],
    openQuestions: [],
  });
  assert.ok(filePath.startsWith(analysisScratchDir(root, "run-1")));
  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw) as { nodeId: string; status: string };
  assert.equal(data.nodeId, "reviewer");
  assert.equal(data.status, "complete");
});
