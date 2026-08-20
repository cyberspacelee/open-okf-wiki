import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { markdownStructure } from "../extensions/wiki/lib/markdown-structure.js";
import {
  formatWikiTemplatesForPrompt,
  loadWikiTemplatePack,
  packagedTemplatesRoot,
  parseWikiTemplate,
  resolveWikiTemplatePack,
} from "../extensions/wiki/lib/templates.js";

function contract(pack: Awaited<ReturnType<typeof loadWikiTemplatePack>>) {
  return pack.templates.map((template) => ({
    file: template.file,
    type: template.type,
    scope: template.scope,
    diagram: template.diagram,
    optional: template.optional,
  }));
}

function templateText(scope: "wiki" | "source" | "domain" | "concept", extra = ""): string {
  return `---\nscope: ${scope}\ninstructions: Fill the page from evidence.\n${extra}---\n\n# {{title}}\n\n{{description}}\n\n## Details\n`;
}

async function writeMinimalPack(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "overview.md"), templateText("wiki")),
    writeFile(path.join(directory, "source.md"), templateText("source")),
    writeFile(path.join(directory, "domain.md"), templateText("domain")),
    writeFile(path.join(directory, "concept.md"), templateText("concept")),
  ]);
}

test("packaged zh and en templates share a contract and differ in body language", async () => {
  const zh = await loadWikiTemplatePack(packagedTemplatesRoot("zh"));
  const en = await loadWikiTemplatePack(packagedTemplatesRoot("en"));
  assert.deepEqual(contract(zh), contract(en));
  const byFile = Object.fromEntries(zh.templates.map((template) => [template.file, template]));
  assert.equal(byFile["overview.md"]?.scope, "wiki");
  assert.equal(byFile["source.md"]?.scope, "source");
  assert.equal(byFile["domain.md"]?.scope, "domain");
  assert.equal(byFile["concept.md"]?.scope, "concept");
  assert.equal(byFile["architecture.md"]?.type, "Architecture");
  assert.equal(byFile["architecture.md"]?.scope, "domain");
  assert.equal(byFile["architecture.md"]?.optional, true);
  assert.deepEqual(byFile["architecture.md"]?.diagram, ["flowchart"]);
  assert.deepEqual(byFile["flows.md"]?.diagram, ["sequenceDiagram", "flowchart"]);
  assert.equal(byFile["flows.md"]?.scope, "domain");
  assert.equal(byFile["development.md"]?.scope, "source");
  assert.equal(byFile["runbook.md"]?.scope, "source");
  assert.equal(byFile["interfaces.md"]?.scope, "concept");
  assert.equal(byFile["states.md"]?.optional, true);
  assert.equal(byFile["data.md"]?.optional, true);
  assert.equal(byFile["concept.md"]?.optional, false);
  assert.match(zh.templates.find((template) => template.file === "architecture.md")?.body ?? "", /组件/);
  assert.match(en.templates.find((template) => template.file === "architecture.md")?.body ?? "", /Components/);
  assert.match(formatWikiTemplatesForPrompt(zh), /Required:/);
  assert.match(formatWikiTemplatesForPrompt(en), /`architecture\.md`/);
  assert.match(formatWikiTemplatesForPrompt(en), /Optional \(survey lists which apply\):/);
  assert.match(formatWikiTemplatesForPrompt(en), /Instructions:/);
  assert.match(formatWikiTemplatesForPrompt(en), /Skeleton:/);
});

test("resolveWikiTemplatePack selects the packaged language when wiki.templates is unset", async () => {
  const zh = await resolveWikiTemplatePack("/tmp", undefined, "zh");
  const en = await resolveWikiTemplatePack("/tmp", undefined, "en");
  assert.match(zh.templates.find((template) => template.file === "flows.md")?.body ?? "", /参与者/);
  assert.match(en.templates.find((template) => template.file === "flows.md")?.body ?? "", /Participants/);
});

test("parseWikiTemplate defaults scope to concept and type to the filename", () => {
  const parsed = parseWikiTemplate("arch.md", templateText("concept", "diagram: flowchart\n"));
  assert.equal(parsed.type, "arch");
  assert.equal(parsed.scope, "concept");
  assert.deepEqual(parsed.diagram, ["flowchart"]);
  assert.equal(parsed.optional, false);
});

test("parseWikiTemplate rejects unknown fields and illegal names", () => {
  assert.throws(() => parseWikiTemplate("arch.md", "---\nscope: concept\ntitle: Arch\n---\n"), /unknown field: title/);
  assert.throws(() => parseWikiTemplate("Arch.md", "---\nscope: concept\n---\n"), /Illegal Wiki template filename/);
  assert.throws(() => parseWikiTemplate("arch.md", templateText("concept").replace("scope: concept", "scope: entity")), /scope must be wiki, source, domain, or concept/);
  assert.throws(() => parseWikiTemplate("arch.md", templateText("concept").replace("instructions: Fill the page from evidence.\n", "")), /instructions/);
  assert.throws(() => parseWikiTemplate("arch.md", templateText("concept").replace("# {{title}}", "# Wrong")), /# \{\{title\}\}/);
  assert.throws(() => parseWikiTemplate("arch.md", templateText("concept").replace("## Details", "## Details\n\n## Details")), /duplicate H2/);
  assert.throws(() => parseWikiTemplate("arch.md", "# no frontmatter\n"), /missing YAML frontmatter/);
});

test("loadWikiTemplatePack rejects nested directories and an empty pack", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-templates-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await assert.rejects(loadWikiTemplatePack(root), /empty/);
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "arch.md"), templateText("concept"));
  await assert.rejects(loadWikiTemplatePack(root), /flat directory/);
});

test("loadWikiTemplatePack requires one anchor at every scope", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-template-anchors-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "overview.md"), templateText("wiki"));
  await assert.rejects(loadWikiTemplatePack(root), /exactly one non-optional source template/);
});

test("markdown structure ignores headings inside fenced code", () => {
  const structure = markdownStructure([
    "# Page",
    "",
    "Summary.",
    "",
    "## First",
    "",
    "```md",
    "# Not an H1",
    "## Not a section",
    "```",
    "",
    "## Second",
    "",
    "Content.",
  ].join("\n"));
  assert.deepEqual(structure.headings.map(({ level, title }) => ({ level, title })), [
    { level: 1, title: "Page" },
    { level: 2, title: "First" },
    { level: 2, title: "Second" },
  ]);
});

test("resolveWikiTemplatePack uses a Workspace directory and rejects paths outside it", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-templates-resolve-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const workspace = path.join(parent, "ws");
  const outside = path.join(parent, "outside");
  await writeMinimalPack(path.join(workspace, "wiki-templates"));
  await mkdir(outside);
  const pack = await resolveWikiTemplatePack(workspace, "wiki-templates");
  assert.equal(pack.templates.length, 4);
  await assert.rejects(resolveWikiTemplatePack(workspace, "missing"), /not found/);
  await assert.rejects(resolveWikiTemplatePack(workspace, "../outside"), /inside the Workspace/);
  await writeFile(path.join(workspace, "file.md"), "---\nscope: wiki\n---\n");
  await assert.rejects(resolveWikiTemplatePack(workspace, "file.md"), /must be a directory/);
});
