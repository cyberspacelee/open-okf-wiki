import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertReviewPass, derivedIndexPaths, materializeWikiIndexes, stampPublication, validateWikiTarget, validateWikiTree, wikiPinsImplicit, type WikiPin } from "../extensions/wiki/lib/wiki-okf.js";
import { loadWikiTemplatePack, packagedTemplatesRoot, type WikiTemplate, type WikiTemplatePack } from "../extensions/wiki/lib/templates.js";
import { candidateRevision, fileRevision } from "../extensions/wiki/lib/revisions.js";

type TestTemplate = Partial<WikiTemplate> & { id: string };

const sections = (...titles: string[]) => titles.map((title) => ({ title, guidance: "Fill from evidence." }));

function packOf(...templates: TestTemplate[]): WikiTemplatePack {
  const defaults: TestTemplate[] = [
    { id: "overview", filename: "overview.md", scope: "wiki", identities: ["wiki"], type: "Overview" },
    {
      id: "architecture",
      filename: "architecture.md",
      type: "Architecture",
      altitudes: ["wiki", "repo"],
      identities: ["repo"],
      diagram: { section: "Diagram", kinds: ["flowchart"] },
      sections: sections("Components", "Diagram"),
    },
    { id: "domain", filename: "domain.md", scope: "domain", identities: ["domain"], type: "Domain" },
    { id: "concept", filename: "concept.md", scope: "concept", identities: ["concept"], type: "Concept" },
  ];
  const byId = new Map<string, TestTemplate>();
  for (const template of [...defaults, ...templates]) byId.set(template.id, template);
  return {
    templates: [...byId.values()].map((template) => ({
        sourceFile: template.sourceFile ?? `${template.id}.md`,
        id: template.id,
        type: template.type ?? "Concept",
        filename: template.filename ?? `${template.id}.md`,
        cardinality: template.cardinality ?? "one",
        required: template.required ?? true,
        purpose: template.purpose ?? "Fill from evidence.",
        ...(template.scope ? { scope: template.scope } : {}),
        ...(template.altitudes ? { altitudes: template.altitudes } : {}),
        ...(template.identities ? { identities: template.identities } : {}),
        ...(template.diagram ? { diagram: template.diagram } : {}),
        sections: template.sections ?? sections("Details"),
      })),
  };
}

function mermaid(kind: string, body: string): string {
  return `\`\`\`mermaid\n${kind}\n${body}\n\`\`\`\n`;
}

function fill(template: WikiTemplate | undefined, title: string, resource: string, extra = ""): string {
  if (!template) throw new Error(`missing template for ${title}`);
  const description = `${title} description.`;
  const sections = template.sections.map(({ title }) => {
    if (template.diagram?.section === title || title === "Diagram" || title === "图") {
      const kind = template.diagram?.kinds[0] ?? "flowchart";
      return `## ${title}\n\n${extra || mermaid(kind, "  Invoice --> Ledger")}`;
    }
    return `## ${title}\n\nClaim. [^main]`;
  }).join("\n\n");
  return [
    "---",
    `type: ${template.type}`,
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
    sections,
    "",
    "[^main]: main",
    "",
  ].join("\n");
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
    extra || "Claim. [^main]",
    "",
    "[^main]: main",
    "",
  ].join("\n");
}

async function writeCore(root: string, resource: string, pack: WikiTemplatePack, pins: readonly WikiPin[]): Promise<void> {
  const byId = Object.fromEntries(pack.templates.map((template) => [template.id, template]));
  await writeFile(path.join(root, "overview.md"), fill(byId.overview, "Overview", resource));
  await writeFile(path.join(root, "architecture.md"), fill(byId.architecture, "Architecture", resource));
  if (!wikiPinsImplicit(pins)) {
    for (const pin of pins) {
      await mkdir(path.join(root, pin.scopeId), { recursive: true });
      await writeFile(
        path.join(root, pin.scopeId, "architecture.md"),
        fill(byId.architecture, `${pin.scopeId} architecture`, resource),
      );
    }
  }
  const knowledgeRoot = wikiPinsImplicit(pins) ? root : path.join(root, pins[0]!.scopeId);
  const concept = path.join(knowledgeRoot, "billing", "invoice");
  await mkdir(concept, { recursive: true });
  await writeFile(path.join(knowledgeRoot, "billing", "domain.md"), fill(byId.domain, "Billing", resource));
  await writeFile(path.join(concept, "concept.md"), fill(byId.concept, "Invoice", resource));
}

