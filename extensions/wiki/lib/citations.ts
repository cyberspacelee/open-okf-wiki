import path from "node:path";

/** OKF provenance: `sources[].resource` is a Workspace-relative path with an optional line range. */

const SOURCE_RESOURCE = /^([^#]+?)(?:#L([1-9]\d*)(?:-L([1-9]\d*))?)?$/;
const MARKDOWN_LINK = /(?<!!)\[[^\]\n]*\]\([ \t]*(?:<([^>\n]+)>|([^\s)]+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*\)/g;
const FOOTNOTE = /\[\^([^\]]+)\]/g;
const LEGACY_BODY_CITATION = /#L[1-9]\d*/;

export const SOURCE_RESOURCE_GRAMMAR = "Workspace-relative path or path#Lx[-Ly]";

export interface SourceCitation {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface CitationSource {
  scopeId: string;
  logicalPath: string;
}

export function parseSourceResource(value: string): Omit<SourceCitation, "id"> | undefined {
  const href = value.trim().replace(/^<|>$/g, "");
  if (!href || href.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  const match = SOURCE_RESOURCE.exec(href);
  if (!match) return undefined;
  const resourcePath = match[1];
  if (!resourcePath || resourcePath.startsWith("/") || resourcePath.includes("//")) return undefined;
  const segments = resourcePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  const startLine = match[2] ? Number(match[2]) : undefined;
  return startLine === undefined
    ? { path: resourcePath }
    : { path: resourcePath, startLine, endLine: Number(match[3] ?? match[2]) };
}

export function resolveSourceCitation(
  citation: Pick<SourceCitation, "path">,
  sources: readonly CitationSource[],
): { scopeId: string; sourcePath: string } | undefined {
  for (const source of [...sources].sort((left, right) => right.logicalPath.length - left.logicalPath.length)) {
    const logicalPath = source.logicalPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!logicalPath || logicalPath === ".") {
      return { scopeId: source.scopeId, sourcePath: citation.path };
    }
    if (citation.path.startsWith(`${logicalPath}/`)) {
      return { scopeId: source.scopeId, sourcePath: citation.path.slice(logicalPath.length + 1) };
    }
  }
  return undefined;
}

export function extractOkfSources(
  frontmatter: Record<string, unknown>,
  body: string,
  fileLines?: (citation: Omit<SourceCitation, "id">) => number | "missing" | undefined,
): { citations: SourceCitation[]; invalid: string[] } {
  const citations: SourceCitation[] = [];
  const invalid: string[] = [];
  const sources = frontmatter.sources;
  const byId = new Map<string, SourceCitation>();
  if (sources !== undefined) {
    if (!Array.isArray(sources) || sources.length === 0) {
      invalid.push("sources must be a non-empty list");
    } else {
      for (const entry of sources) {
        const parsed = parseSourceEntry(entry, fileLines);
        if ("error" in parsed) {
          invalid.push(parsed.error);
          continue;
        }
        if (byId.has(parsed.citation.id)) {
          invalid.push(`duplicate sources id ${parsed.citation.id}`);
          continue;
        }
        byId.set(parsed.citation.id, parsed.citation);
        citations.push(parsed.citation);
      }
    }
  }
  for (const id of footnoteIds(body)) {
    if (!byId.has(id)) invalid.push(`footnote [^${id}] has no sources[].id`);
  }
  MARKDOWN_LINK.lastIndex = 0;
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const href = (match[1] ?? match[2] ?? "").trim();
    if (sourceBodyHref(href)) {
      invalid.push(`${href} belongs in sources[].resource, not a body link`);
    }
  }
  return { citations, invalid };
}

export function wikiLinkTargets(page: string, body: string): string[] {
  const directory = path.posix.dirname(page);
  const targets: string[] = [];
  MARKDOWN_LINK.lastIndex = 0;
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const href = stripTrailingPunctuation((match[1] ?? match[2] ?? "").trim());
    if (!href || skipWikiHref(href)) continue;
    const resolved = resolveWikiHref(directory === "." ? "" : directory, href);
    if (resolved) targets.push(resolved);
  }
  return targets;
}

function parseSourceEntry(
  entry: unknown,
  fileLines?: (citation: Omit<SourceCitation, "id">) => number | "missing" | undefined,
): { citation: SourceCitation } | { error: string } {
  if (!isRecord(entry)) return { error: "sources entries must be mappings" };
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const resource = typeof entry.resource === "string" ? entry.resource.trim() : "";
  if (!id) return { error: "sources[].id is required" };
  if (!resource) return { error: `sources ${id} missing resource` };
  const locator = parseSourceResource(resource);
  if (!locator) return { error: `${resource} need ${SOURCE_RESOURCE_GRAMMAR}` };
  if (locator.startLine !== undefined && locator.endLine! < locator.startLine) return { error: `${resource} end<start` };
  const file = fileLines?.(locator);
  if (file === "missing") return { error: `${resource} missing` };
  if (typeof file === "number" && locator.endLine !== undefined && locator.endLine > file) {
    return { error: `${resource} ${locator.path.split("/").pop()}:${file} lines` };
  }
  return { citation: { id, ...locator } };
}

function footnoteIds(body: string): Set<string> {
  const ids = new Set<string>();
  FOOTNOTE.lastIndex = 0;
  for (const match of body.matchAll(FOOTNOTE)) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}

function resolveWikiHref(directory: string, href: string): string | undefined {
  const pathPart = href.split("#")[0];
  if (!pathPart || !pathPart.endsWith(".md")) return undefined;
  const relative = pathPart.startsWith("/")
    ? path.posix.normalize(pathPart.slice(1))
    : path.posix.normalize(directory ? `${directory}/${pathPart}` : pathPart);
  if (!relative || relative === "." || relative.startsWith("../") || path.posix.isAbsolute(relative)) return undefined;
  return relative;
}

function stripTrailingPunctuation(href: string): string {
  return href.replace(/[.,;:]+$/, "");
}

function skipWikiHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || href.startsWith("#") || href.startsWith("mailto:") || sourceBodyHref(href);
}

function sourceBodyHref(href: string): boolean {
  if (LEGACY_BODY_CITATION.test(href) && !href.startsWith("#")) return true;
  const parsed = parseSourceResource(href);
  return parsed !== undefined && !parsed.path.endsWith(".md");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
