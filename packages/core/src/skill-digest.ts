import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertOrdinaryTree, makeTreeReadOnly, makeTreeWritable } from "./immutable-tree.js";

/** Max single skill file size included in the digest (1 MiB). */
export const SKILL_DIGEST_MAX_FILE_BYTES = 1_048_576;

/** Max files walked under a skill tree. */
export const SKILL_DIGEST_MAX_FILES = 500;

/**
 * Files/dirs ignored when hashing a skill tree.
 * Dotfiles are skipped except we never rely on hidden skill content.
 */
function shouldSkipName(name: string): boolean {
  if (name === "." || name === "..") {
    return true;
  }
  if (name.startsWith(".")) {
    return true;
  }
  if (name === "node_modules" || name === "dist" || name === "__pycache__") {
    return true;
  }
  return false;
}

/**
 * Collect skill-relative POSIX paths of all regular files under `skillRoot`,
 * sorted for stable digests.
 */
export async function listSkillFiles(skillRoot: string): Promise<string[]> {
  const root = path.resolve(skillRoot);
  const files: string[] = [];

  async function walk(absDir: string, relPosix: string): Promise<void> {
    if (files.length >= SKILL_DIGEST_MAX_FILES) {
      throw new Error(`skill tree exceeds ${SKILL_DIGEST_MAX_FILES} files under ${root}`);
    }
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        throw new Error(`skill path does not exist: ${root}`);
      }
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (shouldSkipName(entry.name)) {
        continue;
      }
      const childAbs = path.join(absDir, entry.name);
      const childRel = relPosix ? `${relPosix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (entry.isFile()) {
        files.push(childRel);
        if (files.length > SKILL_DIGEST_MAX_FILES) {
          throw new Error(`skill tree exceeds ${SKILL_DIGEST_MAX_FILES} files under ${root}`);
        }
      }
    }
  }

  await walk(root, "");
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

/**
 * Stable content digest of a Producer Skill tree (sha256 hex).
 *
 * Hashes sorted relative paths and file bytes so Manual Retry can freeze the
 * exact Skill Version. Requires SKILL.md at the root.
 */
export async function skillDigest(skillRoot: string): Promise<string> {
  const root = path.resolve(skillRoot);
  const skillMd = path.join(root, "SKILL.md");
  try {
    const info = await stat(skillMd);
    if (!info.isFile()) {
      throw new Error(`SKILL.md is not a file: ${skillMd}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new Error(`skill path missing SKILL.md: ${root}`);
    }
    throw error;
  }

  const files = await listSkillFiles(root);
  const hash = createHash("sha256");
  hash.update("okf-wiki-skill-v1\n");

  for (const rel of files) {
    const abs = path.join(root, ...rel.split("/"));
    const info = await stat(abs);
    if (!info.isFile()) {
      continue;
    }
    if (info.size > SKILL_DIGEST_MAX_FILE_BYTES) {
      throw new Error(`skill file too large for digest (${info.size} bytes): ${rel}`);
    }
    const body = await readFile(abs);
    hash.update(rel);
    hash.update("\0");
    hash.update(String(body.byteLength));
    hash.update("\0");
    hash.update(body);
    hash.update("\n");
  }

  return hash.digest("hex");
}

/**
 * Copy a Skill Version as ordinary files, then recompute and verify its digest.
 * The destination must not exist and is sealed read-only only after verification.
 */
export async function materializeSkillVersion(input: {
  sourceSkillPath: string;
  destination: string;
  expectedDigest: string;
}): Promise<{ path: string; digest: string }> {
  const source = path.resolve(input.sourceSkillPath);
  const destination = path.resolve(input.destination);
  const files = await listSkillFiles(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination);

  try {
    for (const relativePath of files) {
      const segments = relativePath.split("/");
      if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`invalid skill-relative path: ${relativePath}`);
      }
      const sourceFile = path.join(source, ...segments);
      const sourceInfo = await lstat(sourceFile);
      if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
        throw new Error(`skill entry is not an ordinary file: ${relativePath}`);
      }
      const destinationFile = path.join(destination, ...segments);
      await mkdir(path.dirname(destinationFile), { recursive: true });
      await writeFile(destinationFile, await readFile(sourceFile), { flag: "wx" });
    }

    await assertOrdinaryTree(destination, "Producer Skill");
    const digest = await skillDigest(destination);
    if (digest !== input.expectedDigest) {
      throw new Error(
        `Producer Skill digest changed while freezing (${input.expectedDigest} != ${digest})`,
      );
    }
    await makeTreeReadOnly(destination);
    return { path: destination, digest };
  } catch (error) {
    await makeTreeWritable(destination).catch(() => undefined);
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Best-effort parse of YAML frontmatter name/description from SKILL.md.
 */
export async function readSkillFrontmatter(
  skillRoot: string,
): Promise<{ name?: string; description?: string }> {
  const skillMd = path.join(path.resolve(skillRoot), "SKILL.md");
  let raw: string;
  try {
    raw = await readFile(skillMd, "utf8");
  } catch {
    return {};
  }
  if (!raw.startsWith("---")) {
    return {};
  }
  const end = raw.indexOf("\n---", 3);
  if (end < 0) {
    return {};
  }
  const block = raw.slice(3, end).trim();
  const result: { name?: string; description?: string } = {};
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) {
      continue;
    }
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim().replace(/^["']|["']$/g, "");
    if (key === "name" && value) {
      result.name = value;
    }
    if (key === "description" && value) {
      result.description = value;
    }
  }
  return result;
}
