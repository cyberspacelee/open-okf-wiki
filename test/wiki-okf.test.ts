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
  sections?: string[];
}>): WikiTemplatePack {
  const anchors = [
    { file: "overview.md", scope: "wiki" as const, type: "Overview" },
    { file: "source.md", scope: "source" as const, type: "Source" },
    { file: "domain.md", scope: "domain" as const, type: "Domain" },
    { file: "concept.md", scope: "concept" as const, type: "Concept" },
  ];
  return {
    directory: "/templates",
    templates: [...anchors, ...templates].map((template) => ({
      type: template.type ?? "Concept",
      optional: false,
      instructions: "Fill from evidence.",
      sections: ["Details"],
      body: "# {{title}}\n\n{{description}}\n\n## Details\n",
      ...template,
    })),
  };
}

function mermaid(kind: string, body: string): string {
  return `\`\`\`mermaid\n${kind}\n${body}\n\`\`\`\n`;
}

function okfPage(type: string, title: string, extra = "", resource = "api/main.ts#L1"): string {
  const description = `${title} description.`;
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    `description: ${description}`,
    "sources:",
    "  - id: main",
    `    resource: ${resource}`,
    "    title: main",
    "---",
    `# ${title}`,
    "",
    description,
    "",
    "## Details",
    "",
    "Claim. [^main]",
    "",
    extra,
    "[^main]: main",
    "",
  ].join("\n");
}

async function writeCore(root: string, resource: string): Promise<void> {
  const concept = path.join(root, "api", "billing", "invoice");
  await mkdir(concept, { recursive: true });
  await writeFile(path.join(root, "overview.md"), okfPage("Overview", "Overview", "", resource));
  await writeFile(path.join(root, "api", "source.md"), okfPage("Source", "API", "", resource));
  await writeFile(path.join(root, "api", "billing", "domain.md"), okfPage("Domain", "Billing", "", resource));
  await writeFile(path.join(concept, "concept.md"), okfPage("Concept", "Invoice", "", resource));
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
  await writeCore(root, src.resource);
  const domain = path.join(root, "api", "billing");
  const templates = packOf({ file: "flows.md", scope: "domain", type: "Flow", diagram: ["sequenceDiagram", "flowchart"], optional: true });
  await writeFile(path.join(domain, "flows.md"), okfPage("Flow", "Billing flows", "", src.resource));
  const missing = await validateWikiTree(root, src.map, templates);
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((issue) => issue.code === "mermaid" && issue.page === "api/billing/flows.md"));

  await writeFile(path.join(domain, "flows.md"), okfPage("Flow", "Billing flows", mermaid("sequenceDiagram", "  Invoice->>Ledger: post"), src.resource));
  const present = await validateWikiTree(root, src.map, templates);
  assert.equal(present.ok, true);
});

test("validate uses the template pack as the page contract", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-pack-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf(
    { file: "architecture.md", scope: "domain", type: "Architecture", diagram: ["flowchart"], optional: true },
    { file: "states.md", scope: "concept", type: "State Machine", diagram: ["stateDiagram-v2"], optional: true },
  );
  await writeFile(path.join(root, "overview.md"), okfPage("Overview", "Overview", "", src.resource));
  const overviewOnly = await validateWikiTree(root, src.map, templates);
  assert.equal(overviewOnly.ok, false);
  assert.ok(overviewOnly.issues.some((issue) => issue.code === "topology" && issue.page === "api/source.md"));
  assert.ok(overviewOnly.issues.some((issue) => issue.code === "topology" && issue.message.includes("concept cluster")));

  await writeCore(root, src.resource);
  const withoutOptional = await validateWikiTree(root, src.map, templates);
  assert.equal(withoutOptional.ok, true);

  const architecture = path.join(root, "api", "billing", "architecture.md");
  await writeFile(architecture, okfPage("Architecture", "Billing architecture", mermaid("flowchart", "  Invoice --> Ledger"), src.resource));
  const complete = await validateWikiTree(root, src.map, templates);
  assert.equal(complete.ok, true);

  await writeFile(architecture, okfPage("Architecture", "Billing architecture", mermaid("sequenceDiagram", "  Invoice->>Ledger: post"), src.resource));
  const wrongKind = await validateWikiTree(root, src.map, templates);
  assert.equal(wrongKind.ok, false);
  assert.ok(wrongKind.issues.some((issue) => issue.code === "mermaid" && /flowchart/.test(issue.message)));
});

test("validate requires a Domain anchor beside optional Domain pages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-domain-anchor-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf(
    { file: "architecture.md", scope: "domain", type: "Architecture", diagram: ["flowchart"], optional: true },
  );
  await writeCore(root, src.resource);
  const orphan = path.join(root, "api", "orphan");
  await mkdir(orphan, { recursive: true });
  await writeFile(
    path.join(orphan, "architecture.md"),
    okfPage("Architecture", "Orphan architecture", mermaid("flowchart", "  A --> B"), src.resource),
  );
  const result = await validateWikiTree(root, src.map, templates);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "topology" && issue.page === "api/orphan/domain.md"));
});

test("validate rejects leaked template keys, missing description, and dangling wiki links", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-okf-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf();
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
    "Map.",
    "",
    "## Details",
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

test("validate rejects unknown pages, wrong scope, empty sections, and placeholders", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-markdown-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf();
  await writeCore(root, src.resource);
  await writeFile(path.join(root, "api", "billing", "invoice", "source.md"), okfPage("Source", "Wrong", "", src.resource));
  await writeFile(path.join(root, "api", "billing", "invoice", "extra.md"), okfPage("Extra", "Extra", "", src.resource));
  await writeFile(path.join(root, "overview.md"), okfPage("Overview", "Overview", "{{todo}}", src.resource));
  await writeFile(
    path.join(root, "api", "billing", "invoice", "concept.md"),
    okfPage("Concept", "Invoice", "", src.resource).replace("Claim. [^main]", ""),
  );
  const result = await validateWikiTree(root, src.map, templates);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "template" && issue.page?.endsWith("source.md")));
  assert.ok(result.issues.some((issue) => issue.code === "template" && issue.page?.endsWith("extra.md")));
  assert.ok(result.issues.some((issue) => issue.code === "markdown" && issue.message.includes("empty")));
  assert.ok(result.issues.some((issue) => issue.code === "markdown" && issue.message.includes("placeholder")));
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
  const pack = packOf();
  await materializeWikiIndexes(root, "en", pack);
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
