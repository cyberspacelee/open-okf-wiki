const WIKI_SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_WIKI_PAGE_NAMES = new Set(["index.md", "log.md"]);
const RESERVED_KNOWLEDGE_DIRECTORIES = new Set(["wiki", "source", "sources", "self", "repos"]);
export const IMPLICIT_SOURCE_SCOPE_ID = "self";

export function isImplicitPinPath(logicalPath: string): boolean {
  return logicalPath === "." || logicalPath === "";
}

export function isWikiSourceDirectoryName(value: string): boolean {
  return SOURCE_NAME.test(value);
}

function isWikiRepositoryDirectoryName(value: string): boolean {
  return isWikiSourceDirectoryName(value) && !RESERVED_KNOWLEDGE_DIRECTORIES.has(value);
}

/** Markdown files owned by the Wiki lifecycle rather than the concept manifest. */
export function isReservedWikiPagePath(value: unknown): value is string {
  return typeof value === "string" && RESERVED_WIKI_PAGE_NAMES.has(value.split("/").at(-1) ?? "");
}

/** Domain and concept slugs: lowercase ASCII, hyphenated. */
export function isWikiTaxonomySlug(value: string): boolean {
  return WIKI_SLUG_SEGMENT.test(value) && !RESERVED_KNOWLEDGE_DIRECTORIES.has(value);
}

export type WikiPathKind = "root" | "repo" | "domain" | "concept";

/** Classify a safe Wiki page path. Unsafe paths return undefined. */
export function wikiPathKind(
  relative: string,
  repositoryIds: ReadonlySet<string> = new Set(),
): WikiPathKind | undefined {
  if (!isSafeWikiPagePath(relative)) return undefined;
  const directories = relative.split("/").slice(0, -1);
  if (directories.length === 0) return "root";
  if (repositoryIds.has(directories[0]!)) {
    if (directories.length === 1) return "repo";
    if (directories.length === 2) return "domain";
    if (directories.length === 3) return "concept";
    return undefined;
  }
  if (directories.length === 1) return "domain";
  if (directories.length === 2) return "concept";
  return undefined;
}

/**
 * Wiki page paths are POSIX-relative kebab filenames.
 * Implicit Workspace knowledge lives at `<domain>/<concept>/`. Explicit
 * Workspace knowledge lives at `<scopeId>/<domain>/<concept>/`.
 */
export function isSafeWikiPagePath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\\") || value.startsWith("/")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => !segment)) return false;

  const filename = segments.at(-1)!;
  if (!filename.endsWith(".md") || isReservedWikiPagePath(value)) return false;
  const pageSlug = filename.slice(0, -3);
  if (!WIKI_SLUG_SEGMENT.test(pageSlug)) return false;
  const directories = segments.slice(0, -1);
  if (directories.length === 0) return true;
  const implicitShape = directories.length <= 2
    && directories.every((segment) => isWikiTaxonomySlug(segment));
  const repositoryShape = directories.length <= 3
    && isWikiRepositoryDirectoryName(directories[0]!)
    && directories.slice(1).every((segment) => isWikiTaxonomySlug(segment));
  return implicitShape || repositoryShape;
}
