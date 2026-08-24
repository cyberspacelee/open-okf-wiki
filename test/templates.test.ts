import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatWikiTemplateCatalog,
  formatWikiTemplatesForPrompt,
  loadWikiTemplatePack,
  packagedTemplatesRoot,
  parseWikiTemplate,
  resolveWikiTemplatePack,
  templateMatchesFilename,
  templateOutputSkeleton,
  templatesForTarget,
} from "../extensions/wiki/lib/templates.js";

function contractText(
  id: string,
  scope: "wiki" | "repo" | "domain" | "concept",
  options: { required?: boolean; filename?: string; cardinality?: "one" | "many"; identity?: boolean } = {},
): string {
  const required = options.required ?? true;
  return [
    "---",
    `id: ${id}`,
    `type: ${id}`,
    `scope: ${scope}`,
    ...((options.identity ?? required) ? [`identity: ${scope}`] : []),
    `filename: ${options.filename ?? `${id}.md`}`,
    `cardinality: ${options.cardinality ?? "one"}`,
    `required: ${required}`,
    ...(!required ? ["applies_when: Source evidence satisfies this contract."] : []),
    `purpose: Explain ${id}.`,
    "---",
    "",
    "## Details",
    "",
    "Answer the required question from evidence.",
    "",
  ].join("\n");
}

function architectureText(): string {
  return [
    "---",
    "id: architecture",
    "type: Architecture",
    "altitudes: [wiki, repo]",
    "identity: repo",
    "filename: architecture.md",
    "cardinality: one",
    "required: true",
    "purpose: Explain architecture.",
    "---",
    "",
    "## Details",
    "",
    "Answer the required question from evidence.",
    "",
  ].join("\n");
}

async function writePack(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "overview.md"), contractText("overview", "wiki")),
    writeFile(path.join(directory, "architecture.md"), architectureText()),
    writeFile(path.join(directory, "domain.md"), contractText("domain", "domain")),
    writeFile(path.join(directory, "concept.md"), contractText("concept", "concept")),
  ]);
}

test("parseWikiTemplate exposes one explicit page contract", () => {
  const parsed = parseWikiTemplate("architecture.md", architectureText());
  assert.equal(parsed.id, "architecture");
  assert.equal(parsed.filename, "architecture.md");
  assert.deepEqual(parsed.altitudes, ["wiki", "repo"]);
  assert.equal(parsed.required, true);
  assert.deepEqual(parsed.sections, [{ title: "Details", guidance: "Answer the required question from evidence." }]);
});

test("repeatable contracts accept only concrete safe topic filenames", () => {
  const flow = parseWikiTemplate("flow.md", contractText("flow", "domain", {
    required: false,
    cardinality: "many",
    filename: "flow-{slug}.md",
  }));
  assert.equal(templateMatchesFilename(flow, "flow-checkout.md"), true);
  assert.equal(templateMatchesFilename(flow, "flow-.md"), false);
  assert.equal(templateMatchesFilename(flow, "flow-Checkout.md"), false);
  assert.match(templateOutputSkeleton(flow), /## Details/);
});

test("legacy and incomplete template contracts are rejected", () => {
  assert.throws(() => parseWikiTemplate("architecture.md", "---\nscope: concept\ninstructions: Fill.\n---\n"), /unknown field: instructions/);
  assert.throws(() => parseWikiTemplate("architecture.md", architectureText().replace("purpose: Explain architecture.\n", "")), /purpose/);
  assert.throws(() => parseWikiTemplate("architecture.md", architectureText().replace("cardinality: one", "cardinality: many")), /required templates/);
  assert.throws(() => parseWikiTemplate("architecture.md", architectureText().replace("filename: architecture.md", "filename: architecture-{slug}.md")), /singleton filename/);
  assert.throws(() => parseWikiTemplate("architecture.md", architectureText().replace("## Details", "# Output\n\n## Details")), /not an output H1/);
});

test("loadWikiTemplatePack allows required peers and enforces unique types", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-template-pack-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writePack(root);
  const pack = await loadWikiTemplatePack(root);
  assert.equal(pack.templates.length, 4);
  await writeFile(path.join(root, "operations.md"), contractText("operations", "repo", { identity: false }));
  assert.equal((await loadWikiTemplatePack(root)).templates.length, 5);
  await writeFile(
    path.join(root, "duplicate.md"),
    contractText("duplicate", "repo", { filename: "duplicate.md", identity: false }).replace("type: duplicate", "type: concept"),
  );
  await assert.rejects(loadWikiTemplatePack(root), /unique type/);
});

