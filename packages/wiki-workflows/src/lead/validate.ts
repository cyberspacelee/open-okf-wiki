import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../failures.js";
import { inside, readText } from "../files.js";
import { okfSources, parsePage, stringifyPage } from "../frontmatter.js";
import { isRecord } from "../util.js";
import { parseSourceCitation, sourceCitationsEqual } from "../citations.js";
import type { ResolvedWikiSource } from "../workspace.js";
import { isReservedWikiPagePath, isSafeWikiPagePath } from "./path.js";
import { wikiSpecPages, wikiSpecPageType, type WikiSpec, type WikiSpecPage } from "./spec.js";
import {
  derivedIndexPaths,
  resolveWikiRoots,
  scanWikiTree,
  specPagePaths,
  validateWikiIndexes,
  type ResolvedWikiRoots,
} from "./indexes.js";

export interface WikiValidationIssue {
  code: string;
  page?: string;
  message: string;
}

export function issue(issues: WikiValidationIssue[], code: string, message: string, page?: string): void {
  issues.push(page ? { code, page, message } : { code, message });
}

export function formatIssue(value: WikiValidationIssue): string {
  return value.page ? `${value.page}: ${value.message}` : value.message;
}

export interface WikiValidation {
  ok: boolean;
  issues: WikiValidationIssue[];
  pages: string[];
  obsoletePages: string[];
}

export interface WikiFinalization {
  pages: string[];
  obsoletePages: string[];
  removedPages: string[];
  rebuiltIndexes: string[];
}

const MERMAID_FLOW_DIRECTIONS = new Set(["TB", "TD", "BT", "RL", "LR"]);
const MERMAID_DIAGRAM_TYPES = new Set(["sequenceDiagram", "classDiagram", "stateDiagram-v2", "erDiagram"]);
export const GENERATED_BY = "open-okf-wiki/1.0.0";
export const VERIFIED_BY = "process:open-okf-wiki";
const PUBLISHER_OWNED_FIELDS = ["okf_version", "generated", "verified", "human", "stale_after"] as const;
const MERMAID_EVENT_HANDLER = /<[^>]+\bon(?:abort|animationcancel|animationend|animationiteration|animationstart|auxclick|beforeinput|beforetoggle|begin|blur|cancel|canplay|canplaythrough|change|click|close|contextmenu|copy|cuechange|cut|dblclick|drag|dragend|dragenter|dragleave|dragover|dragstart|drop|durationchange|emptied|end|ended|error|focus|focusin|focusout|formdata|fullscreenchange|fullscreenerror|gotpointercapture|input|invalid|keydown|keypress|keyup|load|loadeddata|loadedmetadata|loadstart|lostpointercapture|mousedown|mouseenter|mouseleave|mousemove|mouseout|mouseover|mouseup|paste|pause|play|playing|pointercancel|pointerdown|pointerenter|pointerleave|pointermove|pointerout|pointerover|pointerup|progress|ratechange|repeat|reset|resize|scroll|scrollend|securitypolicyviolation|seeked|seeking|select|selectionchange|selectstart|slotchange|stalled|submit|suspend|timeupdate|toggle|touchcancel|touchend|touchmove|touchstart|transitioncancel|transitionend|transitionrun|transitionstart|volumechange|waiting|wheel)\s*=/i;
interface MermaidFence {
  body: string;
  closed: boolean;
  line: number;
}

interface SourceRange {
  end: number;
  path: string;
  scopeId: string;
  start: number;
}

interface SourceDeclarations {
  complete: boolean;
  sources: Map<string, string>;
}

interface SourceFootnoteDefinition {
  content: string;
  id: string;
}

interface SourceFootnoteScan {
  bodyWithoutDefinitions: string;
  definitions: SourceFootnoteDefinition[];
  references: string[];
}

interface MermaidProblem {
  code: "mermaid-syntax" | "mermaid-policy";
  message: string;
}

type WikiValidationMode = "candidate" | "global";

