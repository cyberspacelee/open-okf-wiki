const WIKI_SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_WIKI_PAGE_NAMES = new Set(["index.md", "log.md"]);
const RESERVED_KNOWLEDGE_DIRECTORIES = new Set(["wiki", "source", "sources", "self"]);
export const REPO_STRIP = "repos";
export const IMPLICIT_SOURCE_SCOPE_ID = "self";

export function isImplicitPinPath(logicalPath: string): boolean {
  return logicalPath === "." || logicalPath === "";
}

export function isWikiSourceDirectoryName(value: string): boolean {
  return SOURCE_NAME.test(value);
}

/** Markdown files owned by the Wiki lifecycle rather than the concept manifest. */
export function isReservedWikiPagePath(value: unknown): value is string {
  return typeof value === "string" && RESERVED_WIKI_PAGE_NAMES.has(value.split("/").at(-1) ?? "");
}

/** Domain and concept slugs: lowercase ASCII, hyphenated. */
export function isWikiTaxonomySlug(value: string): boolean {
  return WIKI_SLUG_SEGMENT.test(value) && !RESERVED_KNOWLEDGE_DIRECTORIES.has(value) && value !== REPO_STRIP;
}

export type WikiPathKind = "root" | "repo" | "domain" | "concept";

/** Classify a safe Wiki page path. Unsafe paths return undefined. */
export function wikiPathKind(relative: string): WikiPathKind | undefined {
  if (!isSafeWikiPagePath(relative)) return undefined;
  const directories = relative.split("/").slice(0, -1);
  if (directories.length === 0) return "root";
  if (directories[0] === REPO_STRIP) return "repo";
  if (directories.length === 1) return "domain";
  return "concept";
}

/**
 * Wiki page paths are POSIX-relative kebab filenames.
 * Knowledge lives at wiki root, `<domain>/`, or `<domain>/<concept>/`.
 * Pin-identity pages live at `repos/<scopeId>/`.
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
  if (directories[0] === REPO_STRIP) {
    return directories.length === 2 && isWikiSourceDirectoryName(directories[1]!);
  }
  return directories.length <= 2 && directories.every((segment) => isWikiTaxonomySlug(segment));
}
