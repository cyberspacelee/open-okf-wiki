import { lstat, stat } from "node:fs/promises";
import path from "node:path";

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