/**
 * Validate only the candidate pages declared by the final WikiSpec.
 *
 * This function is intentionally read-only. Indexes must already match the
 * deterministic projection materialized after the current write/repair wave.
 */
export async function validateWiki(
  root: string,
  spec: WikiSpec,
  wikiDirectory = "wiki",
  excludedPaths?: readonly string[],
  requiredSections: readonly string[] = [],
  pinnedRoots?: ResolvedWikiRoots,
): Promise<WikiValidation> {
  return validateWikiCandidate(root, spec, wikiDirectory, true, excludedPaths, requiredSections, pinnedRoots);
}

/** Validate the target Wiki without requiring indexes when finalizing. */
export async function validateWikiCandidate(
  root: string,
  spec: WikiSpec,
  wikiDirectory: string,
  validateIndexes: boolean,
  excludedPaths?: readonly string[],
  requiredSections: readonly string[] = [],
  pinnedRoots?: ResolvedWikiRoots,
): Promise<WikiValidation> {
  const issues: WikiValidationIssue[] = [];
  const targetPages = specPagePaths(spec);
  // Infrastructure failures (missing roots, bad workspace) throw rather than
  // becoming content-level wiki-safety issues.
  const roots = pinnedRoots ?? await resolveWikiRoots(root, wikiDirectory, excludedPaths);

  const tree = await scanWikiTree(roots.wiki);
  issues.push(...tree.issues);
  const targetSet = new Set(targetPages);
  const specPages = new Map(wikiSpecPages(spec).map((page) => [page.path, page]));
  const plannedTargets = new Set([...targetPages, ...derivedIndexPaths(targetPages)]);
  const actualPages = tree.markdown
    .filter((page) => !isReservedWikiPagePath(page) && targetSet.has(page))
    .sort();
  const obsoletePages = tree.markdown
    .filter((page) => !isReservedWikiPagePath(page) && !targetSet.has(page))
    .sort();
  const indexablePages = new Set<string>();

  for (const page of targetPages) {
    const body = await validateTargetPage(roots, specPages.get(page)!, plannedTargets, "global", requiredSections, issues);
    if (body !== undefined) indexablePages.add(page);
  }

  if (validateIndexes && !issues.some((entry) => entry.code === "spec-page")) {
    await validateWikiIndexes(roots, spec, targetPages, indexablePages, tree.markdown, issues);
  }
  return validationResult(issues, actualPages, obsoletePages);
}