async function sourceTree(t: { after: (fn: () => Promise<void>) => void }, scope = "api", implicit = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-src-"));
  t.after(async () => await rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "main.ts"), "export const ready = true;\n");
  const pin: WikiPin = implicit
    ? { scopeId: "self", logicalPath: ".", realPath: dir }
    : { scopeId: scope, logicalPath: scope, realPath: dir };
  return { pins: [pin], resource: implicit ? "main.ts#L1" : `${pin.logicalPath}/main.ts#L1` };
}

test("derived indexes cover root, repository, domain, and concept directories", () => {
  assert.deepEqual(derivedIndexPaths([
    "overview.md",
    "architecture.md",
    "api/architecture.md",
    "api/billing/domain.md",
    "api/billing/invoice/concept.md",
    "api/checkout/domain.md",
  ]), [
    "index.md",
    "api/billing/index.md",
    "api/billing/invoice/index.md",
    "api/checkout/index.md",
    "api/index.md",
  ]);
});

test("validate requires OKF type on concept pages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "overview.md"), "# Overview\n");
  const result = await validateWikiTree(root, []);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "frontmatter" || issue.code === "okf"));
});

test("validate accepts a typed overview page without a template pack", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "overview.md"), "---\ntype: Overview\ntitle: Overview\n---\n# Overview\n");
  const result = await validateWikiTree(root, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pages, ["overview.md"]);
});

test("Domain validation requires its own contracts without requiring unfinished aggregation pages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-target-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = await sourceTree(t, "self", true);
  const templates = packOf();
  const byId = Object.fromEntries(templates.templates.map((template) => [template.id, template]));
  await writeFile(path.join(root, "overview.md"), "# malformed outside target\n");
  await mkdir(path.join(root, "billing"), { recursive: true });
  await writeFile(path.join(root, "billing", "domain.md"), fill(byId.domain, "Billing", source.resource));

  const incomplete = await validateWikiTarget(root, { path: "billing", mode: "subtree" }, source.pins, templates);
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.issues.some((issue) => issue.message.includes("Concept directory")));

  await mkdir(path.join(root, "billing", "invoice"), { recursive: true });
  await writeFile(
    path.join(root, "billing", "invoice", "concept.md"),
    fill(byId.concept, "Invoice", source.resource),
  );
  const complete = await validateWikiTarget(root, { path: "billing", mode: "subtree" }, source.pins, templates);
  assert.equal(complete.ok, true, complete.issues.map((issue) => issue.message).join("\n"));
});

test("implicit Workspace citations are relative to the Workspace root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-root-citation-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = await sourceTree(t, "self", true);
  const templates = packOf();
  await writeCore(root, "main.ts#L1", templates, source.pins);
  const result = await validateWikiTree(root, source.pins, templates);
  assert.equal(result.ok, true, result.issues.map((issue) => issue.message).join("\n"));
});

test("validation accepts file citations and checks optional line ranges against the pinned file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-citation-range-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = await sourceTree(t, "self", true);
  const templates = packOf();
  await writeCore(root, "main.ts", templates, source.pins);
  const withoutLines = await validateWikiTree(root, source.pins, templates);
  assert.equal(withoutLines.ok, true, withoutLines.issues.map((issue) => issue.message).join("\n"));

  await writeCore(root, "main.ts#L3", templates, source.pins);
  const outsideFile = await validateWikiTree(root, source.pins, templates);
  assert.ok(outsideFile.issues.some((issue) => issue.code === "citation" && issue.message.includes("main.ts#L3")));
});

