import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { analysisReceiptsDir, analysisScratchDir } from "@okf-wiki/core";
import { buildReceiptIndex, persistResearchReceipt } from "./receipts.js";

test("persistResearchReceipt writes once under analysis/receipts via Core", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-agent-receipt-"));
  const result = await persistResearchReceipt({
    workspaceRoot: root,
    runId: "run-r1",
    nodeId: "domain-core",
    parentId: "root",
    scope: "core modules",
    summary: "- entrypoint found\n- tests present",
    status: "complete",
    childReceipts: ["analysis/receipts/leaf-1.json"],
  });

  assert.equal(result.relativePath, "analysis/receipts/domain-core.json");
  assert.equal(
    result.receiptPath,
    path.join(analysisReceiptsDir(root, "run-r1"), "domain-core.json"),
  );
  assert.equal(result.receipt.findings?.length, 2);

  const raw = await readFile(result.receiptPath, "utf8");
  const onDisk = JSON.parse(raw) as { nodeId: string; summary: string };
  assert.equal(onDisk.nodeId, "domain-core");
  assert.ok(onDisk.summary.includes("entrypoint"));

  // Single copy only — no flat analysis/*.json dual-write
  const analysisTop = await readdir(analysisScratchDir(root, "run-r1"));
  assert.deepEqual(
    analysisTop.filter((n) => n.endsWith(".json")),
    [],
  );
  const receiptNames = await readdir(analysisReceiptsDir(root, "run-r1"));
  assert.deepEqual(receiptNames, ["domain-core.json"]);
});

test("buildReceiptIndex lists Core receipts for the writer prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-agent-index-"));
  await persistResearchReceipt({
    workspaceRoot: root,
    runId: "run-idx",
    nodeId: "leaf-a",
    parentId: "domain-x",
    scope: "leaf scope",
    summary: "leaf findings here",
  });

  const empty = await buildReceiptIndex(root, "missing-run");
  assert.match(empty, /No analysis receipts/);

  const index = await buildReceiptIndex(root, "run-idx");
  assert.match(index, /analysis\/receipts\/leaf-a\.json/);
  assert.match(index, /leaf findings/);
  assert.match(index, /\[complete\]/);
});
