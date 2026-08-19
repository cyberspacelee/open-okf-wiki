import { lstat, mkdir, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { WikiValidationInfrastructureError, errorMessage } from "../failures.js";
import { inside, readText, writeText } from "../files.js";
import { parsePage } from "../frontmatter.js";
import { wikiSourceSlug } from "../inspect.js";
import type { WikiPinnedSourcePlan } from "../runtime-types.js";
import { formatIssue, issue, type WikiValidationIssue } from "./validate.js";
import { loadWikiWorkspace, type ResolvedWikiSource } from "../workspace.js";
import type { WikiSpec } from "./spec.js";

export interface ResolvedWikiRoots {
  language: "zh" | "en";
  /** Sources keyed by scopeId (original directory name, or `source` when implicit). */
  sources: Map<string, Pick<ResolvedWikiSource, "path" | "absolutePath" | "realPath" | "repositoryRoot">>;
  wiki: string;
  workspace: string;
  excludedPaths: readonly string[];
}

export interface WikiTreeScan {
  markdown: string[];
  issues: WikiValidationIssue[];
}

export async function resolveWikiRoots(root: string, wikiDirectory = "wiki", excludedPaths?: readonly string[]): Promise<ResolvedWikiRoots> {
  try {
    const configured = await loadWikiWorkspace(root);
    const requestedWorkspace = path.resolve(configured.root);
    const workspace = await realpath(requestedWorkspace);
    if (!wikiDirectory || path.isAbsolute(wikiDirectory)) throw new WikiValidationInfrastructureError("Wiki directory must be workspace-relative");
    const requestedWiki = inside(requestedWorkspace, path.resolve(requestedWorkspace, wikiDirectory));
    let wikiEntry;
    try {
      wikiEntry = await lstat(requestedWiki);
    } catch {
      throw new WikiValidationInfrastructureError("wiki directory is missing");
    }
    if (wikiEntry.isSymbolicLink()) throw new WikiValidationInfrastructureError("wiki directory must not be a symbolic link");
    if (!wikiEntry.isDirectory()) throw new WikiValidationInfrastructureError(`wiki directory is not a directory: ${wikiDirectory}`);
    const wiki = await realpath(requestedWiki);
    inside(workspace, wiki);
    return {
      workspace,
      wiki,
      language: configured.language,
      sources: new Map(configured.sources.map((source) => [wikiSourceSlug(source.path), source])),
      excludedPaths: excludedPaths ?? configured.wiki.exclude,
    };
  } catch (error) {
    if (error instanceof WikiValidationInfrastructureError) throw error;
    throw new WikiValidationInfrastructureError(errorMessage(error), { cause: error });
  }
}

/** Resolve validation roots exclusively from the immutable production plan. */
export async function resolvePinnedWikiRoots(
  plan: WikiPinnedSourcePlan,
  language: "zh" | "en",
  wikiDirectory = "wiki",
): Promise<ResolvedWikiRoots> {
  try {
    const requestedWorkspace = path.resolve(plan.workspaceRoot);
    const workspace = await realpath(requestedWorkspace);
    if (workspace !== path.resolve(plan.workspaceRealPath)) throw new WikiValidationInfrastructureError("Pinned workspace identity changed");
    if (!wikiDirectory || path.isAbsolute(wikiDirectory)) throw new WikiValidationInfrastructureError("Wiki directory must be workspace-relative");
    const requestedWiki = inside(requestedWorkspace, path.resolve(requestedWorkspace, wikiDirectory));
    const wikiEntry = await lstat(requestedWiki).catch(() => undefined);
    if (!wikiEntry) throw new WikiValidationInfrastructureError("wiki directory is missing");
    if (wikiEntry.isSymbolicLink()) throw new WikiValidationInfrastructureError("wiki directory must not be a symbolic link");
    if (!wikiEntry.isDirectory()) throw new WikiValidationInfrastructureError(`wiki directory is not a directory: ${wikiDirectory}`);
    const wiki = await realpath(requestedWiki);
    inside(workspace, wiki);
    return {
      workspace,
      wiki,
      language,
      sources: new Map(plan.sources.map((source) => [source.scopeId, {
        path: source.logicalPath,
        absolutePath: source.absolutePath,
        realPath: source.realPath,
        repositoryRoot: source.repositoryRoot,
      }])),
      excludedPaths: [...plan.excludes],
    };
  } catch (error) {
    if (error instanceof WikiValidationInfrastructureError) throw error;
    throw new WikiValidationInfrastructureError(errorMessage(error), { cause: error });
  }
}

export function specPagePaths(spec: WikiSpec): string[] {
  return [...spec.pages].sort();
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

export async function scanWikiTree(wikiRoot: string, relative = ""): Promise<WikiTreeScan> {
  const markdown: string[] = [];
  const issues: WikiValidationIssue[] = [];
  const directory = relative ? path.join(wikiRoot, ...relative.split("/")) : wikiRoot;
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      issue(issues, "wiki-safety", `Wiki tree must not contain symbolic links: ${child}`);
    } else if (entry.isDirectory()) {
      const nested = await scanWikiTree(wikiRoot, child);
      markdown.push(...nested.markdown);
      issues.push(...nested.issues);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".md")) markdown.push(child);
    } else {
      issue(issues, "wiki-safety", `Wiki tree contains a non-regular entry: ${child}`);
    }
  }
  return { markdown: markdown.sort(), issues };
}