test("template prompt and catalog are derived from the same contract", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-template-format-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writePack(root);
  const pack = await loadWikiTemplatePack(root);
  const prompt = formatWikiTemplatesForPrompt(pack, new Set(["domain", "concept"]), { target: { path: "billing", mode: "subtree" }, implicit: true });
  assert.match(prompt, /### domain/);
  assert.match(prompt, /Output skeleton/);
  assert.doesNotMatch(prompt, /### overview/);
  assert.match(prompt, /Assigned write target: `subtree:billing`/);
  assert.match(prompt, /wiki\/billing\/\{domain\.md\}/);
  assert.match(prompt, /wiki\/billing\/<concept>\/\{concept\.md\}/);
  assert.match(prompt, /host generates every `index\.md` and root `log\.md`/);
  const full = formatWikiTemplatesForPrompt(pack);
  assert.match(full, /wiki\/<scopeId>\/<domain>\/<concept>\/\{concept\.md\}/);
  const repositoryTarget = { path: "backend", mode: "directory" } as const;
  const repositoryTemplates = templatesForTarget(pack, repositoryTarget, false);
  const repository = formatWikiTemplatesForPrompt(pack, new Set(repositoryTemplates.map((item) => item.id)), { target: repositoryTarget });
  assert.match(repository, /Repository pages: `wiki\/backend\/\{architecture\.md\}`/);
  assert.doesNotMatch(repository, /<domain>|<concept>/);
  const domainTarget = { path: "backend/billing", mode: "subtree" } as const;
  const domainTemplates = templatesForTarget(pack, domainTarget, false);
  const domain = formatWikiTemplatesForPrompt(pack, new Set(domainTemplates.map((item) => item.id)), { target: domainTarget });
  assert.match(domain, /wiki\/backend\/billing\/\{domain\.md\}/);
  assert.match(domain, /wiki\/backend\/billing\/<concept>\/\{concept\.md\}/);
  const rootTarget = { path: "wiki-root", mode: "directory" } as const;
  const rootTemplates = templatesForTarget(pack, rootTarget, true);
  const rootOnly = formatWikiTemplatesForPrompt(pack, new Set(rootTemplates.map((item) => item.id)), { target: rootTarget, implicit: true });
  assert.match(rootOnly, /Wiki-root pages: `wiki\/\{architecture\.md, overview\.md\}`/);
  assert.doesNotMatch(rootOnly, /<domain>/);
  assert.match(formatWikiTemplateCatalog(pack), /### domain/);
  assert.equal(templatesForTarget(pack, { path: "billing", mode: "subtree" }, true).every((item) => item.scope === "domain" || item.scope === "concept"), true);
});

test("packaged writer directory contract maps every default page type", async () => {
  const pack = await loadWikiTemplatePack(packagedTemplatesRoot("en"));
  const repositoryTarget = { path: "backend", mode: "directory" } as const;
  const repositoryTemplates = templatesForTarget(pack, repositoryTarget, false);
  const repository = formatWikiTemplatesForPrompt(pack, new Set(repositoryTemplates.map((item) => item.id)), { target: repositoryTarget });
  assert.ok(repository.includes("- Repository pages: `wiki/backend/{api-{slug}.md, architecture.md, config.md, development.md, runbook-{slug}.md, security.md}`"));
  assert.doesNotMatch(repository, /Domain pages|Concept pages/);

  const domainTarget = { path: "backend/runtime", mode: "subtree" } as const;
  const domainTemplates = templatesForTarget(pack, domainTarget, false);
  const domain = formatWikiTemplatesForPrompt(pack, new Set(domainTemplates.map((item) => item.id)), { target: domainTarget });
  assert.ok(domain.includes("- Domain pages: `wiki/backend/runtime/{domain.md, flow-{slug}.md, integration.md}`"));
  assert.ok(domain.includes("- Concept pages: `wiki/backend/runtime/<concept>/{concept.md, data.md, states.md}`"));

  const rootTarget = { path: "wiki-root", mode: "directory" } as const;
  const rootTemplates = templatesForTarget(pack, rootTarget, true);
  const root = formatWikiTemplatesForPrompt(pack, new Set(rootTemplates.map((item) => item.id)), { target: rootTarget, implicit: true });
  assert.ok(root.includes("- Wiki-root pages: `wiki/{architecture.md, overview.md, api-{slug}.md, config.md, development.md, runbook-{slug}.md, security.md}`"));
});

test("resolveWikiTemplatePack rejects missing, outside, and non-directory paths", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-templates-resolve-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const workspace = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  await writePack(path.join(workspace, "wiki-templates"));
  await mkdir(outside);
  assert.equal((await resolveWikiTemplatePack(workspace, "wiki-templates")).templates.length, 4);
  await assert.rejects(resolveWikiTemplatePack(workspace, "missing"), /not found/);
  await assert.rejects(resolveWikiTemplatePack(workspace, "../outside"), /inside the Workspace/);
  await writeFile(path.join(workspace, "file.md"), "---\nscope: wiki\n---\n");
  await assert.rejects(resolveWikiTemplatePack(workspace, "file.md"), /must be a directory/);
});
