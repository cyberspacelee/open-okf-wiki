import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWriterEvidenceGate } from "../extensions/wiki/lib/evidence.js";
import type { WikiWriteGuard } from "../extensions/wiki/lib/path-policy.js";

async function fixture(t, resource: string, options: Parameters<typeof createWriterEvidenceGate>[1] = {}) {
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
    publishedWikiRoot: path.join(root, "wiki"),
    handoffsRoot: path.join(root, ".okf-wiki", "runs", "run", "handoffs"),
    sources: [{ scopeId: "self", logicalPath: "." }],
    defaultSourceIgnores: true,
    excludes: [],
  };
  const gate = createWriterEvidenceGate(guard, options);
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
  assert.match(await gate.nextPrompt() ?? "", /offset=3, limit=1/);

  gate.observe({ tool: "read", args: { path: "main.ts", offset: 3, limit: 1 }, status: "complete", result: {} });
  assert.equal(await gate.nextPrompt(), undefined);
});

test("a path-only citation requires a successful read but not a full-file span", async (t) => {
  const gate = await fixture(t, "main.ts");
  assert.match(await gate.nextPrompt() ?? "", /main\.ts/);
  gate.observe({ tool: "read", args: { path: "main.ts", offset: 2, limit: 1 }, status: "complete", result: {} });
  assert.equal(await gate.nextPrompt(), undefined);
});

test("the configured evidence repair limit bounds a writer session", async (t) => {
  const gate = await fixture(t, "main.ts", { maxRepairRounds: 1 });
  assert.match(await gate.nextPrompt() ?? "", /round 1 of 1/i);
  await assert.rejects(() => gate.nextPrompt(), /after 1 rounds/);
});