export async function removeRegularWikiFile(wikiRoot: string, relative: string): Promise<boolean> {
  const absolute = safeWikiPath(wikiRoot, relative);
  let entry;
  try {
    entry = await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (entry.isSymbolicLink()) throw new Error(`Refusing to remove a symbolic link from wiki/: ${relative}`);
  if (!entry.isFile()) throw new Error(`Refusing to remove a non-regular Wiki file: ${relative}`);
  inside(wikiRoot, await realpath(absolute));
  await unlink(absolute);
  return true;
}

export function safeWikiPath(wikiRoot: string, relative: string): string {
  if (!relative || relative.includes("\\") || relative.startsWith("/")) throw new Error(`Unsafe Wiki path: ${relative}`);
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === "." || normalized.startsWith("../")) throw new Error(`Unsafe Wiki path: ${relative}`);
  const absolute = inside(wikiRoot, path.resolve(wikiRoot, ...relative.split("/")));
  if (absolute === path.resolve(wikiRoot)) throw new Error("Refusing to operate on the Wiki root directory");
  return absolute;
}

/** Replace the deterministic index projection without modifying concept pages. */
export async function materializeWikiIndexes(root: string, spec: WikiSpec, wikiDirectory = "wiki", pinnedRoots?: ResolvedWikiRoots): Promise<string[]> {
  const targetPages = specPagePaths(spec);

  const roots = pinnedRoots ?? await resolveWikiRoots(root, wikiDirectory);
  const tree = await scanWikiTree(roots.wiki);
  if (tree.issues.length) throw new Error(`Unsafe Wiki tree: ${tree.issues.map(formatIssue).join("; ")}`);

  // Read every page before replacing indexes so a malformed page cannot leave a partial projection.
  for (const page of targetPages) {
    const parsed = parsePage(await readText(safeWikiPath(roots.wiki, page)));
    if (!normalizeIndexText(parsed.frontmatter.title) || !normalizeIndexText(parsed.frontmatter.description)) {
      throw new Error(`Cannot materialize Wiki index from invalid page metadata: ${page}`);
    }
  }

  for (const indexPath of tree.markdown.filter((page) => path.posix.basename(page) === "index.md")) {
    await removeRegularWikiFile(roots.wiki, indexPath);
  }
  const rebuiltIndexes = derivedIndexPaths(targetPages);
  for (const indexPath of rebuiltIndexes) {
    await writeWikiIndex(roots.wiki, indexPath, targetPages, rebuiltIndexes, spec, roots.language);
  }
  return rebuiltIndexes;
}

export async function validateWikiIndexes(
  roots: ResolvedWikiRoots,
  spec: WikiSpec,
  targetPages: readonly string[],
  indexablePages: ReadonlySet<string>,
  markdown: readonly string[],
  issues: WikiValidationIssue[],
): Promise<void> {
  const expectedIndexes = derivedIndexPaths(targetPages);
  const expectedSet = new Set(expectedIndexes);
  const actualIndexes = markdown.filter((page) => path.posix.basename(page) === "index.md");
  const actualSet = new Set(actualIndexes);

  for (const indexPath of expectedIndexes) {
    if (!actualSet.has(indexPath)) issue(issues, "wiki-index", `Required Wiki index is missing: ${indexPath}`, indexPath);
  }
  for (const indexPath of actualIndexes) {
    if (!expectedSet.has(indexPath)) issue(issues, "wiki-index", `Unexpected Wiki index is present: ${indexPath}`, indexPath);
  }
  for (const indexPath of expectedIndexes) {
    if (!actualSet.has(indexPath)) continue;
    const relativeDirectory = path.posix.dirname(indexPath) === "." ? "" : path.posix.dirname(indexPath);
    const directPages = targetPages.filter(
      (page) => (path.posix.dirname(page) === "." ? "" : path.posix.dirname(page)) === relativeDirectory,
    );
    if (directPages.some((page) => !indexablePages.has(page))) continue;
    const expected = await renderWikiIndex(roots.wiki, indexPath, targetPages, expectedIndexes, spec, roots.language);
    const actual = await readText(safeWikiPath(roots.wiki, indexPath));
    if (actual !== expected) {
      issue(issues, "wiki-index", `Wiki index does not match the deterministic OKF projection: ${indexPath}`, indexPath);
    }
  }
}

