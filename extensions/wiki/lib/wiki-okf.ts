import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { extractOkfSources, resolveSourceCitation, wikiLinkTargets, type SourceCitation } from "./citations.js";
import { HOST_PAGE_KEYS } from "./templates.js";
import { WikiValidationInfrastructureError, errorMessage } from "./failures.js";
import { inside, readText, writeText } from "./files.js";
import { parsePage, stringifyPage } from "./frontmatter.js";
import { markdownStructure, sectionHasContent } from "./markdown-structure.js";
import { isReservedWikiPagePath, isSafeWikiPagePath, wikiPathKind, isImplicitPinPath } from "./path.js";
import {
  altitudeTemplate,
  identityTemplate,
  templateMatchesFilename,
  type WikiTemplate,
  type WikiTemplatePack,
} from "./templates.js";
import { candidateRevision, fileRevision } from "./revisions.js";
import { writeTargetAllows, type WikiWriteTarget } from "./write-target.js";

export const GENERATED_BY = "open-okf-wiki/1.0.0";
export const VERIFIED_BY = "process:open-okf-wiki-review";
const LOCAL_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const MERMAID_KIND = /```mermaid[^\n]*\r?\n\s*([A-Za-z][A-Za-z0-9-]*)/;
const MERMAID_FENCE = /```mermaid[^\n]*\r?\n([\s\S]*?)```/;

export interface WikiPin {
  scopeId: string;
  logicalPath: string;
  realPath: string;
  catalog?: string;
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

export interface WikiValidationOptions {
  /** Named Catalogs available to this validation scope; schemas remain inside their Adapters. */
  catalogs?: ReadonlySet<string>;
}

export function wikiPinsImplicit(pins: readonly WikiPin[]): boolean {
  return pins.length === 1 && isImplicitPinPath(pins[0]?.logicalPath ?? "");
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
    .sort((left, right) => left === "index.md" ? -1 : right === "index.md" ? 1 : left.localeCompare(right));
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
  options: WikiValidationOptions = {},
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
  const resolved: Array<{ relative: string; template: WikiTemplate | undefined }> = [];
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
    const type = typeof page.parsed.frontmatter.type === "string" ? page.parsed.frontmatter.type.trim() : "";
    const typed = pack?.templates.find((candidate) => candidate.type === type && templateMatchesFilename(candidate, page.filename));
    const template = typed ?? pack?.templates.find((candidate) => templateMatchesFilename(candidate, page.filename));
    resolved.push({ relative: page.relative, template });
    if (pack) issues.push(...templatePlacementIssues(page.relative, template, pins));
    issues.push(...pageContractIssues(page.relative, page.filename, page.parsed, template, pack, pins, options));
    issues.push(...repositorySourceOwnershipIssues(page.relative, page.parsed, pins));
    issues.push(...catalogOwnershipIssues(page.relative, page.parsed, pins, options.catalogs));
    if (pack && pins.length > 1 && template === altitudeTemplate(pack, "wiki") && !page.relative.includes("/")) {
      issues.push(...workspaceArchitectureCoverageIssues(page.relative, page.parsed, pins));
    }
    for (const target of wikiLinkTargets(page.relative, page.parsed.body)) {
      if (!wikiTargetExists(target, pages)) {
        issues.push({ code: "link", page: page.relative, message: `Wiki link missing ${target}` });
      }
    }
  }
  if (pack) issues.push(...topologyIssues(pages, resolved, pins, pack));
  return { ok: issues.length === 0, issues, pages: pages.sort() };
}

export async function validateWikiTarget(
  wikiRoot: string,
  target: WikiWriteTarget,
  pins: readonly WikiPin[],
  pack: WikiTemplatePack,
  options: WikiValidationOptions = {},
): Promise<WikiValidation> {
  const full = await validateWikiTree(wikiRoot, pins, pack, options);
  const pages = full.pages.filter((page) => writeTargetAllows(target, page));
  const issues = full.issues.filter((issue) => {
    if (!issue.page || !writeTargetAllows(target, issue.page)) return false;
    if (issue.code !== "link") return true;
    const missing = /^Wiki link missing (.+)$/.exec(issue.message)?.[1];
    return Boolean(missing && writeTargetAllows(target, missing));
  });
  const root = target.path === "wiki-root" ? "" : target.path;
  const directories = target.mode === "directory"
    ? [root]
    : [
      root,
      ...new Set(pages
        .map((page) => path.posix.dirname(page))
        .filter((directory) => directory !== root && path.posix.dirname(directory) === root)),
    ];
  if (target.mode === "subtree" && directories.length === 1) {
    issues.push({ code: "topology", page: `${root}/`, message: "Domain write target requires at least one Concept directory" });
  }
  const present = new Set(pages);
  for (const directory of directories) {
    for (const template of pack.templates.filter((candidate) => candidate.required)) {
      const page = directory ? `${directory}/${template.filename}` : template.filename;
      if (placementAllowed(page, template, pins) && !present.has(page)
        && !issues.some((issue) => issue.code === "topology" && issue.page === page)) {
        issues.push({ code: "topology", page, message: `Required page contract ${template.id} is missing` });
      }
    }
  }
  return { ok: issues.length === 0, issues, pages };
}

function repositorySourceOwnershipIssues(
  relative: string,
  parsed: { frontmatter: Record<string, unknown>; body: string },
  pins: readonly WikiPin[],
): WikiValidationIssue[] {
  if (wikiPinsImplicit(pins)) return [];
  const segments = relative.split("/");
  const owner = segments[0];
  if (!pins.some((pin) => pin.scopeId === owner)) return [];
  const citations = extractOkfSources(parsed.frontmatter, parsed.body).citations;
  const foreign = [...new Set(citations
    .map((citation) => resolveSourceCitation(citation, pins)?.scopeId)
    .filter((scopeId): scopeId is string => Boolean(scopeId) && scopeId !== owner))];
  return foreign.length
    ? [{
      code: "citation-owner",
      page: relative,
      message: `Repository pages under ${owner}/ may cite only Source ${owner}; found ${foreign.join(", ")}`,
    }]
    : [];
}

function catalogOwnershipIssues(
  relative: string,
  parsed: { frontmatter: Record<string, unknown>; body: string },
  pins: readonly WikiPin[],
  catalogs: ReadonlySet<string> | undefined,
): WikiValidationIssue[] {
  const owner = wikiPinsImplicit(pins)
    ? pins[0]
    : pins.find((pin) => relative.startsWith(`${pin.scopeId}/`));
  if (!owner) return [];
  const foreign = [...new Set(extractOkfSources(parsed.frontmatter, parsed.body).citations
    .filter((citation) => citation.catalog && catalogs?.has(citation.catalog) && citation.catalog !== owner.catalog)
    .map((citation) => citation.catalog!))];
  return foreign.length
    ? [{
      code: "citation-owner",
      page: relative,
      message: `Source ${owner.scopeId} pages may cite only Catalog ${owner.catalog ?? "(none)"}; found ${foreign.join(", ")}`,
    }]
    : [];
}

function workspaceArchitectureCoverageIssues(
  relative: string,
  parsed: { frontmatter: Record<string, unknown>; body: string },
  pins: readonly WikiPin[],
): WikiValidationIssue[] {
  const cited = new Set(extractOkfSources(parsed.frontmatter, parsed.body).citations
    .map((citation) => resolveSourceCitation(citation, pins)?.scopeId)
    .filter((scopeId): scopeId is string => Boolean(scopeId)));
  const missing = pins.map((pin) => pin.scopeId).filter((scopeId) => !cited.has(scopeId));
  return missing.length
    ? [{
      code: "cross-source",
      page: relative,
      message: `Workspace architecture must cite every Source after cross-Source analysis; missing ${missing.join(", ")}`,
    }]
    : [];
}

function pageContractIssues(
  relative: string,
  filename: string,
  parsed: { frontmatter: Record<string, unknown>; body: string },
  template: WikiTemplate | undefined,
  pack: WikiTemplatePack | undefined,
  pins: readonly WikiPin[],
  options: WikiValidationOptions = {},
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
  if (template?.diagram) issues.push(...mermaidIssues(relative, parsed.body, template));
  const citations = extractOkfSources(parsed.frontmatter, parsed.body, (citation) => sourceFileLines(pins, citation));
  for (const invalid of citations.invalid) {
    issues.push({ code: "citation", page: relative, message: invalid });
  }
  for (const citation of citations.citations) {
    if (!citation.catalogTable) continue;
    if (!citation.catalog || !options.catalogs?.has(citation.catalog)) {
      issues.push({
        code: "citation",
        page: relative,
        message: `${citation.path} cites an unavailable Catalog`,
      });
    }
  }
  return issues;
}

function templatePlacementIssues(
  relative: string,
  template: WikiTemplate | undefined,
  pins: readonly WikiPin[],
): WikiValidationIssue[] {
  if (!template) {
    return [{ code: "template", page: relative, message: "No page contract matches this filename and type" }];
  }
  if (!placementAllowed(relative, template, pins)) {
    return [{ code: "template", page: relative, message: `${template.id} is not allowed at ${relative}` }];
  }
  return [];
}

function placementAllowed(relative: string, template: WikiTemplate, pins: readonly WikiPin[]): boolean {
  const implicit = wikiPinsImplicit(pins);
  const repositoryIds = implicit ? new Set<string>() : new Set(pins.map((pin) => pin.scopeId));
  const kind = wikiPathKind(relative, repositoryIds);
  if (!kind) return false;
  const segments = relative.split("/");
  const repoId = repositoryIds.has(segments[0]!) ? segments[0] : undefined;
  const inDeclaredRepo = !implicit && repoId !== undefined;
  if (template.altitudes) {
    if (kind === "root") return template.altitudes.includes("wiki");
    return kind === "repo" && template.altitudes.includes("repo") && inDeclaredRepo;
  }
  if (template.scope === "wiki") return kind === "root";
  if (template.scope === "repo") {
    if (implicit) return kind === "root";
    return kind === "repo" && inDeclaredRepo;
  }
  if (template.scope === "domain") {
    return kind === "domain" && (implicit ? repoId === undefined : inDeclaredRepo);
  }
  if (template.scope === "concept") {
    return kind === "concept" && (implicit ? repoId === undefined : inDeclaredRepo);
  }
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
  const expectedSections = template.sections.map((section) => section.title);
  const actualSections = structure.sections.map((section) => section.title);
  if (actualSections.length !== expectedSections.length
    || actualSections.some((section, index) => section !== expectedSections[index])) {
    issues.push({
      code: "markdown",
      page: relative,
      message: `H2 sections must be exactly: ${expectedSections.join(" | ")}`,
    });
  }
  for (const section of structure.sections) {
    if (expectedSections.includes(section.title) && !sectionHasContent(section)) {
      issues.push({ code: "markdown", page: relative, message: `H2 section is empty: ${section.title}` });
    }
  }
  for (const placeholder of structure.placeholders) {
    issues.push({
      code: "markdown",
      page: relative,
      message: `Unresolved template placeholder: ${placeholder}`,
    });
  }
  return issues;
}

function sourceFileLines(
  pins: readonly WikiPin[],
  citation: Omit<SourceCitation, "id">,
): number | "missing" | undefined {
  const resolved = resolveSourceCitation(citation, pins);
  if (!resolved) return "missing";
  const pin = pins.find((candidate) => candidate.scopeId === resolved.scopeId);
  if (!pin) return "missing";
  try {
    const file = path.join(pin.realPath, ...resolved.sourcePath.split("/"));
    if (lstatSync(file).isSymbolicLink()) return "missing";
    const actual = realpathSync(file);
    const relative = path.relative(realpathSync(pin.realPath), actual);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return "missing";
    return readFileSync(actual, "utf8").split(/\r?\n/).length;
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
  const allowed = template.diagram?.kinds ?? [];
  if (!allowed.length) return [];
  const sectionName = template.diagram!.section;
  const section = markdownStructure(body).sections.find((candidate) => candidate.title === sectionName);
  const sectionBody = section?.lines.join("\n") ?? "";
  const match = MERMAID_KIND.exec(sectionBody);
  if (!match) {
    return [{ code: "mermaid", page, message: `${template.id} requires a Mermaid diagram under ${sectionName}` }];
  }
  const kind = match[1] ?? "";
  if (!allowed.includes(kind)) {
    return [{
      code: "mermaid",
      page,
      message: `${template.id} mermaid must be ${allowed.join(" or ")}, not ${kind}`,
    }];
  }
  const inner = MERMAID_FENCE.exec(sectionBody)?.[1] ?? "";
  const content = inner.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return Boolean(trimmed) && !trimmed.startsWith("%%");
  });
  if (!content) {
    return [{ code: "mermaid", page, message: `${template.id} mermaid fence is empty` }];
  }
  return [];
}

function topologyIssues(
  pages: readonly string[],
  resolved: readonly { relative: string; template: WikiTemplate | undefined }[],
  pins: readonly WikiPin[],
  pack: WikiTemplatePack,
): WikiValidationIssue[] {
  const issues: WikiValidationIssue[] = [];
  const present = new Set(pages);
  const implicit = wikiPinsImplicit(pins);
  const repositoryIds = implicit ? new Set<string>() : new Set(pins.map((pin) => pin.scopeId));
  const conceptDirs = [...new Set(
    resolved
      .filter(({ template }) => template?.scope === "concept")
      .map(({ relative }) => path.posix.dirname(relative))
      .filter((directory) => wikiPathKind(`${directory}/page.md`, repositoryIds) === "concept"),
  )].sort();
  if (!conceptDirs.length) {
    issues.push({ code: "topology", message: "Wiki requires at least one concept cluster" });
  }
  const domainDirs = [...new Set([
    ...conceptDirs.map((directory) => path.posix.dirname(directory)),
    ...resolved
      .filter(({ template }) => template?.scope === "domain")
      .map(({ relative }) => path.posix.dirname(relative))
      .filter((directory) => wikiPathKind(`${directory}/page.md`, repositoryIds) === "domain"),
  ])].sort();
  const directories = [
    "",
    ...(!implicit ? [...repositoryIds].sort() : []),
    ...domainDirs,
    ...conceptDirs,
  ];
  for (const directory of directories) {
    for (const template of pack.templates.filter((candidate) => candidate.required)) {
      const page = directory ? `${directory}/${template.filename}` : template.filename;
      if (placementAllowed(page, template, pins) && !present.has(page)) {
        issues.push({ code: "topology", page, message: `Required page contract ${template.id} is missing` });
      }
    }
  }
  return issues;
}

export async function materializeWikiIndexes(
  wikiRoot: string,
  language: "zh" | "en",
  pack: WikiTemplatePack,
  pins: readonly WikiPin[] = [],
): Promise<string[]> {
  const tree = await scanWikiTree(wikiRoot);
  const pages = tree.markdown.filter((page) => !isReservedWikiPagePath(page) && isSafeWikiPagePath(page));
  const indexes = derivedIndexPaths(pages);
  const repositoryIds = wikiPinsImplicit(pins) ? new Set<string>() : new Set(pins.map((pin) => pin.scopeId));
  const written: string[] = [];
  for (const indexPath of indexes) {
    const content = await renderIndex(wikiRoot, indexPath, pages, language, pack, repositoryIds);
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
  const timestamp = Date.parse(at);
  const day = Number.isFinite(timestamp) ? LOCAL_DATE.format(timestamp) : at;
  const language = options.language ?? "en";
  const count = pages.length;
  const creation = language === "zh" ? `发布 ${count} 页。` : `Published ${count} pages.`;
  await writeText(path.join(wikiRoot, "log.md"), `# Directory Update Log\n\n## ${day}\n* **Creation**: ${creation}\n`);
}

