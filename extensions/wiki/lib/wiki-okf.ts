import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { extractOkfSources, wikiLinkTargets, type SourceCitation } from "./citations.js";
import { HOST_PAGE_KEYS } from "./templates.js";
import { WikiValidationInfrastructureError, errorMessage } from "./failures.js";
import { inside, readText, writeText } from "./files.js";
import { parsePage, stringifyPage } from "./frontmatter.js";
import { markdownStructure, sectionHasContent } from "./markdown-structure.js";
import { isReservedWikiPagePath, isSafeWikiPagePath } from "./path.js";
import { anchorTemplate, type WikiTemplate, type WikiTemplatePack, type WikiTemplateScope } from "./templates.js";

export const GENERATED_BY = "open-okf-wiki/1.0.0";
export const VERIFIED_BY = "process:open-okf-wiki-review";

const MERMAID_KIND = /```mermaid[^\n]*\r?\n\s*([A-Za-z][A-Za-z0-9-]*)/;
const SCOPE_DEPTH: Record<WikiTemplateScope, number> = { wiki: 1, source: 2, domain: 3, concept: 4 };

export interface WikiValidationIssue {
  code: string;
  page?: string;
  message: string;
}

export interface WikiValidation {
  ok: boolean;
  issues: WikiValidationIssue[];
  pages: string[];
}

export function derivedIndexPaths(pages: readonly string[]): string[] {
  const directories = new Set<string>([""]);
  for (const page of pages) {
    let directory = path.posix.dirname(page);
    while (directory && directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories]
    .map((directory) => directory ? `${directory}/index.md` : "index.md")
    .sort();
}

async function scanWikiTree(wikiRoot: string, relative = ""): Promise<{ markdown: string[]; issues: WikiValidationIssue[] }> {
  const markdown: string[] = [];
  const issues: WikiValidationIssue[] = [];
  const directory = relative ? path.join(wikiRoot, ...relative.split("/")) : wikiRoot;
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      issues.push({ code: "wiki-safety", page: child, message: `Wiki tree must not contain symbolic links: ${child}` });
    } else if (entry.isDirectory()) {
      const nested = await scanWikiTree(wikiRoot, child);
      markdown.push(...nested.markdown);
      issues.push(...nested.issues);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".md")) markdown.push(child);
    } else {
      issues.push({ code: "wiki-safety", page: child, message: `Wiki tree contains a non-regular entry: ${child}` });
    }
  }
  return { markdown: markdown.sort(), issues };
}

export function safeWikiPath(wikiRoot: string, relative: string): string {
  if (!relative || relative.includes("\\") || relative.startsWith("/")) throw new Error(`Unsafe Wiki path: ${relative}`);
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === "." || normalized.startsWith("../")) throw new Error(`Unsafe Wiki path: ${relative}`);
  const absolute = inside(wikiRoot, path.resolve(wikiRoot, ...relative.split("/")));
  if (absolute === path.resolve(wikiRoot)) throw new Error("Refusing to operate on the Wiki root directory");
  return absolute;
}

export async function validateWikiTree(
  wikiRoot: string,
  sourceRoots: ReadonlyMap<string, string>,
  pack?: WikiTemplatePack,
): Promise<WikiValidation> {
  const issues: WikiValidationIssue[] = [];
  let tree;
  try {
    tree = await scanWikiTree(wikiRoot);
  } catch (error) {
    throw new WikiValidationInfrastructureError(errorMessage(error), { cause: error });
  }
  issues.push(...tree.issues);
  const pages: string[] = [];
  const loaded: Array<{ relative: string; filename: string; parsed: { frontmatter: Record<string, unknown>; body: string } }> = [];
  const byFile = new Map((pack?.templates ?? []).map((template) => [template.file, template]));
  for (const relative of tree.markdown) {
    const filename = relative.split("/").at(-1) ?? "";
    if (isReservedWikiPagePath(relative)) continue;
    if (!isSafeWikiPagePath(relative)) {
      issues.push({ code: "path", page: relative, message: `Illegal Wiki page path: ${relative}` });
      continue;
    }
    pages.push(relative);
    try {
      loaded.push({ relative, filename, parsed: parsePage(await readText(safeWikiPath(wikiRoot, relative))) });
    } catch (error) {
      issues.push({ code: "frontmatter", page: relative, message: errorMessage(error) });
    }
  }
  for (const page of loaded) {
    const template = byFile.get(page.filename);
    if (pack) issues.push(...templatePlacementIssues(page.relative, template, sourceRoots));
    issues.push(...pageContractIssues(page.relative, page.filename, page.parsed, template, pack, sourceRoots));
    for (const target of wikiLinkTargets(page.relative, page.parsed.body)) {
      if (!wikiTargetExists(target, pages)) {
        issues.push({ code: "link", page: page.relative, message: `Wiki link missing ${target}` });
      }
    }
  }
  if (pack) issues.push(...topologyIssues(pages, sourceRoots, pack));
  return { ok: issues.length === 0, issues, pages: pages.sort() };
}

function pageContractIssues(
  relative: string,
  filename: string,
  parsed: { frontmatter: Record<string, unknown>; body: string },
  template: WikiTemplate | undefined,
  pack: WikiTemplatePack | undefined,
  sourceRoots: ReadonlyMap<string, string>,
): WikiValidationIssue[] {
  const issues: WikiValidationIssue[] = [];
  const type = typeof parsed.frontmatter.type === "string" ? parsed.frontmatter.type.trim() : "";
  if (!type) issues.push({ code: "okf", page: relative, message: "OKF documents require a non-empty type" });
  if (pack) {
    const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title.trim() : "";
    const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description.trim() : "";
    if (!title) issues.push({ code: "okf", page: relative, message: "OKF documents require a title" });
    if (!description) issues.push({ code: "okf", page: relative, message: "OKF documents require a description" });
    if (template && type && type !== template.type) {
      issues.push({ code: "okf", page: relative, message: `${filename} type must be ${template.type}` });
    }
    for (const key of HOST_PAGE_KEYS) {
      if (key in parsed.frontmatter) {
        issues.push({ code: "okf", page: relative, message: `${key} is a template-pack field and must not appear on pages` });
      }
    }
    if (parsed.frontmatter.sources === undefined) {
      issues.push({ code: "citation", page: relative, message: "sources is required" });
    }
    if (template) issues.push(...markdownContractIssues(relative, parsed, template, title, description));
  }
  if (template?.diagram?.length) issues.push(...mermaidIssues(relative, parsed.body, template));
  const citations = extractOkfSources(parsed.frontmatter, parsed.body, (citation) => sourceFileLines(sourceRoots, citation));
  for (const invalid of citations.invalid) {
    issues.push({ code: "citation", page: relative, message: invalid });
  }
  return issues;
}

function templatePlacementIssues(
  relative: string,
  template: WikiTemplate | undefined,
  sourceRoots: ReadonlyMap<string, string>,
): WikiValidationIssue[] {
  if (!template) {
    return [{ code: "template", page: relative, message: "Page filename is not declared by the Wiki template pack" }];
  }
  const segments = relative.split("/");
  const issues: WikiValidationIssue[] = [];
  if (segments.length !== SCOPE_DEPTH[template.scope]) {
    issues.push({
      code: "template",
      page: relative,
      message: `${template.file} has ${template.scope} scope and must be at depth ${SCOPE_DEPTH[template.scope]}`,
    });
  }
  if (template.scope !== "wiki" && segments[0] && !sourceRoots.has(segments[0])) {
    issues.push({ code: "template", page: relative, message: `Unknown Source directory ${segments[0]}` });
  }
  return issues;
}

function markdownContractIssues(
  relative: string,
  parsed: { frontmatter: Record<string, unknown>; body: string },
  template: WikiTemplate,
  title: string,
  description: string,
): WikiValidationIssue[] {
  const structure = markdownStructure(parsed.body);
  const issues: WikiValidationIssue[] = [];
  const h1 = structure.headings.filter((heading) => heading.level === 1);
  if (h1.length !== 1) {
    issues.push({ code: "markdown", page: relative, message: "Page must have exactly one H1" });
  } else if (title && h1[0]?.title !== title) {
    issues.push({ code: "markdown", page: relative, message: "H1 must equal frontmatter title" });
  }
  if (description && structure.summary !== description) {
    issues.push({ code: "markdown", page: relative, message: "Summary below H1 must equal frontmatter description" });
  }
  const actualSections = structure.sections.map((section) => section.title);
  if (actualSections.length !== template.sections.length
    || actualSections.some((section, index) => section !== template.sections[index])) {
    issues.push({
      code: "markdown",
      page: relative,
      message: `H2 sections must be exactly: ${template.sections.join(" | ")}`,
    });
  }
  for (const section of structure.sections) {
    if (template.sections.includes(section.title) && !sectionHasContent(section)) {
      issues.push({ code: "markdown", page: relative, message: `H2 section is empty: ${section.title}` });
    }
  }
  if (structure.placeholders.length) {
    issues.push({
      code: "markdown",
      page: relative,
      message: `Unresolved template placeholder: ${structure.placeholders[0]}`,
    });
  }
  return issues;
}

function sourceFileLines(
  sourceRoots: ReadonlyMap<string, string>,
  citation: Omit<SourceCitation, "id">,
): number | "missing" | undefined {
  const root = sourceRoots.get(citation.scope);
  if (!root) return "missing";
  try {
    return readFileSync(path.join(root, ...citation.path.split("/")), "utf8").split(/\r?\n/).length;
  } catch {
    return "missing";
  }
}

export async function assertReviewPass(candidateRoot: string, handoffsRoot: string): Promise<{ ok: boolean; message: string }> {
  let names: string[] = [];
  try {
    names = await readdir(handoffsRoot);
  } catch {
    return { ok: false, message: "Review is required before publish" };
  }
  let latest: { file: string; mtime: number } | undefined;
  for (const name of names) {
    if (!name.startsWith("review-") || !name.endsWith(".md")) continue;
    const location = path.join(handoffsRoot, name);
    const text = await readFile(location, "utf8");
    if (!/^verdict:\s*pass\s*$/m.test(text)) continue;
    const mtime = (await stat(location)).mtimeMs;
    if (!latest || mtime > latest.mtime) latest = { file: name, mtime };
  }
  if (!latest) return { ok: false, message: "Review is required before publish" };
  const tree = await scanWikiTree(candidateRoot);
  for (const page of tree.markdown) {
    const filename = page.split("/").at(-1) ?? "";
    if (filename === "index.md" || filename === "log.md") continue;
    const mtime = (await stat(path.join(candidateRoot, ...page.split("/")))).mtimeMs;
    if (mtime > latest.mtime) {
      return { ok: false, message: "Review is stale; Candidate pages changed after the last pass" };
    }
  }
  return { ok: true, message: latest.file };
}

function wikiTargetExists(target: string, pages: readonly string[]): boolean {
  if (pages.includes(target)) return true;
  if (target === "index.md" || target.endsWith("/index.md")) {
    const directory = target === "index.md" ? "" : target.slice(0, -"/index.md".length);
    return pages.some((page) => directory === "" || page.startsWith(`${directory}/`));
  }
  return false;
}

function mermaidIssues(page: string, body: string, template: WikiTemplate): WikiValidationIssue[] {
  const allowed = template.diagram ?? [];
  if (!allowed.length) return [];
  const match = MERMAID_KIND.exec(body);
  if (!match) {
    return [{ code: "mermaid", page, message: `${template.file} requires a mermaid diagram` }];
  }
  const kind = match[1] ?? "";
  if (!allowed.includes(kind)) {
    return [{
      code: "mermaid",
      page,
      message: `${template.file} mermaid must be ${allowed.join(" or ")}, not ${kind}`,
    }];
  }
  return [];
}

function topologyIssues(
  pages: readonly string[],
  sourceRoots: ReadonlyMap<string, string>,
  pack: WikiTemplatePack,
): WikiValidationIssue[] {
  const issues: WikiValidationIssue[] = [];
  const present = new Set(pages);
  const required = (scope: WikiTemplate["scope"]) => [anchorTemplate(pack, scope)];
  const domainFiles = new Set(pack.templates.filter((template) => template.scope === "domain").map((template) => template.file));
  const conceptFiles = new Set(pack.templates.filter((template) => template.scope === "concept").map((template) => template.file));
  const conceptDirs = [...new Set(
    pages
      .filter((page) => conceptFiles.has(page.split("/").at(-1) ?? ""))
      .map((page) => path.posix.dirname(page))
      .filter((directory) => directory.split("/").length === 3),
  )].sort();
  for (const template of required("wiki")) {
    if (!present.has(template.file)) {
      issues.push({ code: "topology", page: template.file, message: `Required template ${template.file} is missing` });
    }
  }
  for (const source of [...sourceRoots.keys()].sort()) {
    for (const template of required("source")) {
      const page = `${source}/${template.file}`;
      if (!present.has(page)) {
        issues.push({ code: "topology", page, message: `Required template ${template.file} is missing` });
      }
    }
  }
  if (required("concept").length && !conceptDirs.length) {
    issues.push({ code: "topology", message: "Wiki requires at least one concept cluster" });
  }
  const domainDirs = [...new Set([
    ...conceptDirs.map((directory) => path.posix.dirname(directory)),
    ...pages
      .filter((page) => domainFiles.has(page.split("/").at(-1) ?? ""))
      .map((page) => path.posix.dirname(page))
      .filter((directory) => directory.split("/").length === 2),
  ])].sort();
  for (const directory of domainDirs) {
    for (const template of required("domain")) {
      const page = `${directory}/${template.file}`;
      if (!present.has(page)) {
        issues.push({ code: "topology", page, message: `Required template ${template.file} is missing` });
      }
    }
  }
  for (const directory of conceptDirs) {
    for (const template of required("concept")) {
      const page = `${directory}/${template.file}`;
      if (!present.has(page)) {
        issues.push({ code: "topology", page, message: `Required template ${template.file} is missing` });
      }
    }
  }
  return issues;
}

export async function materializeWikiIndexes(
  wikiRoot: string,
  language: "zh" | "en",
  pack: WikiTemplatePack,
): Promise<string[]> {
  const tree = await scanWikiTree(wikiRoot);
  const pages = tree.markdown.filter((page) => !isReservedWikiPagePath(page) && isSafeWikiPagePath(page));
  const indexes = derivedIndexPaths(pages);
  const written: string[] = [];
  for (const indexPath of indexes) {
    const content = await renderIndex(wikiRoot, indexPath, pages, language, pack);
    const absolute = indexPath === "index.md" ? path.join(wikiRoot, "index.md") : safeWikiPath(wikiRoot, indexPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeText(absolute, content);
    written.push(indexPath);
  }
  return written;
}

export async function stampPublication(
  wikiRoot: string,
  at: string,
  options: { reviewed?: boolean; language?: "zh" | "en" } = {},
): Promise<void> {
  const tree = await scanWikiTree(wikiRoot);
  const pages = tree.markdown.filter((page) => !isReservedWikiPagePath(page) && isSafeWikiPagePath(page));
  for (const relative of tree.markdown) {
    if (isReservedWikiPagePath(relative) && relative !== "index.md") continue;
    const absolute = relative === "index.md" ? path.join(wikiRoot, "index.md") : safeWikiPath(wikiRoot, relative);
    let raw;
    try {
      raw = await readText(absolute);
    } catch {
      continue;
    }
    if (relative === "index.md") {
      if (!raw.includes("okf_version:")) {
        await writeText(absolute, `---\nokf_version: "0.2"\n---\n\n${raw.replace(/^---\n[\s\S]*?\n---\n*/, "")}`);
      }
      continue;
    }
    if (isReservedWikiPagePath(relative)) continue;
    try {
      const parsed = parsePage(raw);
      parsed.frontmatter.generated = { by: GENERATED_BY, at };
      parsed.frontmatter.status = "stable";
      if (options.reviewed) parsed.frontmatter.verified = { by: VERIFIED_BY, at };
      else delete parsed.frontmatter.verified;
      await writeText(absolute, stringifyPage(parsed));
    } catch {
      // leave unreadable files for validate to report
    }
  }
  const day = at.slice(0, 10);
  const language = options.language ?? "en";
  const count = pages.length;
  const creation = language === "zh" ? `发布 ${count} 页。` : `Published ${count} pages.`;
  await writeText(path.join(wikiRoot, "log.md"), `# Directory Update Log\n\n## ${day}\n* **Creation**: ${creation}\n`);
}