/** Validate one writer-owned page without requiring its concurrently written peers to exist. */
export async function validateWikiPage(
  root: string,
  spec: WikiSpec,
  page: string,
  wikiDirectory = "wiki",
  excludedPaths?: readonly string[],
  requiredSections: readonly string[] = [],
  pinnedRoots?: ResolvedWikiRoots,
): Promise<WikiValidationIssue[]> {
  const issues = validateDeclaredPage(spec, page);
  if (issues.length) return issues;

  const roots = pinnedRoots ?? await resolveWikiRoots(root, wikiDirectory, excludedPaths);
  const absolute = path.join(roots.wiki, ...page.split("/"));
  let entry;
  try {
    entry = await lstat(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error;
    issue(issues, "missing-page", `Target page is missing: ${page}`, page);
    return issues;
  }
  if (entry.isSymbolicLink()) {
    issue(issues, "wiki-safety", `Target page must not be a symbolic link: ${page}`, page);
    return issues;
  }
  if (!entry.isFile()) {
    issue(issues, "wiki-safety", `Target page is not a regular file: ${page}`, page);
    return issues;
  }

  return validateWikiPageContentWithRoots(roots, spec, page, await readText(absolute), requiredSections);
}

/** Validate writer output before it replaces the candidate page. */
export async function validateWikiPageContent(
  root: string,
  spec: WikiSpec,
  page: string,
  content: string,
  wikiDirectory = "wiki",
  excludedPaths?: readonly string[],
  requiredSections: readonly string[] = [],
  pinnedRoots?: ResolvedWikiRoots,
): Promise<WikiValidationIssue[]> {
  const issues = validateDeclaredPage(spec, page);
  if (issues.length) return issues;
  const roots = pinnedRoots ?? await resolveWikiRoots(root, wikiDirectory, excludedPaths);
  return validateWikiPageContentWithRoots(roots, spec, page, content, requiredSections);
}

/** Normalize YAML frontmatter with the bundled parser; no external formatter is required. */
export function canonicalizeWikiPageContent(content: string): string {
  return stringifyPage(parsePage(content));
}

function validateDeclaredPage(spec: WikiSpec, page: string): WikiValidationIssue[] {
  const issues: WikiValidationIssue[] = [];
  if (!isSafeWikiPagePath(page)) {
    issue(issues, "spec-page", `Page is unsafe or reserved: ${page}`, page);
    return issues;
  }
  const targetPages = specPagePaths(spec);
  if (!targetPages.includes(page)) {
    issue(issues, "spec-page", `Page is not declared in the WikiSpec: ${page}`, page);
    return issues;
  }
  return issues;
}

async function validateWikiPageContentWithRoots(
  roots: ResolvedWikiRoots,
  spec: WikiSpec,
  page: string,
  content: string,
  requiredSections: readonly string[],
): Promise<WikiValidationIssue[]> {
  const issues: WikiValidationIssue[] = [];
  const targetPages = specPagePaths(spec);
  const plannedTargets = new Set([...targetPages, ...derivedIndexPaths(targetPages)]);
  const specPage = wikiSpecPages(spec).find((candidate) => candidate.path === page)!;
  await validatePageContent(roots, specPage, content, plannedTargets, "candidate", requiredSections, issues);
  return issues;
}

async function validateTargetPage(
  roots: ResolvedWikiRoots,
  specPage: WikiSpecPage,
  plannedTargets: ReadonlySet<string>,
  mode: WikiValidationMode,
  requiredSections: readonly string[],
  issues: WikiValidationIssue[],
): Promise<string | undefined> {
  const page = specPage.path;
  const absolute = path.join(roots.wiki, ...page.split("/"));
  let entry;
  try {
    entry = await lstat(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error;
    issue(issues, "missing-page", `Target page is missing: ${page}`, page);
    return undefined;
  }
  if (entry.isSymbolicLink()) {
    issue(issues, "wiki-safety", `Target page must not be a symbolic link: ${page}`, page);
    return undefined;
  }
  if (!entry.isFile()) {
    issue(issues, "wiki-safety", `Target page is not a regular file: ${page}`, page);
    return undefined;
  }

  return validatePageContent(roots, specPage, await readText(absolute), plannedTargets, mode, requiredSections, issues);
}

async function validatePageContent(
  roots: ResolvedWikiRoots,
  specPage: WikiSpecPage,
  content: string,
  plannedTargets: ReadonlySet<string>,
  mode: WikiValidationMode,
  requiredSections: readonly string[],
  issues: WikiValidationIssue[],
): Promise<string | undefined> {
  const page = specPage.path;
  let parsed: ReturnType<typeof parsePage>;
  try {
    parsed = parsePage(content);
  } catch (error) {
    issue(issues, "frontmatter", errorMessage(error), page);
    return undefined;
  }

  const pageType = wikiSpecPageType(page);
  if (!pageType) {
    issue(issues, "spec-page", `Page is not a legal Source -> Domain -> Concept path: ${page}`, page);
    return undefined;
  }
  const sources = await validateFrontmatter(page, pageType, parsed.frontmatter, roots, mode, issues);
  await validateBody(page, parsed.body, roots, plannedTargets, sources, issues);
  validateRequiredSections(page, parsed.body, requiredSections, issues);
  return parsed.body;
}

function validateRequiredSections(
  page: string,
  body: string,
  requiredSections: readonly string[],
  issues: WikiValidationIssue[],
): void {
  if (!requiredSections.length) return;
  const headings = new Set<string>();
  for (const line of markdownOutsideCode(body).split(/\r?\n/)) {
    const match = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (match) headings.add(normalizeHeading(match[1]));
  }
  for (const section of requiredSections) {
    const normalized = normalizeHeading(section);
    if (normalized && !headings.has(normalized)) {
      issue(issues, "required-section", `Required section is missing: ${section.trim()}`, page);
    }
  }
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

async function validateFrontmatter(
  page: string,
  pageType: WikiSpecPage["pageType"],
  frontmatter: Record<string, unknown>,
  roots: ResolvedWikiRoots,
  mode: WikiValidationMode,
  issues: WikiValidationIssue[],
): Promise<SourceDeclarations> {
  for (const field of ["title", "description"] as const) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field].trim()) {
      issue(issues, "frontmatter", `Frontmatter requires a non-empty ${field}`, page);
    }
  }

  const expectedType = canonicalPageType(pageType);
  if (frontmatter.type !== expectedType) {
    issue(issues, "frontmatter", `Frontmatter type must match WikiSpec page type: ${expectedType}`, page);
  }

  validateTrustFrontmatter(page, frontmatter, mode, issues);

  const tags = frontmatter.tags;
  if (tags !== undefined && (!Array.isArray(tags) || !tags.length || tags.some((tag) => typeof tag !== "string" || !tag.trim()))) {
    issue(issues, "frontmatter", "Frontmatter tags must be a non-empty string array", page);
  }

  const sources = frontmatter.sources;
  const parsedSources = okfSources(sources);
  if (!parsedSources) {
    issue(issues, "frontmatter", "Frontmatter sources must be a non-empty array of { id, resource } objects", page);
    return { complete: false, sources: new Map() };
  }

  const ids = new Set<string>();
  const declared = new Map<string, string>();
  let complete = true;
  for (const source of parsedSources) {
    if (ids.has(source.id)) {
      issue(issues, "frontmatter", `Frontmatter source ids must be unique: ${source.id}`, page);
      complete = false;
    }
    ids.add(source.id);
    if (!declared.has(source.id)) declared.set(source.id, source.resource);
    await validateSourceReference(page, source.resource, roots, `frontmatter source ${source.id}`, issues);
  }
  return { complete, sources: declared };
}

