import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePage } from "./frontmatter.js";
import { markdownStructure } from "./markdown-structure.js";
import { isSafeWikiPagePath } from "./path.js";

const WIKI_TEMPLATE_SCOPES = ["wiki", "repo", "domain", "concept"] as const;
export type WikiTemplateScope = (typeof WIKI_TEMPLATE_SCOPES)[number];

const ANCHOR_SCOPES = ["wiki", "domain", "concept"] as const;
export const HOST_PAGE_KEYS = ["scope", "altitudes", "diagram", "optional", "instructions"] as const;
const TEMPLATE_FIELDS = new Set(["type", ...HOST_PAGE_KEYS]);
const SCOPE_SET = new Set<string>(WIKI_TEMPLATE_SCOPES);
const DIAGRAM_KIND = /^[A-Za-z][A-Za-z0-9-]*$/;
const ALTITUDE_SCOPES = new Set<WikiTemplateScope>(["wiki", "repo"]);

export interface WikiTemplate {
  file: string;
  type: string;
  scope?: WikiTemplateScope;
  altitudes?: WikiTemplateScope[];
  diagram?: string[];
  diagramSections: string[];
  optional: boolean;
  instructions: string;
  sections: string[];
  body: string;
}

export interface WikiTemplatePack {
  templates: WikiTemplate[];
}

export function anchorTemplate(pack: WikiTemplatePack, scope: WikiTemplateScope): WikiTemplate {
  const template = pack.templates.find((candidate) => candidate.scope === scope && !candidate.optional && !candidate.altitudes);
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
  for (const scope of ANCHOR_SCOPES) {
    const anchors = templates.filter((template) => template.scope === scope && !template.optional && !template.altitudes);
    if (anchors.length !== 1) {
      throw new Error(`Wiki templates require exactly one non-optional ${scope} template, found ${anchors.length}`);
    }
  }
  const repoAnchors = templates.filter((template) => template.scope === "repo" && !template.optional && !template.altitudes);
  if (repoAnchors.length > 1) {
    throw new Error(`Wiki templates allow at most one repo anchor, found ${repoAnchors.length}`);
  }
  const dual = templates.filter((template) => template.altitudes);
  if (dual.length !== 1 || dual[0]?.file !== "architecture.md" || dual[0].optional
    || !dual[0].altitudes?.includes("wiki") || !dual[0].altitudes.includes("repo")) {
    throw new Error("Wiki templates require exactly one altitudes page: architecture.md with wiki and repo");
  }
  return { templates };
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
  const altitudes = parseAltitudes(filename, parsed.frontmatter.altitudes);
  const hasScope = parsed.frontmatter.scope !== undefined;
  if (altitudes && hasScope) throw new Error(`${filename} cannot set both scope and altitudes`);
  const scope = altitudes ? undefined : parsed.frontmatter.scope === undefined ? "concept" : parsed.frontmatter.scope;
  if (!altitudes && (typeof scope !== "string" || !SCOPE_SET.has(scope))) {
    throw new Error(`${filename} scope must be wiki, repo, domain, or concept`);
  }
  const type = parsed.frontmatter.type === undefined ? filename.slice(0, -3) : parsed.frontmatter.type;
  if (typeof type !== "string" || !type.trim()) throw new Error(`${filename} type must be a non-empty string`);
  const optional = parsed.frontmatter.optional === undefined ? false : parsed.frontmatter.optional;
  if (typeof optional !== "boolean") throw new Error(`${filename} optional must be true or false`);
  if (altitudes && optional) throw new Error(`${filename} altitudes pages cannot be optional`);
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
  const diagramSections = structure.sections
    .filter((section) => section.lines.some((line) => line.trim().startsWith("```")))
    .map((section) => section.title);
  return {
    file: filename,
    type: type.trim(),
    ...(scope ? { scope: scope as WikiTemplateScope } : {}),
    ...(altitudes ? { altitudes } : {}),
    ...(diagram ? { diagram } : {}),
    diagramSections,
    optional,
    instructions: instructions.trim(),
    sections,
    body: parsed.body,
  };
}

export function templatesForPartition(
  pack: WikiTemplatePack,
  partition: string,
  implicit: boolean,
): WikiTemplate[] {
  if (partition === "wiki-root") {
    return pack.templates.filter((template) => (
      template.scope === "wiki"
      || template.altitudes?.includes("wiki")
      || (implicit && (template.scope === "repo" || template.altitudes?.includes("repo")))
    ));
  }
  if (!implicit) {
    return pack.templates.filter((template) => (
      template.scope === "repo"
      || template.scope === "domain"
      || template.scope === "concept"
      || template.altitudes?.includes("repo")
    ));
  }
  return pack.templates.filter((template) => template.scope === "domain" || template.scope === "concept");
}

