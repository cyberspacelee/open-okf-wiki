import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "@okf-wiki/core";

/**
 * Resolve `relativePath` under `root`, rejecting absolute paths, empty roots,
 * and any traversal that escapes the root (e.g. `../etc/passwd`).
 *
 * This is a pure string check — it does not inspect the filesystem. Call
 * {@link assertContainedPathSafe} before reading/writing so symlink components
 * cannot escape the root.
 */
export function resolveContainedPath(root: string, relativePath: string): string {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("root must be a non-empty absolute path");
  }
  const resolvedRoot = path.resolve(root);

  if (typeof relativePath !== "string") {
    throw new Error("path must be a string");
  }

  const trimmed = relativePath.trim();
  // Empty / "." means the root itself.
  if (trimmed === "" || trimmed === ".") {
    if (!isPathInside(resolvedRoot, resolvedRoot)) {
      throw new Error("invalid root path");
    }
    return resolvedRoot;
  }

  if (path.isAbsolute(trimmed)) {
    throw new Error("absolute paths are not allowed");
  }

  // Reject Windows drive-like and UNC fragments early.
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith("\\\\")) {
    throw new Error("absolute paths are not allowed");
  }

  const segments = trimmed.split(/[/\\]+/);
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error("path escapes root: '..' segments are not allowed");
    }
  }

  const resolved = path.resolve(resolvedRoot, trimmed);
  if (!isPathInside(resolvedRoot, resolved)) {
    throw new Error(`path escapes root: ${relativePath}`);
  }
  return resolved;
}

/**
 * After string resolution, walk from root to leaf with `lstat` (no follow).
 * Rejects any symlink component so contained ops cannot escape via links.
 * When the leaf exists, also ensures realpath(leaf) stays inside realpath(root).
 */
export async function assertContainedPathSafe(
  root: string,
  absolutePath: string,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absolutePath);

  if (!isPathInside(resolvedRoot, resolved)) {
    throw new Error(`path escapes root: ${absolutePath}`);
  }

  const rel = path.relative(resolvedRoot, resolved);
  const segments = rel === "" ? [] : rel.split(path.sep).filter((s) => s.length > 0);

  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // Path does not exist yet (e.g. write creating parents) — remaining
      // segments cannot be symlinks. Existing ancestors were already checked.
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      const shown = path.relative(resolvedRoot, current) || ".";
      throw new Error(`path contains symlink component: ${shown}`);
    }
  }

  // Extra belt-and-suspenders: final realpath must still be inside root realpath.
  try {
    const realRoot = await realpath(resolvedRoot);
    const realTarget = await realpath(resolved);
    if (!isPathInside(realRoot, realTarget)) {
      throw new Error(`path escapes root after realpath: ${absolutePath}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/** Convert an absolute path under root to a POSIX-style relative path. */
export function toPosixRelative(root: string, absolutePath: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(absolutePath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path is outside root");
  }
  return rel.split(path.sep).join("/") || ".";
}
