import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createReviewerCompletionGate,
  createWorkerOutputGate,
  createWriterCompletionGate,
} from "../extensions/wiki/lib/completion.js";
import type { WikiWriteGuard } from "../extensions/wiki/lib/path-policy.js";
import { createWriterTodoTracker } from "../extensions/wiki/lib/writer-todo.js";

const WRITE_RECEIPT = "## Status\n\ncomplete\n\n## Written\n\nwiki/overview.md\n\n## Rejected hints\n\nnone\n\n## Evidence gaps\n\nnone\n";
const REVIEW_PASS = "verdict: pass\n\n## Coverage\n\n- page: wiki/overview.md | result: pass | evidence: main.ts#L1 reopened\n\n## Repairs\n\nnone\n";
const SYNTHESIS_RECEIPT = "## Workspace\n\nself\n\n## Relationships\n\nnone\n\n## End-to-end flows\n\nnone\n\n## Shared contracts\n\nnone\n\n## Gaps\n\nnone\n";

function completionGuard(): WikiWriteGuard {
  const workspaceRoot = path.join(os.tmpdir(), "okf-wiki-completion-gate");
  return {
    workspaceRoot,
    candidateRoot: path.join(workspaceRoot, ".okf-wiki", "run", "candidate"),
    handoffsRoot: path.join(workspaceRoot, ".okf-wiki", "run", "handoffs"),
    sources: [{ scopeId: "self", logicalPath: ".", realPath: workspaceRoot }],
    readCandidate: true,
    readableHandoffs: "all",
    defaultSourceIgnores: true,
    excludes: [],
  };
}

async function fixture(t, resource: string, options: Parameters<typeof createWriterCompletionGate>[1] = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-evidence-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, ".okf-wiki", "runs", "run", "candidate");
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(path.join(root, "main.ts"), "one\ntwo\nthree\nfour\n");
  await writeFile(path.join(candidateRoot, "overview.md"), [
    "---", "type: Overview", "title: Overview", "description: Overview.", "sources:",
    "  - id: main", `    resource: ${resource}`, "---", "# Overview", "", "Overview.",
    "", "## Details", "", "Claim. [^main]", "", "[^main]: main", "",
  ].join("\n"));
  const guard: WikiWriteGuard = {
    workspaceRoot: root,
    candidateRoot,
    handoffsRoot: path.join(root, ".okf-wiki", "runs", "run", "handoffs"),
    sources: [{ scopeId: "self", logicalPath: ".", realPath: root }],
    readCandidate: true,
    readableHandoffs: "all",
    defaultSourceIgnores: true,
    excludes: [],
    writeTarget: { path: "wiki-root", mode: "directory" },
  };
  const gate = createWriterCompletionGate(guard, options);
  gate.observe({ tool: "write", args: { path: "wiki/overview.md" }, status: "complete" });
  return gate;
}

test("evidence receipts cover only lines returned by a truncated read", async (t) => {
  const gate = await fixture(t, "main.ts#L3");
  gate.observe({
    tool: "read",
    args: { path: "main.ts" },
    status: "complete",
    result: { details: { truncation: { truncated: true, outputLines: 2 } } },
  });
  assert.match(await gate.validate(WRITE_RECEIPT) ?? "", /offset=3, limit=1/);

  gate.observe({ tool: "read", args: { path: "main.ts", offset: 3, limit: 1 }, status: "complete", result: {} });
  assert.equal(await gate.validate(WRITE_RECEIPT), undefined);
});

test("a path-only citation requires a successful read but not a full-file span", async (t) => {
  const gate = await fixture(t, "main.ts");
  assert.match(await gate.validate(WRITE_RECEIPT) ?? "", /main\.ts/);
  gate.observe({ tool: "read", args: { path: "main.ts", offset: 2, limit: 1 }, status: "complete", result: {} });
  assert.equal(await gate.validate(WRITE_RECEIPT), undefined);
});

test("the configured worker repair limit bounds a writer session", async (t) => {
  const gate = await fixture(t, "main.ts", { maxRepairRounds: 1 });
  assert.match(await gate.validate("") ?? "", /round 1 of 1/i);
  await assert.rejects(() => gate.validate(""), /after 1 rounds/);
});

test("writer repair stops after two rounds with the same issues", async (t) => {
  const gate = await fixture(t, "main.ts");
  assert.match(await gate.validate("") ?? "", /round 1 of 6/i);
  assert.match(await gate.validate("") ?? "", /round 2 of 6/i);
  await assert.rejects(() => gate.validate(""), /made no progress after 2 rounds/);
});

test("writer completion reports evidence and assignment issues in one repair batch", async (t) => {
  const todo = createWriterTodoTracker({ path: "wiki-root", mode: "directory" });
  const gate = await fixture(t, "main.ts", {
    todo,
  });
  const prompt = await gate.validate("") ?? "";
  assert.match(prompt, /citation-unread/);
  assert.match(prompt, /writer-todo/);
  assert.match(prompt, /one exhaustive completion check/);
});

test("reviewer repairs an invalid verdict in the same session", async () => {
  const gate = createReviewerCompletionGate(completionGuard(), ["wiki/overview.md"]);
  gate.observe({ tool: "read", args: { path: "wiki/overview.md" }, status: "complete" });
  assert.match(await gate.validate("Looks good.") ?? "", /verdict: pass/);
  assert.equal(await gate.validate(REVIEW_PASS), undefined);
});

test("reviewer rejects partial frozen-page coverage", async () => {
  const gate = createReviewerCompletionGate(completionGuard(), ["wiki/overview.md", "wiki/setup.md"]);
  gate.observe({ tool: "read", args: { path: "wiki/overview.md" }, status: "complete" });
  assert.match(await gate.validate(REVIEW_PASS) ?? "", /wiki\/setup\.md/);
});

test("worker completion requires every host-supplied input to be read", async () => {
  const guard = completionGuard();
  const gate = createWorkerOutputGate(guard, "synthesize", 6, [".okf-wiki/run/handoffs/one.md"]);
  assert.match(await gate.validate(SYNTHESIS_RECEIPT) ?? "", /required-read/);
  gate.observe({
    tool: "read",
    args: { path: ".okf-wiki/run/handoffs/one.md" },
    status: "complete",
  });
  assert.equal(await gate.validate(SYNTHESIS_RECEIPT), undefined);
});

test("reviewer records the canonical Candidate path", async () => {
  const guard = completionGuard();
  const gate = createReviewerCompletionGate(guard, ["wiki/overview.md"]);
  gate.observe({
    tool: "read",
    args: { path: "wiki/overview.md" },
    status: "complete",
  });
  assert.equal(await gate.validate(REVIEW_PASS), undefined);
});
