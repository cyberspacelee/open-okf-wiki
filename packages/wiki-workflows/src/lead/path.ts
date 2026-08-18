const WIKI_SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_WIKI_PAGE_NAMES = new Set(["index.md", "log.md"]);

/** Markdown files owned by the Wiki lifecycle rather than the concept manifest. */
export function isReservedWikiPagePath(value: unknown): value is string {
  return typeof value === "string" && RESERVED_WIKI_PAGE_NAMES.has(value.split("/").at(-1) ?? "");
}

/** First Wiki path segment: original Source directory name, not a lowercase slug. */
export function isWikiSourceSegment(value: string): boolean {
  return SOURCE_NAME.test(value);
}

/** Domain and concept slugs: lowercase ASCII, hyphenated. */
export function isWikiTaxonomySlug(value: string): boolean {
  return WIKI_SLUG_SEGMENT.test(value);
}

/**
 * Wiki page paths are POSIX-relative. The first directory is the original
 * Source folder name; remaining segments and the filename stay ASCII slugs.
 */
export function isSafeWikiPagePath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\\") || value.startsWith("/")) return false;
  const segments = value.split("/");
  if (segments[0] === "wiki" || segments.some((segment) => !segment)) return false;

  const filename = segments.at(-1)!;
  if (!filename.endsWith(".md") || isReservedWikiPagePath(value)) return false;
  const pageSlug = filename.slice(0, -3);
  if (!WIKI_SLUG_SEGMENT.test(pageSlug)) return false;
  const directories = segments.slice(0, -1);
  if (directories.length === 0) return true;
  return isWikiSourceSegment(directories[0])
    && directories.slice(1).every((segment) => WIKI_SLUG_SEGMENT.test(segment));
}
