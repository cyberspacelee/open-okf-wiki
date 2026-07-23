import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  analysisScratchDir,
  listAnalysisReceipts,
  readAnalysisReceipt,
  writeAnalysisReceipt,
} from "./analysis-scratch.js";

test("upsertOperatorWorkAgent persists Work surface snapshot", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const {
    upsertOperatorWorkAgent,
    readOperatorWorkSnapshot,
    operatorWorkSnapshotPath,
  } = await import("./analysis-scratch.js");

  const root = await mkdtemp(path.join(os.tmpdir(), "okf-work-"));
  await upsertOperatorWorkAgent(root, "run-w1", {
    agentId: "planner",
    role: "planner",
    status: "running",
    task: "draft",
  });
  await upsertOperatorWorkAgent(root, "run-w1", {
    agentId: "planner",
    role: "planner",
    status: "complete",
    detail: "spec ready",
  });
  await upsertOperatorWorkAgent(
    root,
    "run-w1",
    {
      agentId: "leaf-1",
      role: "leaf",
      status: "running",
    },
    { phase: "writing" },
  );

  const snap = await readOperatorWorkSnapshot(root, "run-w1");
  assert.ok(snap);
  assert.equal(snap!.agents.length, 2);
  assert.equal(
    snap!.agents.find((a) => a.agentId === "planner")?.status,
    "complete",
  );
  assert.equal(
    snap!.agents.find((a) => a.agentId === "planner")?.detail,
    "spec ready",
  );
  assert.equal(snap!.phase, "writing");
  const raw = await readFile(operatorWorkSnapshotPath(root, "run-w1"), "utf8");
  assert.match(raw, /operator-work|planner|leaf-1/);
});

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
  assert.ok(list.some((r) => r.nodeId === "domain-core"));
  const one = await readAnalysisReceipt(root, "run-2", "domain-core");
  assert.ok(one);
  assert.equal(one!.summary, "Found entrypoints");
  assert.equal(one!.findings?.length, 2);
});