test("Catalog citations require an available Catalog and respect Source ownership", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-catalog-citation-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = await sourceTree(t, "self", true);
  const pins = source.pins.map((pin) => ({ ...pin, catalog: "billing" }));
  const templates = packOf();
  await writeCore(root, "catalog:billing/orders", templates, pins);
  const withoutCatalog = await validateWikiTree(root, pins, templates);
  assert.ok(withoutCatalog.issues.some((issue) =>
    issue.code === "citation" && issue.message.includes("unavailable Catalog")));

  const withCatalog = await validateWikiTree(root, pins, templates, { catalogs: new Set(["billing"]) });
  assert.equal(withCatalog.ok, true, withCatalog.issues.map((issue) => issue.message).join("\n"));

  await writeCore(root, "catalog:audit/orders", templates, pins);
  const foreign = await validateWikiTree(root, pins, templates, { catalogs: new Set(["billing", "audit"]) });
  assert.ok(foreign.issues.some((issue) => issue.code === "citation-owner" && issue.message.includes("audit")));
});

test("validate requires mermaid kind from the template pack", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-mermaid-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf({
    id: "flow",
    filename: "flow-{slug}.md",
    cardinality: "many",
    scope: "domain",
    type: "Flow",
    required: false,
    appliesWhen: "A runtime flow exists.",
    diagram: { section: "Details", kinds: ["sequenceDiagram", "flowchart"] },
    sections: sections("Details"),
  });
  await writeCore(root, src.resource, templates, src.pins);
  const domain = path.join(root, "billing");
  await writeFile(path.join(domain, "flow-checkout.md"), fill(
    templates.templates.find((template) => template.id === "flow"),
    "Billing flows",
    src.resource,
    "Claim. [^main]",
  ));
  const missing = await validateWikiTree(root, src.pins, templates);
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((issue) => issue.code === "mermaid" && issue.page === "billing/flow-checkout.md"));

  await writeFile(path.join(domain, "flow-checkout.md"), fill(
    templates.templates.find((template) => template.id === "flow"),
    "Billing flows",
    src.resource,
    mermaid("sequenceDiagram", "  Invoice->>Ledger: post"),
  ));
  const present = await validateWikiTree(root, src.pins, templates);
  assert.equal(present.ok, true);
});

test("validate uses the template pack as the page contract", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-pack-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf(
    {
      id: "state-machine",
      filename: "states.md",
      scope: "concept",
      type: "State Machine",
      required: false,
      appliesWhen: "A lifecycle exists.",
      diagram: { section: "Details", kinds: ["stateDiagram-v2"] },
    },
  );
  await writeFile(path.join(root, "overview.md"), fill(templates.templates.find((template) => template.id === "overview"), "Overview", src.resource));
  const overviewOnly = await validateWikiTree(root, src.pins, templates);
  assert.equal(overviewOnly.ok, false);
  assert.ok(overviewOnly.issues.some((issue) => issue.code === "topology" && issue.page === "architecture.md"));
  assert.ok(overviewOnly.issues.some((issue) => issue.code === "topology" && issue.message.includes("concept cluster")));

  await writeCore(root, src.resource, templates, src.pins);
  const withoutOptional = await validateWikiTree(root, src.pins, templates);
  assert.equal(withoutOptional.ok, true);
});