function validateTrustFrontmatter(
  page: string,
  frontmatter: Record<string, unknown>,
  mode: WikiValidationMode,
  issues: WikiValidationIssue[],
): void {
  if (mode === "candidate") {
    for (const field of PUBLISHER_OWNED_FIELDS) {
      if (Object.hasOwn(frontmatter, field)) {
        issue(issues, "frontmatter", `Frontmatter field is publisher-owned and forbidden in writer output: ${field}`, page);
      }
    }
    return;
  }

  for (const field of ["okf_version", "human", "stale_after"] as const) {
    if (Object.hasOwn(frontmatter, field)) {
      issue(issues, "frontmatter", `Concept page frontmatter must not contain publisher-reserved field: ${field}`, page);
    }
  }
  if (frontmatter.generated !== undefined && !isPublisherActor(frontmatter.generated, GENERATED_BY, false)) {
    issue(issues, "frontmatter", `Frontmatter generated must use publisher actor ${GENERATED_BY}`, page);
  }
  if (frontmatter.verified !== undefined) {
    const values = Array.isArray(frontmatter.verified) ? frontmatter.verified : [frontmatter.verified];
    if (!values.length || values.some((value) => !isPublisherActor(value, VERIFIED_BY, true))) {
      issue(issues, "frontmatter", `Frontmatter verified must use publisher actor ${VERIFIED_BY}`, page);
    }
  }
}

