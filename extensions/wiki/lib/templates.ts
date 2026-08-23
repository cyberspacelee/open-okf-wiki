import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePage } from "./frontmatter.js";
import { markdownStructure, sectionHasContent } from "./markdown-structure.js";
import { isSafeWikiPagePath } from "./path.js";

const WIKI_TEMPLATE_SCOPES = ["wiki", "repo", "domain", "concept"] as const;
export type WikiTemplateScope = (typeof WIKI_TEMPLATE_SCOPES)[number];
export type WikiTemplateCardinality = "one" | "many";

export const HOST_PAGE_KEYS = [
  "id",
  "identity",
  "scope",
  "altitudes",
  "filename",
  "cardinality",
  "required",
  "purpose",
  "applies_when",
  "diagram",
] as const;
const TEMPLATE_FIELDS = new Set(["type", ...HOST_PAGE_KEYS]);
const SCOPE_SET = new Set<string>(WIKI_TEMPLATE_SCOPES);
const ALTITUDE_SCOPES = new Set<WikiTemplateScope>(["wiki", "repo"]);
const TEMPLATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIAGRAM_KIND = /^[A-Za-z][A-Za-z0-9-]*$/;
const SLUG_TOKEN = "{slug}";

export interface WikiTemplateSection {
  title: string;
  guidance: string;
}

export interface WikiTemplateDiagram {
  section: string;
  kinds: string[];
}

export interface WikiTemplate {
  sourceFile: string;
  id: string;
  type: string;
  scope?: WikiTemplateScope;
  altitudes?: WikiTemplateScope[];
  identities?: WikiTemplateScope[];
  filename: string;
  cardinality: WikiTemplateCardinality;
  required: boolean;
  purpose: string;
  appliesWhen?: string;
  diagram?: WikiTemplateDiagram;
  sections: WikiTemplateSection[];
}

export interface WikiTemplatePack {
  templates: WikiTemplate[];
}

export function identityTemplate(pack: WikiTemplatePack, scope: WikiTemplateScope): WikiTemplate {
  const template = pack.templates.find((candidate) => candidate.identities?.includes(scope));
  if (!template) throw new Error(`Wiki templates have no ${scope} identity contract`);
  return template;
}

export function altitudeTemplate(pack: WikiTemplatePack, altitude: "wiki" | "repo"): WikiTemplate {
  const template = pack.templates.find((candidate) => candidate.required && candidate.altitudes?.includes(altitude));
  if (!template) throw new Error(`Wiki templates have no ${altitude} altitude anchor`);
  return template;
}

export function templateMatchesFilename(template: WikiTemplate, filename: string): boolean {
  if (template.cardinality === "one") return filename === template.filename;
  const [prefix, suffix] = template.filename.split(SLUG_TOKEN);
  if (prefix === undefined || suffix === undefined || !filename.startsWith(prefix) || !filename.endsWith(suffix)) return false;
  const slug = filename.slice(prefix.length, filename.length - suffix.length);
  return TEMPLATE_ID.test(slug);
}

export function templateOutputSkeleton(template: WikiTemplate): string {
  const lines = ["# {{title}}", "", "{{description}}"];
  for (const section of template.sections) {
    lines.push("", `## ${section.title}`);
    if (template.diagram?.section === section.title) {
      lines.push("", "```mermaid", template.diagram.kinds[0]!, "  {{diagram}}", "```");
    }
  }
  return `${lines.join("\n")}\n`;
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
  if (!stat.isDirectory()) throw new Error(`wiki.templates must be a directory: ${templates}`);
  return await loadWikiTemplatePack(resolved);
}

