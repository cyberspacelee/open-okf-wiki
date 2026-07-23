import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseSourceCitations,
  sourceRootMapFromSources,
  validateCitationFormat,
  validateCitationResolve,
  type SourceRootMap,
} from "./citations.js";
import { assertAbsolutePath, assertNoSymlinkComponents } from "./paths.js";

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

/** Reserved OKF filenames (SPEC §3.1) — listing/history, not concept pages. */
export const RESERVED_WIKI_BASENAMES = new Set(["index.md", "log.md"]);

/**
 * True when the relative path is an OKF reserved file at any directory level
 * (`index.md` / `log.md`). Reserved files are not concept documents.
 */
export function isReservedWikiPath(relPath: string): boolean {
  const base = relPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  return RESERVED_WIKI_BASENAMES.has(base);
}

/**
 * Extract a YAML frontmatter block body (between the opening/closing `---`),
 * or null when the file does not start with a well-formed frontmatter fence.
 */
export function extractYamlFrontmatterBody(content: string): string | null {
  const trimmed = content.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return null;
  }
  const firstNl = trimmed.indexOf("\n");
  if (firstNl < 0) {
    return null;
  }
  if (trimmed.slice(0, firstNl).trim() !== "---") {
    return null;
  }
  const rest = trimmed.slice(firstNl + 1);
  const close = rest.search(/^---\s*$/m);
  if (close < 0) {
    return null;
  }
  return rest.slice(0, close);
}

function unquoteYamlScalar(raw: string): string {
  const t = raw.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function frontmatterScalar(
  front: string,
  key: string,
): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m");
  const match = front.match(re);
  if (!match) return undefined;
  const value = unquoteYamlScalar(match[1]!);
  return value.length > 0 ? value : undefined;
}

/**
 * Minimal frontmatter check: file starts with `---` and a YAML block that
 * contains a non-empty `title:` key (simple regex — not a full YAML parser).
 */
export function hasNonEmptyTitleFrontmatter(content: string): boolean {
  const front = extractYamlFrontmatterBody(content);
  if (front === null) return false;
  return frontmatterScalar(front, "title") !== undefined;
}

/**
 * OKF v0.1 hard rule: concept pages need a non-empty `type` field.
 */
export function hasNonEmptyTypeFrontmatter(content: string): boolean {
  const front = extractYamlFrontmatterBody(content);
  if (front === null) return false;
  return frontmatterScalar(front, "type") !== undefined;
}

/**
 * Concept page frontmatter: parseable YAML with non-empty `type` and `title`
 * (product keeps `title` for UI; OKF requires `type`).
 */
export function hasConceptFrontmatter(content: string): boolean {
  return hasNonEmptyTypeFrontmatter(content) && hasNonEmptyTitleFrontmatter(content);
}

type WalkEntry = {
  absPath: string;
  relPath: string;
  isFile: boolean;
  isDirectory: boolean;
};

/**
 * Depth-first walk that never follows symlinks. Rejects symlink entries as errors
 * rather than traversing them (path escape / reparse-point safety).
 */
async function walkTreeNoFollow(
  root: string,
  onEntry: (entry: WalkEntry) => void | Promise<void>,
  errors: string[],
): Promise<void> {
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`cannot read directory ${rel || "."}: ${message}`);
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = rel ? path.join(rel, entry.name) : entry.name;

      // Prefer lstat so we never follow reparse points.
      let info;
      try {
        info = await lstat(absPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`cannot stat ${relPath}: ${message}`);
        continue;
      }

      if (info.isSymbolicLink()) {
        errors.push(`symlink not allowed in wiki tree: ${relPath}`);
        continue;
      }

      if (info.isDirectory()) {
        await onEntry({ absPath, relPath, isFile: false, isDirectory: true });
        await walk(absPath, relPath);
      } else if (info.isFile()) {
        await onEntry({ absPath, relPath, isFile: true, isDirectory: false });
      }
      // Ignore other node types (sockets, devices, etc.)
    }
  }

  await walk(root, "");
}

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
  const requireCitations =
    options.requireCitations ?? Boolean(options.sources?.length);
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

  let fileCount = 0;
  let pageCount = 0;
  const mdFiles: { absPath: string; relPath: string }[] = [];

  await walkTreeNoFollow(
    resolved,
    async (entry) => {
      if (!entry.isFile) {
        return;
      }
      fileCount += 1;
      if (fileCount > WIKI_VALIDATE_MAX_FILES) {
        // Keep counting pages for diagnostics but only emit the cap error once.
        return;
      }
      if (entry.relPath.toLowerCase().endsWith(".md")) {
        pageCount += 1;
        mdFiles.push({ absPath: entry.absPath, relPath: entry.relPath });
      }
    },
    errors,
  );

  if (fileCount > WIKI_VALIDATE_MAX_FILES) {
    errors.push(
      `wiki tree has ${fileCount} files (max ${WIKI_VALIDATE_MAX_FILES})`,
    );
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
    if (!hasConceptFrontmatter(content)) {
      if (!hasNonEmptyTypeFrontmatter(content) && !hasNonEmptyTitleFrontmatter(content)) {
        errors.push(
          `${md.relPath}: missing YAML frontmatter with non-empty type and title`,
        );
      } else if (!hasNonEmptyTypeFrontmatter(content)) {
        errors.push(
          `${md.relPath}: missing YAML frontmatter with non-empty type`,
        );
      } else {
        errors.push(
          `${md.relPath}: missing YAML frontmatter with non-empty title`,
        );
      }
    }
    const citations = parseSourceCitations(content);
    citationCount += citations.length;
    if (requireCitations && citations.length === 0) {
      errors.push(
        `${md.relPath}: missing Source Citation ([Source](repo:…#L…))`,
      );
    }
    errors.push(...validateCitationFormat(citations, md.relPath));
    if (sourceMap) {
      errors.push(
        ...(await validateCitationResolve(citations, md.relPath, sourceMap)),
      );
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