export function isPublisherActor(value: unknown, by: string, requireTimestamp: boolean): boolean {
  if (!isRecord(value)) return false;
  const actor = value;
  if (actor.by !== by) return false;
  if (requireTimestamp && typeof actor.at !== "string") return false;
  if (actor.at !== undefined && (typeof actor.at !== "string" || !isIsoTimestamp(actor.at))) return false;
  return Object.keys(actor).every((key) => key === "by" || key === "at");
}

export function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

async function validateBody(
  page: string,
  body: string,
  roots: ResolvedWikiRoots,
  plannedTargets: ReadonlySet<string>,
  sources: SourceDeclarations,
  issues: WikiValidationIssue[],
): Promise<void> {
  for (const fence of mermaidFences(body)) {
    if (!fence.closed) {
      issue(issues, "mermaid-syntax", `Mermaid fence opened on line ${fence.line} is not closed`, page);
      continue;
    }
    for (const problem of mermaidProblems(fence.body)) {
      issue(issues, problem.code, `Mermaid fence on line ${fence.line} is invalid: ${problem.message}`, page);
    }
  }

  const footnotes = sourceFootnotes(body);
  await validateSourceFootnotes(page, footnotes, sources, roots, issues);

  for (const target of markdownTargets(footnotes.bodyWithoutDefinitions)) {
    if (parseSourceCitation(target)) {
      await validateSourceReference(page, target, roots, "source citation", issues);
      issue(
        issues,
        "source-reference",
        `Direct source citation must use a declared source footnote: ${target} — cite with [^id] in body and define [^id]: [label](scope/path#Lx) instead of linking the source file in prose`,
        page,
      );
      continue;
    }
    validateInternalMarkdownLink(page, target, plannedTargets, issues);
  }
}

async function validateSourceFootnotes(
  page: string,
  scan: SourceFootnoteScan,
  declarations: SourceDeclarations,
  roots: ResolvedWikiRoots,
  issues: WikiValidationIssue[],
): Promise<void> {
  if (!declarations.complete) return;

  const referenced = new Set(scan.references);
  const definitions = new Map<string, SourceFootnoteDefinition>();
  for (const definition of scan.definitions) {
    if (definitions.has(definition.id)) {
      issue(
        issues,
        "source-reference",
        `Source footnote is defined more than once: ${definition.id} — keep a single [^${definition.id}]: definition`,
        page,
      );
    } else {
      definitions.set(definition.id, definition);
    }
    if (!declarations.sources.has(definition.id) && !referenced.has(definition.id)) {
      issue(
        issues,
        "source-reference",
        `Source footnote definition is not declared in frontmatter sources: ${definition.id} — add { id: "${definition.id}", resource: "scope/path#Lx" } to frontmatter sources or remove the orphan definition`,
        page,
      );
    }
  }

  for (const id of referenced) {
    if (!declarations.sources.has(id)) {
      issue(
        issues,
        "source-reference",
        `Source footnote reference is not declared in frontmatter sources: ${id} — add { id: "${id}", resource: "scope/path#Lx" } to frontmatter sources`,
        page,
      );
    }
    if (!definitions.has(id)) {
      issue(
        issues,
        "source-reference",
        `Source footnote reference has no definition: ${id} — add [^${id}]: [label](scope/path#Lx) matching the frontmatter resource`,
        page,
      );
    }
  }

  for (const [id, resource] of declarations.sources) {
    if (!referenced.has(id)) {
      issue(
        issues,
        "source-reference",
        `Frontmatter source is not cited by a footnote: ${id} — cite the claim with [^${id}] in the body`,
        page,
      );
      continue;
    }
    const definition = definitions.get(id);
    if (!definition) continue;
    const resources = markdownTargetOccurrences(definition.content).filter((target) => parseSourceCitation(target));
    if (resources.length !== 1) {
      issue(
        issues,
        "source-reference",
        `Source footnote definition must contain exactly one source link: ${id} — use exactly one [label](scope/path#Lx) link in [^${id}]`,
        page,
      );
      continue;
    }
    const footnote = parseSourceCitation(resources[0]);
    const declared = parseSourceCitation(resource);
    if (!footnote || !declared || !sourceCitationsEqual(footnote, declared)) {
      await validateSourceReference(page, resources[0], roots, `source footnote ${id}`, issues);
      issue(
        issues,
        "source-reference",
        `Source footnote resource does not match frontmatter source ${id}: ${resources[0]} — set the footnote link equal to frontmatter resource ${resource}`,
        page,
      );
    }
  }
}

