import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseSourceCitations,
  type SourceRootMap,
  sourceRootMapFromSources,
  validateCitationFormat,
  validateCitationResolve,
} from "./citations.js";
import { assertAbsolutePath, assertNoSymlinkComponents } from "./paths.js";
import { isReservedWikiPath, parseWikiFrontmatter, scanWikiTree } from "./wiki-tree.js";

/** Soft caps for mechanical publication validation. */
export const WIKI_VALIDATE_MAX_FILES = 500;
export const WIKI_VALIDATE_MAX_FILE_BYTES = 1_000_000;

export type ValidateWikiOptions = {
  /**
   * Pinned Repository Snapshot roots for Source Citation resolve (ADR 0008).
   * When omitted, only citation *format* is checked (and pages need ≥1 citation).
   */
  sources?: Array<{ id: string; path: string }>;
  /**
   * When true (default), every `.md` page must contain at least one Source Citation.
   */
  requireCitations?: boolean;
};

export type ValidateWikiResult = {
  ok: boolean;
  errors: string[];
  /** Count of `.md` pages found when walk succeeded far enough. */
  pageCount?: number;
  /** Total files walked (md + non-md), when available. */
  fileCount?: number;
  /** Total Source Citations found across pages. */
  citationCount?: number;
};

/**
 * Mechanically validate a staging / publication-candidate Wiki tree before publish.
 *
 * Checks:
 * - Absolute path, real directory, no symlink components
 * - At least one `.md` file
 * - Concept `.md` pages: YAML frontmatter with non-empty `type` + `title` (OKF + product)
 * - Reserved `index.md` / `log.md`: exempt from concept frontmatter and citations
 * - Source Citations on concept pages (format + optional Snapshot resolve) — ADR 0008
 * - No symlinks inside the tree
 * - Soft caps: ≤ {@link WIKI_VALIDATE_MAX_FILES} files, each ≤ 1MB
 */
export async function validateWikiTree(
  dir: string,
  options: ValidateWikiOptions = {},
): Promise<ValidateWikiResult> {
  const errors: string[] = [];
  // Citations required when Snapshot sources are supplied (publish path) unless
  // explicitly disabled. Pure frontmatter/caps checks omit sources.
  // Reserved OKF files (index.md / log.md) never require citations.
  const requireCitations = options.requireCitations ?? Boolean(options.sources?.length);
  const sourceMap: SourceRootMap | undefined = options.sources
    ? sourceRootMapFromSources(options.sources)
    : undefined;
  let citationCount = 0;

  let resolved: string;
  try {
    resolved = path.resolve(assertAbsolutePath(dir, "wikiDir"));
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  let rootInfo;
  try {
    rootInfo = await lstat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { ok: false, errors: [`wiki directory does not exist: ${resolved}`] };
    }
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  if (rootInfo.isSymbolicLink()) {
    return { ok: false, errors: [`wikiDir is a symlink: ${resolved}`] };
  }
  if (!rootInfo.isDirectory()) {
    return { ok: false, errors: [`wikiDir is not a directory: ${resolved}`] };
  }

  try {
    await assertNoSymlinkComponents(resolved, "wikiDir");
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const scan = await scanWikiTree(resolved);
  errors.push(...scan.issues.map((issue) => issue.message));
  const fileCount = scan.files.length;
  const mdFiles = scan.files
    .filter((file) => file.relativePath.toLowerCase().endsWith(".md"))
    .map((file) => ({ absPath: file.absolutePath, relPath: file.relativePath }));
  const pageCount = mdFiles.length;

  if (fileCount > WIKI_VALIDATE_MAX_FILES) {
    errors.push(`wiki tree has ${fileCount} files (max ${WIKI_VALIDATE_MAX_FILES})`);
  }

  if (pageCount < 1) {
    errors.push(`wiki tree has no markdown pages: ${resolved}`);
  }

  for (const md of mdFiles) {
    let size: number;
    try {
      // lstat: never follow a symlink swapped in after the walk (path escape).
      const info = await lstat(md.absPath);
      if (info.isSymbolicLink()) {
        errors.push(`symlink not allowed in wiki tree: ${md.relPath}`);
        continue;
      }
      if (!info.isFile()) {
        errors.push(`not a regular file: ${md.relPath}`);
        continue;
      }
      size = info.size;
    } catch (error) {
      errors.push(
        `cannot stat ${md.relPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (size > WIKI_VALIDATE_MAX_FILE_BYTES) {
      errors.push(
        `${md.relPath} exceeds max file size (${size} > ${WIKI_VALIDATE_MAX_FILE_BYTES} bytes)`,
      );
      continue;
    }
    let content: string;
    try {
      content = await readFile(md.absPath, "utf8");
    } catch (error) {
      errors.push(
        `cannot read ${md.relPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const reserved = isReservedWikiPath(md.relPath);
    if (reserved) {
      // OKF reserved listing/history files: no concept frontmatter or citations.
      continue;
    }
    const frontmatter = parseWikiFrontmatter(content);
    const hasType = Boolean(frontmatter?.values.type);
    const hasTitle = Boolean(frontmatter?.values.title);
    if (!hasType || !hasTitle) {
      if (!hasType && !hasTitle) {
        errors.push(`${md.relPath}: missing YAML frontmatter with non-empty type and title`);
      } else if (!hasType) {
        errors.push(`${md.relPath}: missing YAML frontmatter with non-empty type`);
      } else {
        errors.push(`${md.relPath}: missing YAML frontmatter with non-empty title`);
      }
    }
    const citations = parseSourceCitations(content);
    citationCount += citations.length;
    if (requireCitations && citations.length === 0) {
      errors.push(`${md.relPath}: missing Source Citation ([Source](repo:…#L…))`);
    }
    errors.push(...validateCitationFormat(citations, md.relPath));
    if (sourceMap) {
      errors.push(...(await validateCitationResolve(citations, md.relPath, sourceMap)));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    pageCount,
    fileCount,
    citationCount,
  };
}