type WikiDirectoryKind = "wiki" | "repo" | "domain" | "concept";

function classifyWikiDirectory(directory: string, repositoryIds: ReadonlySet<string>): WikiDirectoryKind {
  if (!directory) return "wiki";
  const kind = wikiPathKind(`${directory}/page.md`, repositoryIds);
  if (kind && kind !== "root") return kind;
  throw new Error(`Wiki index directory is deeper than the template topology: ${directory}`);
}

async function renderIndex(
  wikiRoot: string,
  indexPath: string,
  pages: readonly string[],
  language: "zh" | "en",
  pack: WikiTemplatePack,
  repositoryIds: ReadonlySet<string>,
): Promise<string> {
  const relativeDirectory = path.posix.dirname(indexPath) === "." ? "" : path.posix.dirname(indexPath);
  const kind = classifyWikiDirectory(relativeDirectory, repositoryIds);
  const identityPath = identityPage(relativeDirectory, kind, pack);
  const directPages = pages
    .filter((page) => (path.posix.dirname(page) === "." ? "" : path.posix.dirname(page)) === relativeDirectory)
    .filter((page) => page !== identityPath)
    .sort();
  const childDirs = [...new Set(
    derivedIndexPaths(pages)
      .filter((candidate) => candidate !== indexPath)
      .map((candidate) => path.posix.dirname(candidate) === "." ? "" : path.posix.dirname(candidate))
      .filter((directory) => directory && (path.posix.dirname(directory) === "." ? "" : path.posix.dirname(directory)) === relativeDirectory),
  )].sort();
  const identity = await pageIdentity(wikiRoot, identityPath);
  const identityLink = `./${path.posix.basename(identityPath)}`;
  const intro = language === "zh"
    ? "从本页开始，按描述打开子目录或页面，不要一次读完整包。"
    : "Start here. Open a child index or page from the descriptions; do not ingest the whole bundle.";
  const lines = indexPath === "index.md"
    ? ["---", 'okf_version: "0.2"', "---", "", `# [${identity.title}](${identityLink})`, "", identity.description, "", intro, ""]
    : [`# [${identity.title}](${identityLink})`, "", identity.description, ""];
  if (indexPath === "index.md") {
    const domainDirs = childDirs.filter((directory) => !repositoryIds.has(directory));
    const repositoryIdentity = altitudeTemplate(pack, "repo").filename;
    const uniquePins = [...new Set(
      pages
        .filter((page) => wikiPathKind(page, repositoryIds) === "repo" && page.endsWith(`/${repositoryIdentity}`))
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
        const childIdentity = await pageIdentity(wikiRoot, `${directory}/${repositoryIdentity}`);
        lines.push(`* [${childIdentity.title}](./${directory}/index.md) - ${childIdentity.description}`);
      }
      lines.push("");
    }
    if (domainDirs.length) {
      lines.push(language === "zh" ? "## Domain" : "## Domains", "");
      for (const child of domainDirs) {
        const childIdentity = await pageIdentity(wikiRoot, `${child}/${identityTemplate(pack, "domain").filename}`);
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
      const childKind = classifyWikiDirectory(child, repositoryIds);
      const childPage = identityPage(child, childKind, pack);
      const childIdentity = await pageIdentity(wikiRoot, childPage);
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
  if (kind === "wiki") return identityTemplate(pack, "wiki").filename;
  if (kind === "repo") return `${directory}/${identityTemplate(pack, "repo").filename}`;
  if (kind === "domain") return `${directory}/${identityTemplate(pack, "domain").filename}`;
  if (kind === "concept") return `${directory}/${identityTemplate(pack, "concept").filename}`;
  throw new Error(`Unsupported Wiki directory kind: ${kind}`);
}

async function pageIdentity(wikiRoot: string, relative: string): Promise<{ title: string; description: string }> {
  const parsed = parsePage(await readText(safeWikiPath(wikiRoot, relative)));
  const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title.trim() : "";
  const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description.trim() : "";
  if (!title || !description) throw new Error(`${relative} cannot identify its index entry`);
  return { title, description };
}

export function formatIssue(issue: WikiValidationIssue): string {
  const diagnostic = issue.page ? `${issue.page}: ${issue.message}` : issue.message;
  return `${diagnostic}\n  Suggested action: ${issueSuggestion(issue.code)}`;
}

function issueSuggestion(code: string): string {
  switch (code) {
    case "citation": return "Correct sources[].resource or its matching [^id] reference and definition; use a Workspace-relative pinned file path with an optional valid #Lx[-Ly] range.";
    case "citation-owner": return "Replace foreign repository evidence with the owning Source, or move the cross-repository claim to a Workspace-root page.";
    case "cross-source": return "Add evidence from every pinned Source to the Workspace architecture after reading the synthesis handoff and cited files.";
    case "frontmatter": return "Repair the YAML frontmatter so the page can be parsed, preserving only fields allowed by its template.";
    case "link": return "Correct the Wiki-relative target or add the missing declared page.";
    case "markdown": return "Rewrite the page to match the template heading order and required content.";
    case "mermaid": return "Use an allowed Mermaid diagram kind and valid fenced syntax for the required diagram section.";
    case "okf": return "Fill the required OKF metadata with values matching the selected page template.";
    case "path": return "Move or rename the page to a legal path in its repository, domain, or concept partition.";
    case "template": return "Use a filename and placement declared for this page scope by the active template pack.";
    case "topology": return "Add the required anchor page or move/remove the page so the repository/domain/concept tree is complete.";
    case "wiki-safety": return "Remove the unsafe entry and keep the Candidate tree to regular Markdown files and directories.";
    default: return "Inspect the reported page and repair the stated invariant before running the full check again.";
  }
}