async function validateSourceReference(
  page: string,
  reference: string,
  roots: ResolvedWikiRoots,
  label: string,
  issues: WikiValidationIssue[],
): Promise<void> {
  const parsed = parseSourceReference(reference);
  if (!parsed) {
    issue(issues, "source-reference", `${label} must be <scope>/<path>#Lx: ${reference}`, page);
    return;
  }
  if (parsed.end < parsed.start) {
    issue(issues, "source-reference", `${label} has an invalid line range: ${reference}`, page);
    return;
  }

  const declaredPath = `${parsed.scopeId}/${parsed.path}`;
  if (roots.excludedPaths.some((pattern) => matchesPathGlob(parsed.path, pattern) || matchesPathGlob(declaredPath, pattern))) {
    issue(issues, "source-reference", `${label} targets a path excluded by workspace policy: ${reference}`, page);
    return;
  }

  const source = roots.sources.get(parsed.scopeId);
  if (!source) {
    issue(issues, "source-reference", `${label} must start with a declared source scope: ${reference}`, page);
    return;
  }

  let sourceFile: string;
  try {
    sourceFile = inside(source.realPath, path.resolve(source.realPath, ...parsed.path.split("/")));
  } catch {
    issue(issues, "source-reference", `${label} escapes the source tree: ${reference}`, page);
    return;
  }

  await validateSourceFile(page, source, sourceFile, reference, label, parsed, issues);
}

async function validateSourceFile(
  page: string,
  source: Pick<ResolvedWikiSource, "path" | "absolutePath" | "realPath" | "repositoryRoot">,
  sourceFile: string,
  reference: string,
  label: string,
  range: SourceRange,
  issues: WikiValidationIssue[],
): Promise<void> {
  try {
    const physicalSource = await realpath(sourceFile);
    try {
      inside(source.realPath, physicalSource);
    } catch {
      issue(issues, "source-reference", `${label} resolves outside declared source ${source.path}: ${reference}`, page);
      return;
    }
    if (!(await stat(physicalSource)).isFile()) {
      issue(issues, "source-reference", `${label} does not name a file: ${reference}`, page);
      return;
    }
    const lines = lineCount(await readFile(physicalSource, "utf8"));
    if (lines < range.end) {
      issue(issues, "source-reference", `${label} line range exceeds file (${lines} lines): ${reference}`, page);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    issue(issues, "source-reference", `${label} file is missing: ${reference}`, page);
  }
}

function parseSourceReference(value: string): SourceRange | undefined {
  const parsed = parseSourceCitation(value);
  if (!parsed) return undefined;
  return { scopeId: parsed.scope, path: parsed.path, start: parsed.startLine, end: parsed.endLine };
}

function validateInternalMarkdownLink(
  page: string,
  target: string,
  plannedTargets: ReadonlySet<string>,
  issues: WikiValidationIssue[],
): void {
  const resolved = resolveInternalMarkdownLink(page, target);
  if (resolved === undefined) return;
  if (resolved === null) {
    issue(issues, "internal-link", `Internal Markdown link escapes wiki/: ${target}`, page);
    return;
  }
  if (!plannedTargets.has(resolved)) {
    issue(issues, "internal-link", `Internal Markdown link target is not in the target Wiki: ${target}`, page);
  }
}

function resolveInternalMarkdownLink(page: string, target: string): string | null | undefined {
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  const resource = target.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(resource);
  } catch {
    return null;
  }
  if (!decoded.endsWith(".md") || decoded.includes("\\") || decoded.startsWith("/")) {
    return decoded.endsWith(".md") ? null : undefined;
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page), decoded));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) return null;
  return resolved;
}