test("implicit wiki rejects repository sections and explicit wiki keeps knowledge inside its repository", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-implicit-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const implicit = await sourceTree(t, "api", true);
  const templates = packOf();
  await writeCore(root, implicit.resource, templates, implicit.pins);
  const ok = await validateWikiTree(root, implicit.pins, templates);
  assert.equal(ok.ok, true);

  await mkdir(path.join(root, "api"), { recursive: true });
  await writeFile(path.join(root, "api", "architecture.md"), fill(templates.templates.find((template) => template.id === "architecture"), "Wrong", implicit.resource));
  const withRepository = await validateWikiTree(root, implicit.pins, templates);
  assert.equal(withRepository.ok, false);

  const explicitRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-explicit-"));
  t.after(async () => await rm(explicitRoot, { recursive: true, force: true }));
  const explicit = await sourceTree(t, "my.repo_ui", false);
  await writeCore(explicitRoot, explicit.resource, templates, explicit.pins);
  assert.equal((await validateWikiTree(explicitRoot, explicit.pins, templates)).ok, true);
  await writeFile(
    path.join(explicitRoot, "my.repo_ui", "billing", "domain.md"),
    fill(templates.templates.find((template) => template.id === "domain"), "Wrong origin", "main.ts#L1"),
  );
  const sourceRelative = await validateWikiTree(explicitRoot, explicit.pins, templates);
  assert.ok(sourceRelative.issues.some((issue) => issue.code === "citation" && issue.message.includes("main.ts#L1 missing")));
  await writeFile(
    path.join(explicitRoot, "my.repo_ui", "billing", "domain.md"),
    fill(templates.templates.find((template) => template.id === "domain"), "Billing", explicit.resource),
  );
  await materializeWikiIndexes(explicitRoot, "en", templates, explicit.pins);
  assert.match(await readFile(path.join(explicitRoot, "my.repo_ui", "index.md"), "utf8"), /Billing/);
  await mkdir(path.join(explicitRoot, "billing"), { recursive: true });
  await writeFile(
    path.join(explicitRoot, "billing", "domain.md"),
    fill(templates.templates.find((template) => template.id === "domain"), "Wrong", explicit.resource),
  );
  const misplaced = await validateWikiTree(explicitRoot, explicit.pins, templates);
  assert.ok(misplaced.issues.some((issue) => issue.code === "template" && issue.page === "billing/domain.md"));
});

test("multi-Source validation enforces repository citation ownership and root coverage", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-multi-source-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const api = await sourceTree(t, "api", false);
  const web = await sourceTree(t, "web", false);
  const pins = [...api.pins, ...web.pins];
  const templates = packOf();
  await writeCore(root, api.resource, templates, pins);
  const result = await validateWikiTree(root, pins, templates);
  assert.ok(result.issues.some((issue) => issue.code === "cross-source" && issue.page === "architecture.md"));
  assert.ok(result.issues.some((issue) => issue.code === "citation-owner" && issue.page === "web/architecture.md"));
});

test("validate rejects domain-level architecture and undeclared pages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-domain-arch-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf();
  await writeCore(root, src.resource, templates, src.pins);
  await writeFile(
    path.join(root, "billing", "architecture.md"),
    fill(templates.templates.find((template) => template.id === "architecture"), "Billing architecture", src.resource),
  );
  const result = await validateWikiTree(root, src.pins, templates);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "template" && issue.page === "billing/architecture.md"));
});

test("validate requires a Domain identity beside evidence-selected Domain pages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-domain-anchor-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf({
    id: "flow",
    filename: "flows.md",
    scope: "domain",
    type: "Flow",
    required: false,
    appliesWhen: "A runtime flow exists.",
    diagram: { section: "Details", kinds: ["sequenceDiagram"] },
  });
  await writeCore(root, src.resource, templates, src.pins);
  const orphan = path.join(root, "orphan");
  await mkdir(orphan, { recursive: true });
  await writeFile(
    path.join(orphan, "flows.md"),
    fill(templates.templates.find((template) => template.id === "flow"), "Orphan flows", src.resource, mermaid("sequenceDiagram", "  A->>B: go")),
  );
  const result = await validateWikiTree(root, src.pins, templates);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "topology" && issue.page === "orphan/domain.md"));
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
    "See [missing](/nope.md). [^main]",
    "",
    "[^main]: main",
    "",
  ].join("\n"));
  const result = await validateWikiTree(root, src.pins, templates);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.message.includes("scope")));
  assert.ok(result.issues.some((issue) => issue.code === "link"));
});

