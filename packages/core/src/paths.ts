import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * True if `child` is `parent` or a path strictly inside it.
 * Path containment primitive for the Run Boundary (not workspace-specific).
 */
export function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (resolvedParent === resolvedChild) {
    return true;
  }
  const rel = path.relative(resolvedParent, resolvedChild);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Reject empty and relative paths. Returns the trimmed absolute path as given
 * (does not resolve `.` / `..` segments — callers may still `path.resolve`).
 */
export function assertAbsolutePath(raw: string, label: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  const trimmed = raw.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return trimmed;
}

/**
 * Walk every path component from filesystem root to `target` with lstat
 * (no follow). Rejects any symlink component so publication cannot be
 * redirected via host reparse points (ADR 0017 simplified MVP).
 */
export async function assertNoSymlinkComponents(target: string, label: string): Promise<void> {
  const resolved = path.resolve(target);
  const parts = resolved.split(path.sep).filter((p) => p.length > 0);

  // Rebuild from root. path.parse root is "/" (POSIX) or "C:\\" (Windows).
  let current = path.parse(resolved).root;

  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // Missing leaf is OK for publicationPath (we create it). Ancestors that
      // do not exist are not symlink components.
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink component: ${current}`);
    }
  }
}

/**
 * Resolve a path to an absolute existing directory.
 * Rejects empty/whitespace paths, missing paths, and non-directories.
 */
export async function resolveExistingDir(rawPath: string): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }

  const resolved = path.resolve(rawPath.trim());
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`path does not exist: ${resolved}`);
  }

  if (!info.isDirectory()) {
    throw new Error(`path is not a directory: ${resolved}`);
  }

  return resolved;
}

/**
 * Resolve `relativePath` under `root`, rejecting absolute paths, empty roots,
 * and any traversal that escapes the root (e.g. `../etc/passwd`).
 *
 * Pure string check — call {@link assertContainedPathSafe} before I/O.
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
  if (trimmed === "" || trimmed === ".") {
    if (!isPathInside(resolvedRoot, resolvedRoot)) {
      throw new Error("invalid root path");
    }
    return resolvedRoot;
  }

  if (path.isAbsolute(trimmed)) {
    throw new Error("absolute paths are not allowed");
  }

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
 * After string resolution, walk root→leaf with `lstat` (no follow).
 * Rejects symlink components so contained ops cannot escape via links.
 */
export async function assertContainedPathSafe(root: string, absolutePath: string): Promise<void> {
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
