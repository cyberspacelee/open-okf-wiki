import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillFileContent, SkillFileEntry, SkillInfo } from "@okf-wiki/contract";
import { SkillInfoSchema } from "@okf-wiki/contract";
import {
  listSkillFiles,
  readSkillFrontmatter,
  skillDigest,
} from "./skill-digest.js";
import { isPathInside, WORKSPACE_DIR_NAME } from "./workspace-store.js";

export const SKILL_FORK_DIR_NAME = "skill-fork";

/** Default relative location of a workspace skill fork. */
export function skillForkDir(rootPath: string): string {
  return path.join(path.resolve(rootPath), WORKSPACE_DIR_NAME, SKILL_FORK_DIR_NAME);
}

/**
 * Resolve which skill root a workspace uses.
 * Prefer explicit skillPath when it contains SKILL.md; else bundled.
 */
export async function resolveActiveSkillRoot(options: {
  workspaceRoot: string;
  skillPath?: string;
  bundledSkillPath: string;
}): Promise<{ path: string; kind: "bundled" | "fork" }> {
  const bundled = path.resolve(options.bundledSkillPath);
  if (typeof options.skillPath === "string" && options.skillPath.trim()) {
    const fork = path.resolve(options.skillPath.trim());
    try {
      await stat(path.join(fork, "SKILL.md"));
      return { path: fork, kind: "fork" };
    } catch {
      throw new Error(`skill path missing SKILL.md: ${fork}`);
    }
  }
  try {
    await stat(path.join(bundled, "SKILL.md"));
  } catch {
    throw new Error(`bundled skill missing SKILL.md: ${bundled}`);
  }
  return { path: bundled, kind: "bundled" };
}

/** Build operator-facing SkillInfo for Settings / APIs. */
export async function getSkillInfo(options: {
  workspaceRoot: string;
  skillPath?: string;
  bundledSkillPath: string;
}): Promise<SkillInfo> {
  const resolved = await resolveActiveSkillRoot(options);
  const digest = await skillDigest(resolved.path);
  const files = await listSkillFiles(resolved.path);
  const meta = await readSkillFrontmatter(resolved.path);
  return SkillInfoSchema.parse({
    path: resolved.path,
    kind: resolved.kind,
    digest,
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    files,
  });
}

/**
 * Copy bundled skill into `{root}/.okf-wiki/skill-fork` and return the fork path.
 * Overwrites an existing fork directory.
 */
export async function createSkillFork(options: {
  workspaceRoot: string;
  bundledSkillPath: string;
}): Promise<string> {
  const root = path.resolve(options.workspaceRoot);
  const bundled = path.resolve(options.bundledSkillPath);
  const dest = skillForkDir(root);

  if (!isPathInside(root, dest)) {
    throw new Error("skill fork path escapes workspace root");
  }
  try {
    await stat(path.join(bundled, "SKILL.md"));
  } catch {
    throw new Error(`bundled skill missing SKILL.md: ${bundled}`);
  }

  await mkdir(path.dirname(dest), { recursive: true });
  await cp(bundled, dest, {
    recursive: true,
    force: true,
    filter: (src) => {
      const base = path.basename(src);
      if (base === "node_modules" || base === "dist" || base === ".git") {
        return false;
      }
      return true;
    },
  });

  try {
    await stat(path.join(dest, "SKILL.md"));
  } catch {
    throw new Error(`skill fork copy failed (missing SKILL.md): ${dest}`);
  }
  return dest;
}

/** List files/directories immediately under a skill-relative path (fork or any skill root). */
export async function listSkillDir(
  skillRoot: string,
  relativePath = "",
): Promise<SkillFileEntry[]> {
  const root = path.resolve(skillRoot);
  const rel = normalizeSkillRelative(relativePath);
  const abs = rel ? path.join(root, ...rel.split("/")) : root;
  if (!isPathInside(root, abs)) {
    throw new Error("skill path escapes skill root");
  }
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new Error(`skill directory not found: ${rel || "."}`);
    }
    throw error;
  }
  const out: SkillFileEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push({ path: childRel, kind: "directory" });
    } else if (entry.isFile()) {
      out.push({ path: childRel, kind: "file" });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Read a UTF-8 skill file; path must stay inside skill root. */
export async function readSkillFile(
  skillRoot: string,
  relativePath: string,
): Promise<SkillFileContent> {
  const root = path.resolve(skillRoot);
  const rel = normalizeSkillRelative(relativePath);
  if (!rel) {
    throw new Error("skill file path is required");
  }
  const abs = path.join(root, ...rel.split("/"));
  if (!isPathInside(root, abs)) {
    throw new Error("skill path escapes skill root");
  }
  const body = await readFile(abs);
  if (body.byteLength > 1_048_576) {
    throw new Error(`skill file too large: ${rel}`);
  }
  return {
    path: rel,
    content: body.toString("utf8"),
    bytes: body.byteLength,
  };
}

/**
 * Write a skill file under a **fork** only. Caller must ensure skillRoot is the fork.
 * Creates parent directories. Refuses to write outside skillRoot.
 */
export async function writeSkillFile(
  skillRoot: string,
  relativePath: string,
  content: string,
): Promise<SkillFileContent> {
  const root = path.resolve(skillRoot);
  const rel = normalizeSkillRelative(relativePath);
  if (!rel) {
    throw new Error("skill file path is required");
  }
  if (!rel.endsWith(".md") && !rel.endsWith(".markdown")) {
    // Allow only markdown skill assets for the editor MVP.
    throw new Error("skill editor only writes markdown files");
  }
  const abs = path.join(root, ...rel.split("/"));
  if (!isPathInside(root, abs)) {
    throw new Error("skill path escapes skill root");
  }
  const buf = Buffer.from(content, "utf8");
  if (buf.byteLength > 1_048_576) {
    throw new Error(`skill file too large to write: ${rel}`);
  }
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buf);
  return { path: rel, content, bytes: buf.byteLength };
}

/** Reject empty, absolute, or `..` skill-relative paths; return POSIX form. */
export function normalizeSkillRelative(raw: string): string {
  const trimmed = (raw ?? "").trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") {
    return "";
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error("skill path must be skill-relative");
  }
  const parts = trimmed.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error("skill path must not contain ..");
  }
  return parts.join("/");
}
