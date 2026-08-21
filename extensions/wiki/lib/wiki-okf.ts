import { readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { extractOkfSources, wikiLinkTargets, type SourceCitation } from "./citations.js";
import { HOST_PAGE_KEYS } from "./templates.js";
import { WikiValidationInfrastructureError, errorMessage } from "./failures.js";
import { inside, readText, writeText } from "./files.js";
import { parsePage, stringifyPage } from "./frontmatter.js";
import { markdownStructure, sectionHasContent } from "./markdown-structure.js";
import { isReservedWikiPagePath, isSafeWikiPagePath, wikiPathKind, isImplicitPinPath, REPO_STRIP } from "./path.js";
import { anchorTemplate, type WikiTemplate, type WikiTemplatePack } from "./templates.js";
import { candidateRevision, fileRevision } from "./revisions.js";

export const GENERATED_BY = "open-okf-wiki/1.0.0";
export const VERIFIED_BY = "process:open-okf-wiki-review";

const MERMAID_KIND = /```mermaid[^\n]*\r?\n\s*([A-Za-z][A-Za-z0-9-]*)/;
const MERMAID_FENCE = /```mermaid[^\n]*\r?\n([\s\S]*?)```/;
const INLINE_FOOTNOTE = /\[\^([^\]]+)\]/;
const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]:/;

export interface WikiPin {
  scopeId: string;
  logicalPath: string;
  realPath: string;
}

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

export function wikiPinsImplicit(pins: readonly WikiPin[]): boolean {
  return pins.length === 1 && isImplicitPinPath(pins[0]?.logicalPath ?? "");
}

function sourceRootsFromPins(pins: readonly WikiPin[]): Map<string, string> {
  return new Map(pins.map((pin) => [pin.scopeId, pin.realPath]));
}

function architectureFile(pack: WikiTemplatePack): string {
  return pack.templates.find((template) => template.altitudes)?.file ?? "architecture.md";
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
  pins: readonly WikiPin[] = [],
  pack?: WikiTemplatePack,
): Promise<WikiValidation> {
  const issues: WikiValidationIssue[] = [];
  const sourceRoots = sourceRootsFromPins(pins);
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
    if (pack) issues.push(...templatePlacementIssues(page.relative, template, pins));
    issues.push(...pageContractIssues(page.relative, page.filename, page.parsed, template, pack, sourceRoots));
    for (const target of wikiLinkTargets(page.relative, page.parsed.body)) {
      if (!wikiTargetExists(target, pages)) {
        issues.push({ code: "link", page: page.relative, message: `Wiki link missing ${target}` });
      }
    }
  }
  if (pack) issues.push(...topologyIssues(pages, pins, pack));
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
  pins: readonly WikiPin[],
): WikiValidationIssue[] {
  if (!template) {
    return [{ code: "template", page: relative, message: "Page filename is not declared by the Wiki template pack" }];
  }
  if (!placementAllowed(relative, template, pins)) {
    return [{ code: "template", page: relative, message: `${template.file} is not allowed at ${relative}` }];
  }
  return [];
}

function placementAllowed(relative: string, template: WikiTemplate, pins: readonly WikiPin[]): boolean {
  const kind = wikiPathKind(relative);
  if (!kind) return false;
  const implicit = wikiPinsImplicit(pins);
  const pinIds = new Set(pins.map((pin) => pin.scopeId));
  const repoId = relative.split("/")[1];
  if (template.altitudes) {
    if (kind === "root") return template.altitudes.includes("wiki");
    return !implicit && kind === "repo" && template.altitudes.includes("repo") && pinIds.has(repoId!);
  }
  if (template.scope === "wiki") return kind === "root";
  if (template.scope === "repo") {
    if (implicit) return kind === "root";
    return kind === "repo" && pinIds.has(repoId!);
  }
  if (template.scope === "domain") return kind === "domain";
  if (template.scope === "concept") return kind === "concept";
  return false;
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
  const diagram = new Set(template.diagramSections);
  for (const section of structure.sections) {
    if (template.sections.includes(section.title) && !sectionHasContent(section)) {
      issues.push({ code: "markdown", page: relative, message: `H2 section is empty: ${section.title}` });
    }
    if (template.sections.includes(section.title) && !diagram.has(section.title) && !sectionCitesSource(section)) {
      issues.push({ code: "markdown", page: relative, message: `H2 section is missing a sources footnote: ${section.title}` });
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

function sectionCitesSource(section: { lines: string[] }): boolean {
  return section.lines.some((line) => INLINE_FOOTNOTE.test(line) && !FOOTNOTE_DEFINITION.test(line.trim()));
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

export interface WikiReviewAttestation {
  verdict: "pass" | "changes_requested";
  candidateRevision: string;
  handoffPath: string;
  handoffRevision: string;
}

export async function assertReviewPass(
  candidateRoot: string,
  review?: WikiReviewAttestation,
): Promise<{ ok: boolean; message: string }> {
  if (!review || review.verdict !== "pass") return { ok: false, message: "Review is required before publish" };
  const current = await candidateRevision(candidateRoot);
  if (current.digest !== review.candidateRevision) {
    return { ok: false, message: "Review is stale; Candidate content changed after the last pass" };
  }
  try {
    if (await fileRevision(review.handoffPath) !== review.handoffRevision) {
      return { ok: false, message: "Review handoff changed after attestation" };
    }
  } catch {
    return { ok: false, message: "Review handoff is missing" };
  }
  return { ok: true, message: path.basename(review.handoffPath) };
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
  const inner = MERMAID_FENCE.exec(body)?.[1] ?? "";
  const content = inner.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return Boolean(trimmed) && !trimmed.startsWith("%%");
  });
  if (!content) {
    return [{ code: "mermaid", page, message: `${template.file} mermaid fence is empty` }];
  }
  return [];
}

function topologyIssues(
  pages: readonly string[],
  pins: readonly WikiPin[],
  pack: WikiTemplatePack,
): WikiValidationIssue[] {
  const issues: WikiValidationIssue[] = [];
  const present = new Set(pages);
  const implicit = wikiPinsImplicit(pins);
  const overview = anchorTemplate(pack, "wiki").file;
  if (!present.has(overview)) {
    issues.push({ code: "topology", page: overview, message: `Required template ${overview} is missing` });
  }
  const architecture = architectureFile(pack);
  if (!present.has(architecture)) {
    issues.push({ code: "topology", page: architecture, message: `Required template ${architecture} is missing` });
  }
  if (implicit) {
    if (pages.some((page) => page === REPO_STRIP || page.startsWith(`${REPO_STRIP}/`))) {
      issues.push({ code: "topology", message: "Implicit Workspace Wiki must not contain repos/" });
    }
  } else {
    for (const pin of [...pins].sort((left, right) => left.scopeId.localeCompare(right.scopeId))) {
      const page = `${REPO_STRIP}/${pin.scopeId}/${architecture}`;
      if (!present.has(page)) {
        issues.push({ code: "topology", page, message: `Required template ${architecture} is missing` });
      }
    }
  }
  const pinIds = new Set(pins.map((pin) => pin.scopeId.toLowerCase()));
  const domainFiles = new Set(pack.templates.filter((template) => template.scope === "domain").map((template) => template.file));
  const conceptFiles = new Set(pack.templates.filter((template) => template.scope === "concept").map((template) => template.file));
  const conceptDirs = [...new Set(
    pages
      .filter((page) => conceptFiles.has(page.split("/").at(-1) ?? ""))
      .map((page) => path.posix.dirname(page))
      .filter((directory) => directory.split("/").length === 2 && !directory.startsWith(`${REPO_STRIP}/`)),
  )].sort();
  if (!conceptDirs.length) {
    issues.push({ code: "topology", message: "Wiki requires at least one concept cluster" });
  }
  const domainDirs = [...new Set([
    ...conceptDirs.map((directory) => path.posix.dirname(directory)),
    ...pages
      .filter((page) => domainFiles.has(page.split("/").at(-1) ?? ""))
      .map((page) => path.posix.dirname(page))
      .filter((directory) => directory.split("/").length === 1 && directory !== REPO_STRIP),
  ])].sort();
  for (const directory of domainDirs) {
    if (pinIds.has(directory.toLowerCase())) {
      issues.push({ code: "topology", page: `${directory}/domain.md`, message: `Domain slug collides with Source ${directory}` });
    }
    const page = `${directory}/${anchorTemplate(pack, "domain").file}`;
    if (!present.has(page)) {
      issues.push({ code: "topology", page, message: `Required template ${anchorTemplate(pack, "domain").file} is missing` });
    }
  }
  for (const directory of conceptDirs) {
    const page = `${directory}/${anchorTemplate(pack, "concept").file}`;
    if (!present.has(page)) {
      issues.push({ code: "topology", page, message: `Required template ${anchorTemplate(pack, "concept").file} is missing` });
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
    const absolute = safeWikiPath(wikiRoot, indexPath);
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
    const absolute = safeWikiPath(wikiRoot, relative);
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

type WikiDirectoryKind = "wiki" | "repos-root" | "repo" | "domain" | "concept";

function classifyWikiDirectory(directory: string): WikiDirectoryKind {
  if (!directory) return "wiki";
  const parts = directory.split("/");
  if (parts[0] === REPO_STRIP) {
    if (parts.length === 1) return "repos-root";
    if (parts.length === 2) return "repo";
  }
  if (parts.length === 1) return "domain";
  if (parts.length === 2) return "concept";
  throw new Error(`Wiki index directory is deeper than the template topology: ${directory}`);
}

async function renderIndex(
  wikiRoot: string,
  indexPath: string,
  pages: readonly string[],
  language: "zh" | "en",
  pack: WikiTemplatePack,
): Promise<string> {
  const relativeDirectory = path.posix.dirname(indexPath) === "." ? "" : path.posix.dirname(indexPath);
  const kind = classifyWikiDirectory(relativeDirectory);
  const directPages = pages
    .filter((page) => (path.posix.dirname(page) === "." ? "" : path.posix.dirname(page)) === relativeDirectory)
    .sort();
  const childDirs = [...new Set(
    derivedIndexPaths(pages)
      .filter((candidate) => candidate !== indexPath)
      .map((candidate) => path.posix.dirname(candidate) === "." ? "" : path.posix.dirname(candidate))
      .filter((directory) => directory && (path.posix.dirname(directory) === "." ? "" : path.posix.dirname(directory)) === relativeDirectory),
  )].sort();
  const identity = kind === "repos-root"
    ? {
      title: language === "zh" ? "仓库" : "Repositories",
      description: language === "zh"
        ? "每个 Git Source 作为可部署单元的架构与操作页。"
        : "Architecture and operations pages for each Git Source as a deployable.",
    }
    : await pageIdentity(wikiRoot, identityPage(relativeDirectory, kind, pack));
  const intro = language === "zh"
    ? "从本页开始，按描述打开子目录或页面，不要一次读完整包。"
    : "Start here. Open a child index or page from the descriptions; do not ingest the whole bundle.";
  const lines = indexPath === "index.md"
    ? ["---", 'okf_version: "0.2"', "---", "", `# ${identity.title}`, "", identity.description, "", intro, ""]
    : [`# ${identity.title}`, "", identity.description, ""];
  if (indexPath === "index.md") {
    const domainDirs = childDirs.filter((directory) => directory !== REPO_STRIP);
    const uniquePins = [...new Set(
      pages
        .filter((page) => wikiPathKind(page) === "repo" && page.endsWith(`/${architectureFile(pack)}`))
        .map((page) => path.posix.dirname(page)),
    )].sort();
    if (directPages.length) {
      lines.push(language === "zh" ? "## 系统" : "## System", "");
      for (const page of directPages) {
        const pageInfo = await pageIdentity(wikiRoot, page);
        lines.push(`* [${pageInfo.title}](./${path.posix.basename(page)}) - ${pageInfo.description}`);
      }
      lines.push("");
    }
    if (uniquePins.length) {
      lines.push(language === "zh" ? "## 仓库" : "## Repositories", "");
      for (const directory of uniquePins) {
        const childIdentity = await pageIdentity(wikiRoot, `${directory}/${architectureFile(pack)}`);
        lines.push(`* [${childIdentity.title}](./${directory}/index.md) - ${childIdentity.description}`);
      }
      lines.push("");
    }
    if (domainDirs.length) {
      lines.push(language === "zh" ? "## Domain" : "## Domains", "");
      for (const child of domainDirs) {
        const childIdentity = await pageIdentity(wikiRoot, `${child}/${anchorTemplate(pack, "domain").file}`);
        lines.push(`* [${childIdentity.title}](./${path.posix.basename(child)}/index.md) - ${childIdentity.description}`);
      }
      lines.push("");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }
  if (childDirs.length) {
    lines.push(language === "zh" ? "## 目录" : "## Directories", "");
    for (const child of childDirs) {
      const name = path.posix.basename(child);
      const childKind = classifyWikiDirectory(child);
      const childPage = identityPage(child, childKind, pack);
      const childIdentity = childKind === "repos-root"
        ? { title: name, description: language === "zh" ? "仓库" : "Repositories" }
        : await pageIdentity(wikiRoot, childPage);
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

function identityPage(directory: string, kind: WikiDirectoryKind, pack: WikiTemplatePack): string {
  if (kind === "wiki") return anchorTemplate(pack, "wiki").file;
  if (kind === "repo") return `${directory}/${architectureFile(pack)}`;
  if (kind === "domain") return `${directory}/${anchorTemplate(pack, "domain").file}`;
  if (kind === "concept") return `${directory}/${anchorTemplate(pack, "concept").file}`;
  return `${directory}/${architectureFile(pack)}`;
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