function sourceFootnotes(markdown: string): SourceFootnoteScan {
  const lines = markdownOutsideCode(markdown).split(/\r?\n/);
  const bodyLines = [...lines];
  const definitions: SourceFootnoteDefinition[] = [];

  for (let index = 0; index < lines.length; index++) {
    const match = /^[ \t]{0,3}\[\^([^\]\n]+)\]:[ \t]*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const content = [match[2]];
    bodyLines[index] = "";
    let cursor = index + 1;
    while (cursor < lines.length) {
      const continuation = /^(?: {2,}|\t)(.*)$/.exec(lines[cursor]);
      if (continuation) {
        content.push(continuation[1]);
        bodyLines[cursor] = "";
        cursor++;
        continue;
      }
      if (!lines[cursor].trim() && /^(?: {2,}|\t)/.test(lines[cursor + 1] ?? "")) {
        content.push("");
        bodyLines[cursor] = "";
        cursor++;
        continue;
      }
      break;
    }
    definitions.push({ id: match[1], content: content.join("\n") });
    index = cursor - 1;
  }

  const bodyWithoutDefinitions = bodyLines.join("\n");
  const references: string[] = [];
  for (const match of bodyWithoutDefinitions.matchAll(/\[\^([^\]\n]+)\]/g)) {
    if (!isMarkdownEscaped(bodyWithoutDefinitions, match.index)) references.push(match[1]);
  }
  return { bodyWithoutDefinitions, definitions, references };
}

function markdownTargets(markdown: string): string[] {
  return [...new Set(markdownTargetOccurrences(markdown))];
}

function markdownTargetOccurrences(markdown: string): string[] {
  const targets: string[] = [];
  const definitions = new Map<string, string>();
  const visible = markdownOutsideCode(markdown);
  const withoutDefinitions = visible.replace(
    /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^ \t\n]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?[ \t]*$/gm,
    (line: string, label: string, bracketedTarget: string | undefined, bareTarget: string | undefined) => {
      const target = bracketedTarget ?? bareTarget;
      if (target) {
        definitions.set(referenceLabel(label), target);
      }
      return line.replace(/[^\r\n]/g, " ");
    },
  );
  const inline = /(?<!!)\[[^\]\n]*\]\([ \t]*(?:<([^>\n]+)>|([^\s)]+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^\)]*\)))?[ \t]*\)/g;
  for (const match of withoutDefinitions.matchAll(inline)) targets.push(match[1] ?? match[2]);

  const fullReference = /(?<!!)\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
  for (const match of withoutDefinitions.matchAll(fullReference)) {
    const target = definitions.get(referenceLabel(match[2] || match[1]));
    if (target) targets.push(target);
  }

  const shortcutReference = /(?<!!)\[([^\]\n]+)\](?![\[(:])/g;
  for (const match of withoutDefinitions.matchAll(shortcutReference)) {
    const target = definitions.get(referenceLabel(match[1]));
    if (target) targets.push(target);
  }

  return targets;
}

function isMarkdownEscaped(markdown: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function markdownOutsideCode(markdown: string): string {
  const lines: string[] = [];
  let open: { marker: string } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const fence = /^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
    if (open) {
      if (fence && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && !fence[3]) open = undefined;
      lines.push("");
    } else if (fence) {
      open = { marker: fence[2] };
      lines.push("");
    } else {
      lines.push(withoutInlineCode(line));
    }
  }
  return lines.join("\n");
}

function withoutInlineCode(line: string): string {
  const characters = line.split("");
  for (let index = 0; index < characters.length;) {
    if (characters[index] !== "`") {
      index++;
      continue;
    }
    let markerLength = 1;
    while (characters[index + markerLength] === "`") markerLength++;
    const marker = "`".repeat(markerLength);
    const close = line.indexOf(marker, index + markerLength);
    const end = close < 0 ? characters.length : close + markerLength;
    for (let cursor = index; cursor < end; cursor++) characters[cursor] = " ";
    index = end;
  }
  return characters.join("");
}

function referenceLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function mermaidFences(markdown: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  let open: { marker: string; line: number; body: string[] } | undefined;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const fence = /^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
    if (open) {
      if (fence && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && !fence[3]) {
        fences.push({ line: open.line, body: open.body.join("\n"), closed: true });
        open = undefined;
      } else {
        open.body.push(line);
      }
    } else if (fence?.[3].toLowerCase() === "mermaid") {
      open = { marker: fence[2], line: index + 1, body: [] };
    }
  }
  if (open) fences.push({ line: open.line, body: open.body.join("\n"), closed: false });
  return fences;
}