test("validate rejects unknown pages, empty sections, and placeholders", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-markdown-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const src = await sourceTree(t);
  const templates = packOf();
  await writeCore(root, src.resource, templates, src.pins);
  await writeFile(path.join(root, "billing", "invoice", "extra.md"), fill(templates.templates.find((template) => template.id === "concept"), "Extra", src.resource).replace("type: Concept", "type: Extra"));
  await writeFile(path.join(root, "overview.md"), fill(templates.templates.find((template) => template.id === "overview"), "Overview", src.resource).replace("Claim. [^main]", "{{todo}} {{later}}"));
  await writeFile(
    path.join(root, "billing", "invoice", "concept.md"),
    fill(templates.templates.find((template) => template.id === "concept"), "Invoice", src.resource).replace("Claim. [^main]", ""),
  );
  const result = await validateWikiTree(root, src.pins, templates);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "template" && issue.page?.endsWith("extra.md")));
  assert.ok(result.issues.some((issue) => issue.code === "markdown" && issue.message.includes("empty")));
  assert.ok(result.issues.some((issue) => issue.code === "markdown" && issue.message.includes("placeholder")));
  assert.equal(result.issues.filter((issue) => issue.code === "markdown" && issue.message.includes("placeholder")).length, 2);
});

test("packaged default templates reject a single overview page", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-default-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "overview.md"), okfPage("Overview", "Overview", "", "main.ts#L1"));
  const pack = await loadWikiTemplatePack(packagedTemplatesRoot("en"));
  const result = await validateWikiTree(root, [{ scopeId: "self", logicalPath: ".", realPath: "/tmp/source" }], pack);
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
  assert.match(index, /# \[Overview\]\(\.\/overview\.md\)/);
  assert.equal(index.match(/Overview description/g)?.length, 1);
  assert.doesNotMatch(index, /\* \[Overview\]\(\.\/overview\.md\)/);
  const publishedAt = "2026-08-20T23:30:00.000Z";
  await stampPublication(root, publishedAt, { reviewed: false, language: "en" });
  const overview = await readFile(path.join(root, "overview.md"), "utf8");
  assert.match(overview, /generated:/);
  assert.doesNotMatch(overview, /verified:/);
  const log = await readFile(path.join(root, "log.md"), "utf8");
  const localDay = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(Date.parse(publishedAt));
  assert.ok(log.includes(`## ${localDay}`));
  assert.match(log, /Published 1 pages/);
});

test("review freshness follows bytes rather than mtimes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-review-digest-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const handoff = path.join(root, "review.md");
  await mkdir(candidate, { recursive: true });
  const page = path.join(candidate, "overview.md");
  await writeFile(page, "one\n");
  await writeFile(handoff, "verdict: pass\n");
  const originalTime = await stat(page);
  const attestation = {
    verdict: "pass" as const,
    candidateRevision: (await candidateRevision(candidate)).digest,
    handoffPath: handoff,
    handoffRevision: await fileRevision(handoff),
  };
  await utimes(page, new Date(), new Date());
  assert.equal((await assertReviewPass(candidate, attestation)).ok, true);
  await writeFile(page, "two\n");
  await utimes(page, originalTime.atime, originalTime.mtime);
  assert.match((await assertReviewPass(candidate, attestation)).message, /stale/);
});

test("review freshness fails closed when the attested handoff changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-okf-review-handoff-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const handoff = path.join(root, "review.md");
  await mkdir(candidate, { recursive: true });
  await writeFile(path.join(candidate, "overview.md"), "one\n");
  await writeFile(handoff, "verdict: pass\n");
  const attestation = {
    verdict: "pass" as const,
    candidateRevision: (await candidateRevision(candidate)).digest,
    handoffPath: handoff,
    handoffRevision: await fileRevision(handoff),
  };
  await writeFile(handoff, "verdict: changes_requested\n");
  assert.match((await assertReviewPass(candidate, attestation)).message, /handoff changed/);
});
