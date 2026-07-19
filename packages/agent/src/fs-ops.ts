import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertContainedPathSafe,
  resolveContainedPath,
  toPosixRelative,
} from "./path-policy.js";

export type ListEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
};

export async function listDirContained(
  root: string,
  relativePath = "",
): Promise<ListEntry[]> {
  const dir = resolveContainedPath(root, relativePath);
  await assertContainedPathSafe(root, dir);
  const names = await readdir(dir);
  names.sort((a, b) => a.localeCompare(b));
  const entries: ListEntry[] = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    // Skip anything that somehow escapes (symlinks) — only report contained.
    let rel: string;
    try {
      rel = toPosixRelative(root, abs);
      resolveContainedPath(root, rel);
    } catch {
      continue;
    }
    // Do not follow or expose symlink entries (containment boundary).
    let type: ListEntry["type"] = "other";
    try {
      const info = await lstat(abs);
      if (info.isSymbolicLink()) {
        continue;
      }
      if (info.isDirectory()) {
        type = "directory";
      } else if (info.isFile()) {
        type = "file";
      }
    } catch {
      type = "other";
    }
    entries.push({
      name,
      path: rel,
      type,
    });
  }
  return entries;
}

export async function readFileContained(
  root: string,
  relativePath: string,
  options?: { maxBytes?: number },
): Promise<{ path: string; content: string }> {
  const abs = resolveContainedPath(root, relativePath);
  await assertContainedPathSafe(root, abs);
  const info = await lstat(abs);
  if (info.isSymbolicLink()) {
    throw new Error(`path contains symlink component: ${relativePath}`);
  }
  if (!info.isFile()) {
    throw new Error(`not a file: ${relativePath}`);
  }
  const maxBytes = options?.maxBytes ?? 512_000;
  if (info.size > maxBytes) {
    throw new Error(`file too large (${info.size} bytes; max ${maxBytes})`);
  }
  const content = await readFile(abs, "utf8");
  return { path: toPosixRelative(root, abs), content };
}

export async function writeFileContained(
  root: string,
  relativePath: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  if (typeof content !== "string") {
    throw new Error("content must be a string");
  }
  const abs = resolveContainedPath(root, relativePath);
  if (abs === path.resolve(root)) {
    throw new Error("cannot write the root directory itself");
  }
  await assertContainedPathSafe(root, abs);
  await mkdir(path.dirname(abs), { recursive: true });
  // Re-check after mkdir: ensure no symlink appeared in parents.
  await assertContainedPathSafe(root, abs);
  const body = content.endsWith("\n") ? content : `${content}\n`;
  await writeFile(abs, body, "utf8");
  return { path: toPosixRelative(root, abs), bytes: Buffer.byteLength(body, "utf8") };
}

/** Recursively collect `.md` files under root as POSIX-relative paths. */
export async function listMarkdownPages(root: string): Promise<string[]> {
  const pages: string[] = [];

  async function walk(rel: string): Promise<void> {
    const entries = await listDirContained(root, rel);
    for (const entry of entries) {
      if (entry.type === "directory") {
        await walk(entry.path);
      } else if (entry.type === "file" && entry.name.endsWith(".md")) {
        pages.push(entry.path);
      }
    }
  }

  try {
    await walk("");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
  pages.sort((a, b) => a.localeCompare(b));
  return pages;
}
