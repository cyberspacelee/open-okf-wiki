import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { derivedIndexPaths, materializeWikiIndexes, stampPublication, validateWikiTree } from "../extensions/wiki/lib/wiki-okf.js";
import { loadWikiTemplatePack, packagedTemplatesRoot, type WikiTemplatePack } from "../extensions/wiki/lib/templates.js";

function packOf(...templates: Array<{
  file: string;
  scope: "wiki" | "source" | "domain" | "concept";
  type?: string;
  diagram?: string[];
  optional?: boolean;
}>): WikiTemplatePack {
  return {
    directory: "/templates",
    templates: templates.map((template) => ({
      type: template.type ?? "Concept",
      optional: false,
      body: "",
      ...template,
    })),
  };
}

function mermaid(kind: string, body: string): string {
  return `\`\`\`mermaid\n${kind}\n${body}\n\`\`\`\n`;
}

function okfPage(type: string, title: string, extra = "", resource = "api/main.ts#L1"): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    `description: ${title} description.`,
    "sources:",
    "  - id: main",
    `    resource: ${resource}`,
    "    title: main",
    "---",
    `# ${title}`,
    "",
    "Claim. [^main]",
    "",
    extra,
    "[^main]: main",
    "",
  ].join("\n");
}

async function sourceTree(t: { after: (fn: () => Promise<void>) => void }, scope = "api") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-src-"));
  t.after(async () => await rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "main.ts"), "export const ready = true;\n");
  return { map: new Map([[scope, dir]]), resource: `${scope}/main.ts#L1` };
}

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

test("validate accepts a typed overview page without a template pack", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "overview.md"), "---\ntype: Overview\ntitle: Overview\n---\n# Overview\n");
  const result = await validateWikiTree(root, new Map());
  assert.equal(result.ok, true);
  assert.deepEqual(result.pages, ["overview.md"]);
});

test("validate requires mermaid kind from the template pack", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-mermaid-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const concept = path.join(root, "api", "billing", "invoice");
  await mkdir(concept, { recursive: true });
  const templates = packOf({ file: "flows.md", scope: "concept", type: "Flow", diagram: ["sequenceDiagram", "flowchart"] });
  await writeFile(path.join(root, "overview.md"), okfPage("Overview", "Overview", "", src.resource));
  await writeFile(path.join(concept, "flows.md"), okfPage("Flow", "Invoice flows", "", src.resource));
  const missing = await validateWikiTree(root, src.map, templates);
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((issue) => issue.code === "mermaid" && issue.page === "api/billing/invoice/flows.md"));

  await writeFile(path.join(concept, "flows.md"), okfPage("Flow", "Invoice flows", mermaid("sequenceDiagram", "  Invoice->>Ledger: post"), src.resource));
  const present = await validateWikiTree(root, src.map, templates);
  assert.equal(present.ok, true);
});

test("validate uses the template pack as the page contract", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-pack-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf(
    { file: "overview.md", scope: "wiki", type: "Overview" },
    { file: "source.md", scope: "source", type: "Source" },
    { file: "domain.md", scope: "domain", type: "Domain" },
    { file: "concept.md", scope: "concept", type: "Concept" },
    { file: "architecture.md", scope: "concept", type: "Architecture", diagram: ["flowchart"] },
    { file: "states.md", scope: "concept", type: "State Machine", diagram: ["stateDiagram-v2"], optional: true },
  );
  await writeFile(path.join(root, "overview.md"), okfPage("Overview", "Overview", "", src.resource));
  const overviewOnly = await validateWikiTree(root, src.map, templates);
  assert.equal(overviewOnly.ok, false);
  assert.ok(overviewOnly.issues.some((issue) => issue.code === "topology" && issue.page === "api/source.md"));
  assert.ok(overviewOnly.issues.some((issue) => issue.code === "topology" && issue.message.includes("concept cluster")));

  const concept = path.join(root, "api", "billing", "invoice");
  await mkdir(concept, { recursive: true });
  await writeFile(path.join(root, "api", "source.md"), okfPage("Source", "api", "", src.resource));
  await writeFile(path.join(root, "api", "billing", "domain.md"), [
    "---",
    "type: Domain",
    "title: billing",
    "description: Billing domain.",
    "---",
    "# billing",
    "",
  ].join("\n"));
  await writeFile(path.join(concept, "concept.md"), okfPage("Concept", "Invoice", "", src.resource));
  const missingArch = await validateWikiTree(root, src.map, templates);
  assert.equal(missingArch.ok, false);
  assert.ok(missingArch.issues.some((issue) => issue.page === "api/billing/invoice/architecture.md"));
  assert.ok(!missingArch.issues.some((issue) => issue.page === "api/billing/invoice/states.md"));

  await writeFile(path.join(concept, "architecture.md"), okfPage("Architecture", "Invoice architecture", mermaid("flowchart", "  Invoice --> Ledger"), src.resource));
  const complete = await validateWikiTree(root, src.map, templates);
  assert.equal(complete.ok, true);

  await writeFile(path.join(concept, "architecture.md"), okfPage("Architecture", "Invoice architecture", mermaid("sequenceDiagram", "  Invoice->>Ledger: post"), src.resource));
  const wrongKind = await validateWikiTree(root, src.map, templates);
  assert.equal(wrongKind.ok, false);
  assert.ok(wrongKind.issues.some((issue) => issue.code === "mermaid" && /flowchart/.test(issue.message)));
});

test("validate rejects leaked template keys, missing description, and dangling wiki links", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-okf-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf({ file: "overview.md", scope: "wiki", type: "Overview" });
  await writeFile(path.join(root, "overview.md"), [
    "---",
    "type: Overview",
    "title: Overview",
    "description: Map.",
    "scope: wiki",
    "sources:",
    "  - id: main",
    `    resource: ${src.resource}`,
    "---",
    "# Overview",
    "",
    "See [missing](/nope.md).",
    "",
    "[^main]: main",
    "",
  ].join("\n"));
  const result = await validateWikiTree(root, src.map, templates);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.message.includes("scope")));
  assert.ok(result.issues.some((issue) => issue.code === "link"));
});

test("packaged default templates reject a single overview page", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-default-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "overview.md"), okfPage("Overview", "Overview", "", "source/main.ts#L1"));
  const pack = await loadWikiTemplatePack(packagedTemplatesRoot("en"));
  const result = await validateWikiTree(root, new Map([["source", "/tmp/source"]]), pack);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "topology"));
});

test("indexes include descriptions and stamp writes log.md without unverified verified", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-index-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "overview.md"), okfPage("Overview", "Overview"));
  await materializeWikiIndexes(root, "en");
  const index = await readFile(path.join(root, "index.md"), "utf8");
  assert.match(index, /Start here/);
  assert.match(index, /Overview description/);
  await stampPublication(root, "2026-08-20T00:00:00.000Z", { reviewed: false, language: "en" });
  const overview = await readFile(path.join(root, "overview.md"), "utf8");
  assert.match(overview, /generated:/);
  assert.doesNotMatch(overview, /verified:/);
  const log = await readFile(path.join(root, "log.md"), "utf8");
  assert.match(log, /Published 1 pages/);
});