export async function loadWikiTemplatePack(directory: string): Promise<WikiTemplatePack> {
  const root = await realpath(directory);
  const entries = (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  if (entries.some((entry) => entry.isDirectory())) throw new Error(`Wiki templates must be a flat directory: ${root}`);
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
  if (!files.length) throw new Error(`Wiki templates directory is empty: ${root}`);
  const templates = await Promise.all(files.map(async (entry) => (
    parseWikiTemplate(entry.name, await readFile(path.join(root, entry.name), "utf8"))
  )));
  assertUniqueTypes(templates);
  for (const scope of WIKI_TEMPLATE_SCOPES) {
    const anchors = templates.filter((template) => template.identities?.includes(scope));
    if (anchors.length !== 1) {
      throw new Error(`Wiki templates require exactly one ${scope} identity contract, found ${anchors.length}`);
    }
  }
  const dual = templates.filter((template) => template.altitudes);
  if (dual.length !== 1 || !dual[0]?.required || dual[0].cardinality !== "one"
    || !dual[0].altitudes?.includes("wiki") || !dual[0].altitudes.includes("repo")) {
    throw new Error("Wiki templates require exactly one required singleton page at wiki and repo altitudes");
  }
  return { templates };
}

export function parseWikiTemplate(sourceFile: string, text: string): WikiTemplate {
  if (!isSafeWikiPagePath(sourceFile)) throw new Error(`Illegal Wiki template filename: ${sourceFile}`);
  let parsed;
  try {
    parsed = parsePage(text);
  } catch (error) {
    throw new Error(`${sourceFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const unknown = Object.keys(parsed.frontmatter).filter((key) => !TEMPLATE_FIELDS.has(key));
  if (unknown.length > 0) throw new Error(`${sourceFile} has unknown field: ${unknown[0]}`);
  const id = requiredString(sourceFile, "id", parsed.frontmatter.id);
  if (!TEMPLATE_ID.test(id)) throw new Error(`${sourceFile} id must be lowercase kebab-case`);
  if (sourceFile !== `${id}.md`) throw new Error(`${sourceFile} must match contract id ${id}`);
  const type = requiredString(sourceFile, "type", parsed.frontmatter.type);
  const purpose = requiredString(sourceFile, "purpose", parsed.frontmatter.purpose);
  const altitudes = parseAltitudes(sourceFile, parsed.frontmatter.altitudes);
  const hasScope = parsed.frontmatter.scope !== undefined;
  if (altitudes && hasScope) throw new Error(`${sourceFile} cannot set both scope and altitudes`);
  const scope = altitudes ? undefined : parsed.frontmatter.scope;
  if (!altitudes && (typeof scope !== "string" || !SCOPE_SET.has(scope))) {
    throw new Error(`${sourceFile} scope must be wiki, repo, domain, or concept`);
  }
  const cardinality = parsed.frontmatter.cardinality;
  if (cardinality !== "one" && cardinality !== "many") {
    throw new Error(`${sourceFile} cardinality must be one or many`);
  }
  const required = parsed.frontmatter.required;
  if (typeof required !== "boolean") throw new Error(`${sourceFile} required must be true or false`);
  if (required && cardinality === "many") throw new Error(`${sourceFile} required templates must have cardinality one`);
  const appliesWhen = parsed.frontmatter.applies_when;
  if (required && appliesWhen !== undefined) throw new Error(`${sourceFile} required templates cannot set applies_when`);
  if (!required && (typeof appliesWhen !== "string" || !appliesWhen.trim())) {
    throw new Error(`${sourceFile} evidence-selected templates require applies_when`);
  }
  const filename = requiredString(sourceFile, "filename", parsed.frontmatter.filename);
  validateFilenamePattern(sourceFile, filename, cardinality);
  const identities = parseIdentities(sourceFile, parsed.frontmatter.identity);
  if (identities && (!required || cardinality !== "one")) {
    throw new Error(`${sourceFile} identity contracts must be required singletons`);
  }
  const placements = new Set<WikiTemplateScope>(altitudes ?? [scope as WikiTemplateScope]);
  if (identities?.some((identity) => !placements.has(identity))) {
    throw new Error(`${sourceFile} identity must be one of the contract placements`);
  }
  const structure = markdownStructure(parsed.body);
  if (structure.headings.some((heading) => heading.level === 1)) {
    throw new Error(`${sourceFile} contract body must contain H2 obligations, not an output H1`);
  }
  const sections = structure.sections.map((section) => ({
    title: section.title,
    guidance: section.lines.join("\n").trim(),
  }));
  if (!sections.length) throw new Error(`${sourceFile} contract body must declare at least one H2 obligation`);
  if (new Set(sections.map((section) => section.title)).size !== sections.length) {
    throw new Error(`${sourceFile} contract body has duplicate H2 obligations`);
  }
  if (structure.sections.some((section) => !sectionHasContent(section))) {
    throw new Error(`${sourceFile} every H2 obligation needs guidance`);
  }
  const diagram = parseDiagram(sourceFile, parsed.frontmatter.diagram, sections.map((section) => section.title));
  return {
    sourceFile,
    id,
    type,
    ...(scope ? { scope: scope as WikiTemplateScope } : {}),
    ...(altitudes ? { altitudes } : {}),
    ...(identities ? { identities } : {}),
    filename,
    cardinality,
    required,
    purpose,
    ...(!required ? { appliesWhen: String(appliesWhen).trim() } : {}),
    ...(diagram ? { diagram } : {}),
    sections,
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
  ids?: ReadonlySet<string>,
  partition?: string,
): string {
  const selected = ids ? pack.templates.filter((template) => ids.has(template.id)) : pack.templates;
  if (!selected.length) return "";
  const repositoryPartition = selected.some((template) => template.scope === "repo" || template.altitudes?.includes("repo"));
  const placement = partition === "wiki-root"
    ? "Write only contracts placed at the Wiki root."
    : partition && repositoryPartition
      ? "Write repository, Domain, and Concept contracts under the assigned <scopeId>/ prefix."
      : "Write Domain and Concept contracts under the assigned Domain prefix.";
  const lines = [
    "## Active page contracts",
    "",
    placement,
    "A required singleton must exist at every applicable directory. `Identity` marks the page used by that directory's generated index. An evidence-selected contract is written only when inspected evidence satisfies `Applies when`; a `many` contract may produce multiple pages by replacing `{slug}` with a specific topic slug.",
    "Candidate frontmatter contains only `type`, `title`, `description`, and `sources`. The H1 equals `title`; the first paragraph equals the routing-quality `description`; H2 headings follow the contract exactly. Every non-diagram H2 contains a matching `[^id]` source footnote. Replace every placeholder and use source identifiers in Mermaid nodes.",
  ];
  for (const template of selected) lines.push("", ...formatTemplate(template, true));
  return `${lines.join("\n")}\n`;
}

export function formatWikiTemplateCatalog(pack: WikiTemplatePack): string {
  const lines = [
    "## Page contract catalog",
    "",
    "Use contract ids in evidence hints. Survey finds evidence for the semantic obligations; review checks the generated page against them. The host validates filenames, placement, headings, sources, links, and diagrams.",
  ];
  for (const template of pack.templates) lines.push("", ...formatTemplate(template, false));
  return `${lines.join("\n")}\n`;
}

function formatTemplate(template: WikiTemplate, skeleton: boolean): string[] {
  const placement = template.altitudes ? template.altitudes.join(" + ") : template.scope;
  const selection = template.required ? "required" : `evidence-selected; applies when ${template.appliesWhen}`;
  const lines = [
    `### ${template.id}`,
    "",
    `- Type: \`${template.type}\``,
    `- Placement: ${placement}`,
    ...(template.identities?.length ? [`- Identity: ${template.identities.join(" + ")}`] : []),
    `- Filename: \`${template.filename}\` (${template.cardinality})`,
    `- Selection: ${selection}`,
    `- Purpose: ${template.purpose}`,
    "- Semantic obligations:",
    ...template.sections.map((section) => `  - **${section.title}**: ${section.guidance.replace(/\s+/g, " ")}`),
  ];
  if (template.diagram) lines.push(`- Diagram: ${template.diagram.section}; Mermaid ${template.diagram.kinds.join(" | ")}`);
  if (skeleton) lines.push("", "Output skeleton:", "", "```markdown", templateOutputSkeleton(template).trimEnd(), "```");
  return lines;
}

function requiredString(sourceFile: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${sourceFile} ${field} must be a non-empty string`);
  return value.trim();
}

function validateFilenamePattern(sourceFile: string, filename: string, cardinality: WikiTemplateCardinality): void {
  const tokenCount = filename.split(SLUG_TOKEN).length - 1;
  if (cardinality === "one" && tokenCount !== 0) throw new Error(`${sourceFile} singleton filename cannot contain {slug}`);
  if (cardinality === "many" && tokenCount !== 1) throw new Error(`${sourceFile} many filename must contain one {slug}`);
  if (!isSafeWikiPagePath(filename.replace(SLUG_TOKEN, "topic")) || filename.includes("/")) {
    throw new Error(`${sourceFile} filename must be a safe kebab-case Markdown basename`);
  }
}

function parseAltitudes(sourceFile: string, value: unknown): WikiTemplateScope[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some((entry) => typeof entry !== "string" || !ALTITUDE_SCOPES.has(entry as WikiTemplateScope))) {
    throw new Error(`${sourceFile} altitudes must be wiki and/or repo`);
  }
  return [...new Set(values.map((entry) => String(entry).trim() as WikiTemplateScope))];
}

function parseIdentities(sourceFile: string, value: unknown): WikiTemplateScope[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some((entry) => typeof entry !== "string" || !SCOPE_SET.has(entry))) {
    throw new Error(`${sourceFile} identity must be wiki, repo, domain, concept, or a list of them`);
  }
  return [...new Set(values.map((entry) => String(entry).trim() as WikiTemplateScope))];
}

function parseDiagram(sourceFile: string, value: unknown, sections: readonly string[]): WikiTemplateDiagram | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceFile} diagram must contain section and kinds`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "section" && key !== "kinds");
  if (unknown.length) throw new Error(`${sourceFile} diagram has unknown field: ${unknown[0]}`);
  const section = requiredString(sourceFile, "diagram.section", record.section);
  if (!sections.includes(section)) throw new Error(`${sourceFile} diagram.section must name an H2 obligation`);
  const values = Array.isArray(record.kinds) ? record.kinds : [record.kinds];
  if (!values.length || values.some((entry) => typeof entry !== "string" || !DIAGRAM_KIND.test(entry.trim()))) {
    throw new Error(`${sourceFile} diagram.kinds must be Mermaid kinds`);
  }
  return { section, kinds: [...new Set(values.map((entry) => String(entry).trim()))] };
}

function assertUniqueTypes(templates: readonly WikiTemplate[]): void {
  const seen = new Set<string>();
  for (const template of templates) {
    if (seen.has(template.type)) throw new Error(`Wiki templates require unique type: ${template.type}`);
    seen.add(template.type);
  }
}
