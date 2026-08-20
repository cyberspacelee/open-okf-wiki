import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePage } from "./frontmatter.js";
import { markdownStructure } from "./markdown-structure.js";
import { isSafeWikiPagePath } from "./path.js";

const WIKI_TEMPLATE_SCOPES = ["wiki", "source", "domain", "concept"] as const;
export type WikiTemplateScope = (typeof WIKI_TEMPLATE_SCOPES)[number];

export const HOST_PAGE_KEYS = ["scope", "diagram", "optional", "instructions"] as const;
const TEMPLATE_FIELDS = new Set(["type", ...HOST_PAGE_KEYS]);
const SCOPE_SET = new Set<string>(WIKI_TEMPLATE_SCOPES);
const DIAGRAM_KIND = /^[A-Za-z][A-Za-z0-9-]*$/;

export interface WikiTemplate {
  file: string;
  type: string;
  scope: WikiTemplateScope;
  diagram?: string[];
  optional: boolean;
  instructions: string;
  sections: string[];
  body: string;
}

export interface WikiTemplatePack {
  directory: string;
  templates: WikiTemplate[];
}

export function anchorTemplate(pack: WikiTemplatePack, scope: WikiTemplateScope): WikiTemplate {
  const template = pack.templates.find((candidate) => candidate.scope === scope && !candidate.optional);
  if (!template) throw new Error(`Wiki templates have no ${scope} anchor`);
  return template;
}

export function packagedTemplatesRoot(language: "zh" | "en"): string {
  return fileURLToPath(new URL(`../../../templates/${language}`, import.meta.url));
}

export async function resolveWikiTemplatePack(
  workspaceRoot: string,
  templates?: string,
  language: "zh" | "en" = "zh",
): Promise<WikiTemplatePack> {
  if (!templates) return await loadWikiTemplatePack(packagedTemplatesRoot(language));
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(workspaceRoot, templates));
  } catch {
    throw new Error(`wiki.templates not found: ${templates}`);
  }
  const root = await realpath(workspaceRoot);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`wiki.templates must stay inside the Workspace: ${templates}`);
  }
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`wiki.templates must be a directory: ${templates}`);
  }
  return await loadWikiTemplatePack(resolved);
}

export async function loadWikiTemplatePack(directory: string): Promise<WikiTemplatePack> {
  const root = await realpath(directory);
  const entries = (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  if (entries.some((entry) => entry.isDirectory())) {
    throw new Error(`Wiki templates must be a flat directory: ${root}`);
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
  if (!files.length) throw new Error(`Wiki templates directory is empty: ${root}`);
  const templates: WikiTemplate[] = [];
  for (const entry of files) {
    const text = await readFile(path.join(root, entry.name), "utf8");
    templates.push(parseWikiTemplate(entry.name, text));
  }
  for (const scope of WIKI_TEMPLATE_SCOPES) {
    const anchors = templates.filter((template) => template.scope === scope && !template.optional);
    if (anchors.length !== 1) {
      throw new Error(`Wiki templates require exactly one non-optional ${scope} template, found ${anchors.length}`);
    }
  }
  return { directory: root, templates };
}

export function parseWikiTemplate(filename: string, text: string): WikiTemplate {
  if (!isSafeWikiPagePath(filename)) throw new Error(`Illegal Wiki template filename: ${filename}`);
  let parsed;
  try {
    parsed = parsePage(text);
  } catch (error) {
    throw new Error(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const unknown = Object.keys(parsed.frontmatter).filter((key) => !TEMPLATE_FIELDS.has(key));
  if (unknown.length > 0) throw new Error(`${filename} has unknown field: ${unknown[0]}`);
  const scope = parsed.frontmatter.scope === undefined ? "concept" : parsed.frontmatter.scope;
  if (typeof scope !== "string" || !SCOPE_SET.has(scope)) {
    throw new Error(`${filename} scope must be wiki, source, domain, or concept`);
  }
  const type = parsed.frontmatter.type === undefined ? filename.slice(0, -3) : parsed.frontmatter.type;
  if (typeof type !== "string" || !type.trim()) throw new Error(`${filename} type must be a non-empty string`);
  const optional = parsed.frontmatter.optional === undefined ? false : parsed.frontmatter.optional;
  if (typeof optional !== "boolean") throw new Error(`${filename} optional must be true or false`);
  const instructions = parsed.frontmatter.instructions;
  if (typeof instructions !== "string" || !instructions.trim()) {
    throw new Error(`${filename} instructions must be a non-empty string`);
  }
  const diagram = parseDiagram(filename, parsed.frontmatter.diagram);
  const structure = markdownStructure(parsed.body);
  const h1 = structure.headings.filter((heading) => heading.level === 1);
  if (h1.length !== 1 || h1[0]?.title !== "{{title}}") {
    throw new Error(`${filename} body must have exactly one # {{title}} heading`);
  }
  if (structure.summary !== "{{description}}") {
    throw new Error(`${filename} body must put {{description}} between the title and first H2`);
  }
  const sections = structure.sections.map((section) => section.title);
  if (!sections.length) throw new Error(`${filename} body must declare at least one H2 section`);
  if (new Set(sections).size !== sections.length) throw new Error(`${filename} body has duplicate H2 sections`);
  return {
    file: filename,
    type: type.trim(),
    scope: scope as WikiTemplateScope,
    ...(diagram ? { diagram } : {}),
    optional,
    instructions: instructions.trim(),
    sections,
    body: parsed.body,
  };
}

export function formatWikiTemplatesForPrompt(pack: WikiTemplatePack): string {
  if (!pack.templates.length) return "";
  const line = (template: WikiTemplate) => {
    const diagram = template.diagram?.length ? ` — mermaid ${template.diagram.join(" | ")}` : "";
    const role = template.optional ? "optional" : "anchor";
    return `- \`${template.file}\` — ${template.scope} ${role} — type \`${template.type}\`${diagram}`;
  };
  const required = pack.templates.filter((template) => !template.optional);
  const optional = pack.templates.filter((template) => template.optional);
  const sections = [
    "## Page templates",
    "",
    "The Workspace template pack is the page contract. Write its four anchor files at their scopes.",
    "Write an optional file only when the survey lists it at that source, domain, or concept with evidence.",
    "Candidate frontmatter is type, title, description, and sources only. Template fields never appear on pages.",
    "Attribute claims with [^id] footnotes whose id matches sources[].id. Resource locators are scope/path#Lx against pinned sources.",
    "Copy the skeleton H1 and H2 order exactly. Fill every H2 section. H3 subsections are allowed.",
    "Replace every {{placeholder}}. Mermaid nodes use source identifiers, not translations.",
    "This is an OKF bundle for later agents. They start at wiki/index.md.",
    "",
    "Required:",
    ...required.map(line),
  ];
  if (optional.length) {
    sections.push("", "Optional (survey lists which apply):", ...optional.map(line));
  }
  for (const template of pack.templates) {
    sections.push(
      "",
      `### ${template.file}`,
      "",
      "Instructions:",
      template.instructions,
      "",
      "Skeleton:",
      template.body.trimEnd(),
    );
  }
  return `${sections.join("\n")}\n`;
}

function parseDiagram(filename: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some((entry) => typeof entry !== "string" || !DIAGRAM_KIND.test(entry.trim()))) {
    throw new Error(`${filename} diagram must be a mermaid kind or a list of kinds`);
  }
  return [...new Set(values.map((entry) => String(entry).trim()))];
}