function mermaidProblems(body: string): MermaidProblem[] {
  const problems: MermaidProblem[] = [];
  const meaningful = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("%%"));
  const declaration = meaningful[0];
  let diagramType: string | undefined;
  if (!declaration) {
    problems.push({ code: "mermaid-syntax", message: "diagram is empty" });
  } else {
    const [declaredType, ...parameters] = declaration.split(/\s+/);
    diagramType = declaredType;
    if (diagramType === "flowchart") {
      if (parameters.length !== 1 || !MERMAID_FLOW_DIRECTIONS.has(parameters[0])) {
        problems.push({ code: "mermaid-syntax", message: "flowchart declaration requires one of: TB, TD, BT, RL, LR" });
      }
    } else if (!MERMAID_DIAGRAM_TYPES.has(diagramType) || parameters.length) {
      problems.push({
        code: "mermaid-syntax",
        message: "diagram declaration must be flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, or erDiagram",
      });
    }
  }

  const control = firstInvalidControl(body);
  if (control) problems.push({ code: "mermaid-syntax", message: `diagram contains an invalid control character on line ${control.line}` });
  if (/^\s*%%\{.*\}%%\s*$/m.test(body)) {
    problems.push({ code: "mermaid-policy", message: "Mermaid configuration directives are not allowed" });
  }
  if (/^\s*click\s+\S+/im.test(body)) {
    problems.push({ code: "mermaid-policy", message: "interactive Mermaid click actions are not allowed" });
  }
  if (containsUnsafeHtmlUrl(body)) {
    problems.push({ code: "mermaid-policy", message: "diagram contains an unsafe URL" });
  }
  if (MERMAID_EVENT_HANDLER.test(body)) {
    problems.push({ code: "mermaid-policy", message: "diagram contains an HTML event handler" });
  }
  return problems;
}

function containsUnsafeHtmlUrl(body: string): boolean {
  const attribute = /<[^>]+\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of body.matchAll(attribute)) {
    let value = match[1] ?? match[2] ?? match[3];
    value = value.replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (_entity, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal!, hex ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    });
    value = value.replace(/&(colon|tab|newline);/gi, (entity) => {
      const name = entity.slice(1, -1).toLowerCase();
      return name === "colon" ? ":" : name === "tab" ? "\t" : "\n";
    });
    for (let round = 0; round < 3; round++) {
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch {
        break;
      }
    }
    const canonical = value.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
    if (/^(?:javascript|vbscript|data):/.test(canonical)) return true;
  }
  return false;
}

function firstInvalidControl(body: string): { line: number } | undefined {
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) return { line: index + 1 };
  }
  return undefined;
}

function canonicalPageType(pageType: WikiSpecPage["pageType"]): string {
  return pageType[0].toUpperCase() + pageType.slice(1);
}

export function validationResult(issues: WikiValidationIssue[], pages: string[], obsoletePages: string[]): WikiValidation {
  return { ok: issues.length === 0, issues, pages, obsoletePages };
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function matchesPathGlob(value: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  return path.matchesGlob(value, normalized);
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? lines - 1 : lines;
}
