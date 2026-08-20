import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  assert.deepEqual(byFile["architecture.md"]?.diagram, ["flowchart"]);
  assert.deepEqual(byFile["flows.md"]?.diagram, ["sequenceDiagram", "flowchart"]);
  assert.equal(byFile["states.md"]?.optional, true);
  assert.equal(byFile["data.md"]?.optional, true);
  assert.equal(byFile["concept.md"]?.optional, false);
  assert.match(zh.templates.find((template) => template.file === "architecture.md")?.body ?? "", /组件/);
  assert.match(en.templates.find((template) => template.file === "architecture.md")?.body ?? "", /Components/);
  assert.match(formatWikiTemplatesForPrompt(zh), /Required:/);
  assert.match(formatWikiTemplatesForPrompt(en), /`architecture\.md`/);
  assert.match(formatWikiTemplatesForPrompt(en), /Optional \(survey lists which apply\):/);
});

test("resolveWikiTemplatePack selects the packaged language when wiki.templates is unset", async () => {
  const zh = await resolveWikiTemplatePack("/tmp", undefined, "zh");
  const en = await resolveWikiTemplatePack("/tmp", undefined, "en");
  assert.match(zh.templates.find((template) => template.file === "flows.md")?.body ?? "", /参与者/);
  assert.match(en.templates.find((template) => template.file === "flows.md")?.body ?? "", /Participants/);
});

test("parseWikiTemplate defaults scope to concept and type to the filename", () => {
  const parsed = parseWikiTemplate("arch.md", "---\ndiagram: flowchart\n---\n# Arch\n");
  assert.equal(parsed.type, "arch");
  assert.equal(parsed.scope, "concept");
  assert.deepEqual(parsed.diagram, ["flowchart"]);
  assert.equal(parsed.optional, false);
});

test("parseWikiTemplate rejects unknown fields and illegal names", () => {
  assert.throws(() => parseWikiTemplate("arch.md", "---\nscope: concept\ntitle: Arch\n---\n"), /unknown field: title/);
  assert.throws(() => parseWikiTemplate("Arch.md", "---\nscope: concept\n---\n"), /Illegal Wiki template filename/);
  assert.throws(() => parseWikiTemplate("arch.md", "---\nscope: entity\n---\n"), /scope must be wiki, source, domain, or concept/);
  assert.throws(() => parseWikiTemplate("arch.md", "# no frontmatter\n"), /missing YAML frontmatter/);
});

test("loadWikiTemplatePack rejects nested directories and an empty pack", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-templates-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await assert.rejects(loadWikiTemplatePack(root), /empty/);
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "arch.md"), "---\nscope: concept\n---\n# Arch\n");
  await assert.rejects(loadWikiTemplatePack(root), /flat directory/);
});

test("resolveWikiTemplatePack uses a Workspace directory and rejects paths outside it", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-templates-resolve-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const workspace = path.join(parent, "ws");
  const outside = path.join(parent, "outside");
  await mkdir(path.join(workspace, "wiki-templates"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(workspace, "wiki-templates", "overview.md"), "---\nscope: wiki\n---\n# Overview\n");
  await writeFile(path.join(outside, "overview.md"), "---\nscope: wiki\n---\n# Overview\n");
  const pack = await resolveWikiTemplatePack(workspace, "wiki-templates");
  assert.equal(pack.templates.length, 1);
  assert.equal(pack.templates[0]?.file, "overview.md");
  await assert.rejects(resolveWikiTemplatePack(workspace, "missing"), /not found/);
  await assert.rejects(resolveWikiTemplatePack(workspace, "../outside"), /inside the Workspace/);
  await writeFile(path.join(workspace, "file.md"), "---\nscope: wiki\n---\n");
  await assert.rejects(resolveWikiTemplatePack(workspace, "file.md"), /must be a directory/);
});
