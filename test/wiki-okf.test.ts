import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { derivedIndexPaths, validateWikiTree } from "../extensions/wiki/lib/wiki-okf.js";

test("derived indexes cover root, source, domain, and concept directories", () => {
  assert.deepEqual(derivedIndexPaths([
    "overview.md",
    "architecture.md",
    "api/source.md",
    "api/billing/domain.md",
    "api/billing/invoice/concept.md",
    "api/billing/invoice/models/line-item.md",
    "web/source.md",
    "web/billing/domain.md",
  ]), [
    "api/billing/index.md",
    "api/billing/invoice/index.md",
    "api/billing/invoice/models/index.md",
    "api/index.md",
    "index.md",
    "web/billing/index.md",
    "web/index.md",
  ]);
});

test("validate requires OKF type on concept pages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "overview.md"), "# Overview\n");
  const result = await validateWikiTree(root, new Map());
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "frontmatter" || issue.code === "okf"));
});

test("validate accepts a typed overview page", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "overview.md"), "---\ntype: overview\ntitle: Overview\n---\n# Overview\n");
  const result = await validateWikiTree(root, new Map());
  assert.equal(result.ok, true);
  assert.deepEqual(result.pages, ["overview.md"]);
});

test("validate requires mermaid on flows, models, states, and data pages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-mermaid-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const concept = path.join(root, "api", "billing", "invoice");
  await mkdir(concept, { recursive: true });
  await writeFile(path.join(root, "overview.md"), "---\ntype: overview\ntitle: Overview\n---\n# Overview\n");
  await writeFile(path.join(concept, "flows.md"), "---\ntype: flows\ntitle: Invoice flows\n---\n# Flows\n");
  const missing = await validateWikiTree(root, new Map());
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((issue) => issue.code === "mermaid" && issue.page === "api/billing/invoice/flows.md"));

  await writeFile(path.join(concept, "flows.md"), [
    "---",
    "type: flows",
    "title: Invoice flows",
    "---",
    "# Flows",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  Invoice->>Ledger: post",
    "```",
    "",
  ].join("\n"));
  const present = await validateWikiTree(root, new Map());
  assert.equal(present.ok, true);
});
