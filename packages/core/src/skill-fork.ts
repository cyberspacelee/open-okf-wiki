import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SkillFileContent,
  SkillFileEntry,
  SkillInfo,
  SkillSourceKind,
} from "@okf-wiki/contract";
import { SkillInfoSchema } from "@okf-wiki/contract";
import { isUnderWorkspaceSkills, workspaceProducerSkillPath } from "./product-home.js";
import { listSkillFiles, readSkillFrontmatter, skillDigest } from "./skill-digest.js";
import { isPathInside } from "./workspace-store.js";

/**
 * Default workspace Producer Skill directory
 * (`{root}/.agents/skills/repository-wiki-producer`).
 */
export function skillForkDir(rootPath: string): string {
  return workspaceProducerSkillPath(rootPath);
}

/** Build operator-facing SkillInfo for Settings / APIs. */
export async function getSkillInfo(options: {
  path: string;
  kind: SkillSourceKind;
}): Promise<SkillInfo> {
  const root = path.resolve(options.path);
  const digest = await skillDigest(root);
  const files = await listSkillFiles(root);
  const meta = await readSkillFrontmatter(root);
  return SkillInfoSchema.parse({
    path: root,
    kind: options.kind,
    digest,
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    files,
  });
}

/**
 * Copy a skill tree into `{root}/.agents/skills/repository-wiki-producer`
 * and return that path. Overwrites an existing project skill directory.
 */
export async function createSkillFork(options: {
  workspaceRoot: string;
  /** Source skill root (home or package) to copy from. */
  sourceSkillPath: string;
}): Promise<string> {
  const root = path.resolve(options.workspaceRoot);
  const rawSource = options.sourceSkillPath.trim();
  if (!rawSource) {
    throw new Error("sourceSkillPath is required");
  }
  const source = path.resolve(rawSource);
  const dest = skillForkDir(root);

  if (!isPathInside(root, dest) || !isUnderWorkspaceSkills(root, dest)) {
    throw new Error("skill fork path escapes workspace .agents/skills");
  }
  try {
    await stat(path.join(source, "SKILL.md"));
  } catch {
    throw new Error(`source skill missing SKILL.md: ${source}`);
  }

  await mkdir(path.dirname(dest), { recursive: true });
  await cp(source, dest, {
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

/**
 * Copy package (or any source) skill tree into a destination directory.
 * Used to seed `~/.agents/skills/<name>`. Does not overwrite an existing
 * skill with SKILL.md unless `force` is true.
 */
export async function copySkillTree(options: {
  sourceSkillPath: string;
  destSkillPath: string;
  force?: boolean;
}): Promise<{ path: string; seeded: boolean }> {
  const source = path.resolve(options.sourceSkillPath);
  const dest = path.resolve(options.destSkillPath);
  try {
    await stat(path.join(source, "SKILL.md"));
  } catch {
    throw new Error(`source skill missing SKILL.md: ${source}`);
  }

  if (!options.force) {
    try {
      await stat(path.join(dest, "SKILL.md"));
      return { path: dest, seeded: false };
    } catch {
      // missing — seed
    }
  }

  await mkdir(path.dirname(dest), { recursive: true });
  await cp(source, dest, {
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
    throw new Error(`skill copy failed (missing SKILL.md): ${dest}`);
  }
  return { path: dest, seeded: true };
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
