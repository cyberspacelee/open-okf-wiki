import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { extractSourceCitations } from "./citations.js";
import { WikiValidationInfrastructureError, errorMessage } from "./failures.js";
import { inside, readText, writeText } from "./files.js";
import { parsePage, stringifyPage } from "./frontmatter.js";
import { isReservedWikiPagePath, isSafeWikiPagePath } from "./path.js";

export const GENERATED_BY = "open-okf-wiki/1.0.0";
export const VERIFIED_BY = "process:open-okf-wiki";

const MERMAID_PAGES = new Set(["flows.md", "models.md", "states.md", "data.md"]);
const MERMAID_FENCE = /```mermaid\b/;

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

export async function scanWikiTree(wikiRoot: string, relative = ""): Promise<{ markdown: string[]; issues: WikiValidationIssue[] }> {
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
  for (const relative of tree.markdown) {
    const filename = relative.split("/").at(-1) ?? "";
    if (isReservedWikiPagePath(relative)) continue;
    if (!isSafeWikiPagePath(relative)) {
      issues.push({ code: "path", page: relative, message: `Illegal Wiki page path: ${relative}` });
      continue;
    }
    pages.push(relative);
    let parsed;
    try {
      parsed = parsePage(await readText(safeWikiPath(wikiRoot, relative)));
    } catch (error) {
      issues.push({ code: "frontmatter", page: relative, message: errorMessage(error) });
      continue;
    }
    if (typeof parsed.frontmatter.type !== "string" || !parsed.frontmatter.type.trim()) {
      issues.push({ code: "okf", page: relative, message: "OKF documents require a non-empty type" });
    }
    if (MERMAID_PAGES.has(filename) && !MERMAID_FENCE.test(parsed.body)) {
      issues.push({ code: "mermaid", page: relative, message: `${filename} requires a mermaid diagram` });
    }
    const citations = extractSourceCitations(parsed.body, (citation) => {
      const root = sourceRoots.get(citation.scope);
      if (!root) return "missing";
      return undefined;
    });
    for (const invalid of citations.invalid) {
      issues.push({ code: "citation", page: relative, message: invalid });
    }
  }
  return { ok: issues.length === 0, issues, pages: pages.sort() };
}

export async function materializeWikiIndexes(wikiRoot: string, language: "zh" | "en"): Promise<string[]> {
  const tree = await scanWikiTree(wikiRoot);
  const pages = tree.markdown.filter((page) => !isReservedWikiPagePath(page) && isSafeWikiPagePath(page));
  const indexes = derivedIndexPaths(pages);
  const written: string[] = [];
  for (const indexPath of indexes) {
    const content = await renderIndex(wikiRoot, indexPath, pages, language);
    const absolute = indexPath === "index.md" ? path.join(wikiRoot, "index.md") : safeWikiPath(wikiRoot, indexPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeText(absolute, content);
    written.push(indexPath);
  }
  return written;
}

export async function stampPublication(wikiRoot: string, at: string): Promise<void> {
  const tree = await scanWikiTree(wikiRoot);
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
      parsed.frontmatter.verified = { by: VERIFIED_BY, at };
      await writeText(absolute, stringifyPage(parsed));
    } catch {
      // leave unreadable files for validate to report
    }
  }
}

async function renderIndex(
  wikiRoot: string,
  indexPath: string,
  pages: readonly string[],
  language: "zh" | "en",
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
  const title = relativeDirectory ? path.posix.basename(relativeDirectory) : (language === "zh" ? "仓库 Wiki" : "Repository Wiki");
  const lines = indexPath === "index.md"
    ? ["---", 'okf_version: "0.2"', "---", "", `# ${title}`, ""]
    : [`# ${title}`, ""];
  if (childDirs.length) {
    lines.push("## Directories", "");
    for (const child of childDirs) {
      const name = path.posix.basename(child);
      lines.push(`- [${name}](./${name}/index.md)`);
    }
    lines.push("");
  }
  if (directPages.length) {
    lines.push("## Pages", "");
    for (const page of directPages) {
      const name = path.posix.basename(page);
      let label = name.slice(0, -3);
      try {
        const parsed = parsePage(await readText(safeWikiPath(wikiRoot, page)));
        if (typeof parsed.frontmatter.title === "string" && parsed.frontmatter.title.trim()) {
          label = parsed.frontmatter.title.trim();
        }
      } catch {
        // keep filename
      }
      lines.push(`- [${label}](./${name})`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function formatIssue(issue: WikiValidationIssue): string {
  return issue.page ? `${issue.page}: ${issue.message}` : issue.message;
}