async function renderIndex(
  wikiRoot: string,
  indexPath: string,
  pages: readonly string[],
  language: "zh" | "en",
  pack: WikiTemplatePack,
): Promise<string> {
  const relativeDirectory = path.posix.dirname(indexPath) === "." ? "" : path.posix.dirname(indexPath);
  const directPages = pages
    .filter((page) => (path.posix.dirname(page) === "." ? "" : path.posix.dirname(page)) === relativeDirectory)
    .sort();
  const childDirs = [...new Set(
    derivedIndexPaths(pages)
      .filter((candidate) => candidate !== indexPath)
      .map((candidate) => path.posix.dirname(candidate) === "." ? "" : path.posix.dirname(candidate))
      .filter((directory) => directory && (path.posix.dirname(directory) === "." ? "" : path.posix.dirname(directory)) === relativeDirectory),
  )].sort();
  const anchor = anchorTemplate(pack, directoryScope(relativeDirectory));
  const anchorPath = relativeDirectory ? `${relativeDirectory}/${anchor.file}` : anchor.file;
  const identity = await pageIdentity(wikiRoot, anchorPath);
  const title = identity.title;
  const intro = language === "zh"
    ? "从本页开始，按描述打开子目录或页面，不要一次读完整包。"
    : "Start here. Open a child index or page from the descriptions; do not ingest the whole bundle.";
  const lines = indexPath === "index.md"
    ? ["---", 'okf_version: "0.2"', "---", "", `# ${title}`, "", identity.description, "", intro, ""]
    : [`# ${title}`, "", identity.description, ""];
  if (childDirs.length) {
    lines.push(language === "zh" ? "## 目录" : "## Directories", "");
    for (const child of childDirs) {
      const name = path.posix.basename(child);
      const childAnchor = anchorTemplate(pack, directoryScope(child));
      const childIdentity = await pageIdentity(wikiRoot, `${child}/${childAnchor.file}`);
      lines.push(`* [${childIdentity.title}](./${name}/index.md) - ${childIdentity.description}`);
    }
    lines.push("");
  }
  if (directPages.length) {
    lines.push(language === "zh" ? "## 页面" : "## Pages", "");
    for (const page of directPages) {
      const name = path.posix.basename(page);
      const pageInfo = await pageIdentity(wikiRoot, page);
      lines.push(`* [${pageInfo.title}](./${name}) - ${pageInfo.description}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function directoryScope(directory: string): WikiTemplateScope {
  const depth = directory ? directory.split("/").length : 0;
  if (depth === 0) return "wiki";
  if (depth === 1) return "source";
  if (depth === 2) return "domain";
  if (depth === 3) return "concept";
  throw new Error(`Wiki index directory is deeper than the template topology: ${directory}`);
}

async function pageIdentity(wikiRoot: string, relative: string): Promise<{ title: string; description: string }> {
  const parsed = parsePage(await readText(safeWikiPath(wikiRoot, relative)));
  const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title.trim() : "";
  const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description.trim() : "";
  if (!title || !description) throw new Error(`${relative} cannot identify its index entry`);
  return { title, description };
}

export function formatIssue(issue: WikiValidationIssue): string {
  return issue.page ? `${issue.page}: ${issue.message}` : issue.message;
}
