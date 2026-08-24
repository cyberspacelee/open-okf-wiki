import path from "node:path";

/** OKF provenance: `sources[].resource` is a Workspace-relative path with an optional line range, or a Catalog table. */

const SOURCE_RESOURCE = /^([^#]+?)(?:#L([1-9]\d*)(?:-L([1-9]\d*))?)?$/;
const CATALOG_RESOURCE = /^catalog:([A-Za-z_][A-Za-z0-9_$]*)$/;
const MARKDOWN_LINK = /(?<!!)\[[^\]\n]*\]\([ \t]*(?:<([^>\n]+)>|([^\s)]+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*\)/g;
const FOOTNOTE_REFERENCE = /\[\^([^\]]+)\](?!:)/g;
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]]+)\]:/gm;
const LEGACY_BODY_CITATION = /#L[1-9]\d*/;

const SOURCE_RESOURCE_GRAMMAR = "Workspace-relative path optionally followed by #Lx[-Ly], or catalog:table";

export interface SourceCitation {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
  catalogTable?: string;
}

export interface CitationSource {
  scopeId: string;
  logicalPath: string;
}

export function formatWriterCitationContract(
  sources: readonly CitationSource[],
  catalogAvailable: boolean,
): string {
  const roots = sources.map((source) => source.logicalPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""));
  const implicit = roots.length === 1 && (!roots[0] || roots[0] === ".");
  const sourceScope = implicit
    ? "The pinned Source is the Workspace root: use its path directly, such as `src/main.ts`, without a `self/` prefix."
    : roots.length
      ? `Pinned Source roots are ${roots.map((root) => `\`${root}/\``).join(", ")}; a file resource includes the matching root prefix.`
      : "Copy each file resource from an opened Workspace-relative source locator.";
  return [
    "## Citation contract",
    "",
    "Use this shape on every Candidate page:",
    "",
    "```yaml",
    "sources:",
    "  - id: source-id",
    "    resource: path/from/workspace/root",
    "    title: Human-readable source",
    "```",
    "",
    "```markdown",
    "A claim supported by that source.[^source-id]",
    "",
    "[^source-id]: Human-readable source",
    "```",
    "",
    "Each `sources` entry requires a unique stable `id` and a `resource`; `title` is optional. Every body `[^id]` has the same `sources[].id` and a later `[^id]: ...` footnote definition. Put source evidence in `sources`, and use ordinary Markdown links only for Wiki pages.",
    "A file `resource` is a POSIX Workspace-relative path. Its line suffix is optional: `path`, `path#L12`, and `path#L12-L18` are valid forms. Every cited file must be read successfully; when a range is supplied, the read must cover the complete range.",
    sourceScope,
    "Use paths without a leading slash, `./`, `../`, empty segments, or backslashes.",
    ...(catalogAvailable
      ? ["A Catalog table may use `catalog:table`, for example `catalog:orders`. Use `db_describe` when the page needs columns, keys, or constraints."]
      : []),
    "",
  ].join("\n");
}

export function parseSourceResource(value: string): Omit<SourceCitation, "id"> | undefined {
  const href = value.trim().replace(/^<|>$/g, "");
  if (!href || href.includes("\\")) return undefined;
  const catalog = CATALOG_RESOURCE.exec(href);
  if (catalog) return { path: href, catalogTable: catalog[1]! };
  if (href.startsWith("catalog:") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
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
  if (citation.path.startsWith("catalog:")) return undefined;
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
  const references = footnoteIds(body, FOOTNOTE_REFERENCE);
  const definitions = footnoteIds(body, FOOTNOTE_DEFINITION);
  for (const id of new Set([...references, ...definitions])) {
    if (!byId.has(id)) invalid.push(`footnote [^${id}] has no sources[].id`);
  }
  for (const id of references) {
    if (!definitions.has(id)) invalid.push(`footnote [^${id}] is missing definition [^${id}]: ...`);
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
  if (locator.catalogTable) return { citation: { id, ...locator } };
  const file = fileLines?.(locator);
  if (file === "missing") return { error: `${resource} missing` };
  if (typeof file === "number" && locator.endLine !== undefined && locator.endLine > file) {
    return { error: `${resource} ${locator.path.split("/").pop()}:${file} lines` };
  }
  return { citation: { id, ...locator } };
}

function footnoteIds(body: string, pattern: RegExp): Set<string> {
  const ids = new Set<string>();
  pattern.lastIndex = 0;
  for (const match of body.matchAll(pattern)) {
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
