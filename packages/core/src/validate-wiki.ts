import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertAbsolutePath, assertNoSymlinkComponents } from "./paths.js";

/** Soft caps for mechanical publication validation. */
export const WIKI_VALIDATE_MAX_FILES = 500;
export const WIKI_VALIDATE_MAX_FILE_BYTES = 1_000_000;

export type ValidateWikiResult = {
  ok: boolean;
  errors: string[];
  /** Count of `.md` pages found when walk succeeded far enough. */
  pageCount?: number;
  /** Total files walked (md + non-md), when available. */
  fileCount?: number;
};

/**
 * Minimal frontmatter check: file starts with `---` and a YAML block that
 * contains a non-empty `title:` key (simple regex — not a full YAML parser).
 */
export function hasNonEmptyTitleFrontmatter(content: string): boolean {
  const trimmed = content.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return false;
  }
  // First line must be exactly --- (optional trailing spaces)
  const firstNl = trimmed.indexOf("\n");
  if (firstNl < 0) {
    return false;
  }
  if (trimmed.slice(0, firstNl).trim() !== "---") {
    return false;
  }
  const rest = trimmed.slice(firstNl + 1);
  const close = rest.search(/^---\s*$/m);
  if (close < 0) {
    return false;
  }
  const front = rest.slice(0, close);
  // title: value  — value must be non-empty after optional quotes
  const match = front.match(/^\s*title\s*:\s*(.+?)\s*$/m);
  if (!match) {
    return false;
  }
  const raw = match[1]!.trim();
  // Strip surrounding single/double quotes if present
  const unquoted =
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1).trim()
      : raw;
  return unquoted.length > 0;
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
 * - Each `.md` starts with YAML frontmatter containing non-empty `title:`
 * - No symlinks inside the tree
 * - Soft caps: ≤ {@link WIKI_VALIDATE_MAX_FILES} files, each ≤ 1MB
 */
export async function validateWikiTree(dir: string): Promise<ValidateWikiResult> {
  const errors: string[] = [];

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
    if (!hasNonEmptyTitleFrontmatter(content)) {
      errors.push(
        `${md.relPath}: missing YAML frontmatter with non-empty title`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    pageCount,
    fileCount,
  };
}