export function formatWikiTemplatesForPrompt(
  pack: WikiTemplatePack,
  files?: ReadonlySet<string>,
  partition?: string,
): string {
  const selected = files ? pack.templates.filter((template) => files.has(template.file)) : pack.templates;
  if (!selected.length) return "";
  const line = (template: WikiTemplate) => {
    const diagram = template.diagram?.length ? ` — mermaid ${template.diagram.join(" | ")}` : "";
    const place = template.altitudes
      ? `altitudes ${template.altitudes.join("+")}`
      : `${template.scope} ${template.optional ? "optional" : "anchor"}`;
    return `- \`${template.file}\` — ${place} — type \`${template.type}\`${diagram}`;
  };
  const required = selected.filter((template) => !template.optional);
  const optional = selected.filter((template) => template.optional);
  const repositoryPartition = selected.some((template) => (
    template.scope === "repo" || template.altitudes?.includes("repo")
  ));
  const placement = partition === "wiki-root"
    ? "Write selected wiki-root files in this partition."
    : partition && repositoryPartition
      ? "Write selected repo, domain, and concept files under <scopeId>/ in this partition."
      : partition
        ? "Write domain.md and concept.md for every cluster in this prefix. Keep or drop optionals after reopening source."
        : selected.some((template) => template.scope === "wiki" || template.altitudes?.includes("wiki"))
          ? "Write selected wiki-root files in this partition."
          : selected.some((template) => template.scope === "repo" || template.altitudes?.includes("repo"))
            ? "Write selected repo, domain, and concept files under <scopeId>/ in this partition."
            : "Write domain.md and concept.md for every cluster in this prefix. Keep or drop optionals after reopening source.";
  const sections = [
    "## Page templates",
    "",
    placement,
    "Candidate frontmatter is type, title, description, and sources only. Template fields never appear on pages.",
    "Attribute claims with [^id] footnotes whose id matches sources[].id. Resource locators are paths from the Workspace root with optional exact #Lx[-Ly] ranges (api/src/main.ts#L1, or src/main.ts in an implicit Workspace), or catalog:table when Catalog tools are available.",
    "Copy the skeleton H1 and H2 order exactly. Fill every H2 section. H3 subsections are allowed.",
    "Replace every {{placeholder}}. Mermaid nodes use source identifiers, not translations.",
    "This is an OKF bundle for later agents. They start at wiki/index.md.",
    "",
    "Required:",
    ...required.map(line),
  ];
  if (optional.length) {
    sections.push("", "Optional (writer keeps or drops after reading source):", ...optional.map(line));
  }
  for (const template of selected) {
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

export function formatWikiTemplateCatalog(pack: WikiTemplatePack): string {
  if (!pack.templates.length) return "";
  const sections = [
    "## Page template catalog",
    "",
    "Use this catalog for evidence-backed template hints and semantic review. The host validates paths and skeleton structure.",
  ];
  for (const template of pack.templates) {
    const place = template.altitudes
      ? `altitudes ${template.altitudes.join("+")}`
      : `scope ${template.scope}; ${template.optional ? "optional" : "anchor"}`;
    const diagram = template.diagram?.length ? `; diagram ${template.diagram.join(" | ")}` : "";
    sections.push(
      "",
      `- \`${template.file}\`: ${place}; type \`${template.type}\`${diagram}`,
      `  ${template.instructions}`,
    );
  }
  return `${sections.join("\n")}\n`;
}

function parseAltitudes(filename: string, value: unknown): WikiTemplateScope[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some((entry) => typeof entry !== "string" || !ALTITUDE_SCOPES.has(entry as WikiTemplateScope))) {
    throw new Error(`${filename} altitudes must be wiki and/or repo`);
  }
  return [...new Set(values.map((entry) => String(entry).trim() as WikiTemplateScope))];
}

function parseDiagram(filename: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some((entry) => typeof entry !== "string" || !DIAGRAM_KIND.test(entry.trim()))) {
    throw new Error(`${filename} diagram must be a mermaid kind or a list of kinds`);
  }
  return [...new Set(values.map((entry) => String(entry).trim()))];
}