async function writeWikiIndex(
  wikiRoot: string,
  indexPath: string,
  targetPages: readonly string[],
  targetIndexes: readonly string[],
  spec: WikiSpec,
  language: "zh" | "en",
): Promise<void> {
  const absolute = safeWikiPath(wikiRoot, indexPath);
  const relativeDirectory = path.posix.dirname(indexPath) === "." ? "" : path.posix.dirname(indexPath);
  const directory = relativeDirectory ? safeWikiPath(wikiRoot, relativeDirectory) : wikiRoot;
  await mkdir(directory, { recursive: true });
  await assertSafeDirectoryChain(wikiRoot, relativeDirectory);

  try {
    const existing = await lstat(absolute);
    if (existing.isSymbolicLink()) throw new Error(`Refusing to replace a symbolic Wiki index: ${indexPath}`);
    throw new Error(`Refusing to replace an unexpected Wiki entry: ${indexPath}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const content = await renderWikiIndex(wikiRoot, indexPath, targetPages, targetIndexes, spec, language);
  // Pre-check above refuses existing entries; atomic rename finalizes the new index.
  await writeText(absolute, content);
}

async function renderWikiIndex(
  wikiRoot: string,
  indexPath: string,
  targetPages: readonly string[],
  targetIndexes: readonly string[],
  spec: WikiSpec,
  language: "zh" | "en",
): Promise<string> {
  const relativeDirectory = path.posix.dirname(indexPath) === "." ? "" : path.posix.dirname(indexPath);
  const directPages = targetPages
    .filter((page) => (path.posix.dirname(page) === "." ? "" : path.posix.dirname(page)) === relativeDirectory)
    .sort();
  const directDirectories = targetIndexes
    .map((candidate) => path.posix.dirname(candidate) === "." ? "" : path.posix.dirname(candidate))
    .filter((candidate) => candidate && (path.posix.dirname(candidate) === "." ? "" : path.posix.dirname(candidate)) === relativeDirectory)
    .sort();
  const descriptor = await directoryDescriptor(wikiRoot, relativeDirectory, spec);
  const title = descriptor.title;
  const lines = indexPath === "index.md"
    ? ["---", 'okf_version: "0.2"', "---", "", `# ${escapeMarkdownText(title)}`, ""]
    : [`# ${escapeMarkdownText(title)}`, ""];
  if (descriptor.description) lines.push(escapeMarkdownText(descriptor.description), "");
  if (directDirectories.length) {
    const directoryEntries = await Promise.all(directDirectories.map(async (child) => {
      const name = path.posix.basename(child);
      const childDescriptor = await directoryDescriptor(wikiRoot, child, spec);
      return `- [${escapeMarkdownText(childDescriptor.title)}](./${name}/index.md): ${escapeMarkdownText(childDescriptor.description)}`;
    }));
    lines.push("## Directories", "", ...directoryEntries, "");
  }
  if (directPages.length) {
    const pageMetadata = await Promise.all(directPages.map(async (page) => {
      const parsed = parsePage(await readText(safeWikiPath(wikiRoot, page)));
      return {
        description: normalizeIndexText(parsed.frontmatter.description),
        name: path.posix.basename(page),
        title: normalizeIndexText(parsed.frontmatter.title),
      };
    }));
    lines.push(
      "## Pages",
      "",
      ...pageMetadata.map((page) => `- [${escapeMarkdownText(page.title)}](./${page.name}): ${escapeMarkdownText(page.description)}`),
      "",
    );
  }
  return `${lines.join("\n").replace(/\n+$/, "\n")}`;
}

async function directoryDescriptor(
  wikiRoot: string,
  relativeDirectory: string,
  spec: WikiSpec,
): Promise<{ description: string; title: string }> {
  if (!relativeDirectory) return { title: "Wiki", description: "" };
  const segments = relativeDirectory.split("/");
  const descriptorPage = segments.length === 1
    ? `${relativeDirectory}/source.md`
    : segments.length === 2
      ? `${relativeDirectory}/domain.md`
      : segments.length === 3
        ? `${relativeDirectory}/concept.md`
        : undefined;
  if (descriptorPage && spec.pages.includes(descriptorPage)) {
    const parsed = parsePage(await readText(safeWikiPath(wikiRoot, descriptorPage)));
    const title = normalizeIndexText(parsed.frontmatter.title);
    if (title) return { title, description: normalizeIndexText(parsed.frontmatter.description) };
  }
  return { title: path.posix.basename(relativeDirectory), description: "" };
}

async function assertSafeDirectoryChain(wikiRoot: string, relative: string): Promise<void> {
  let current = wikiRoot;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = inside(wikiRoot, path.join(current, segment));
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`Wiki index directory must not be a symbolic link: ${relative}`);
    if (!entry.isDirectory()) throw new Error(`Wiki index parent is not a directory: ${relative}`);
    inside(wikiRoot, await realpath(current));
  }
}


function normalizeIndexText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_[\]{}#!|])/g, "\\$1");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
