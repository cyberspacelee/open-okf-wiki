/**
 * Producer Skill resolution — Agent Skills (`.agents/skills`) layout:
 *
 * 1. Explicit workspace.skillPath (operator fork / override)
 * 2. Workspace project skill: `{root}/.agents/skills/repository-wiki-producer`
 * 3. User home skill (when Settings loadHomeSkills): `~/.agents/skills/…`
 * 4. Package assets: `@okf-wiki/skill` (seed source + fallback when home off)
 *
 * Package resolution prefers Node package resolution, then the monorepo sibling
 * `packages/skill` next to this package (stable via import.meta.url, not cwd).
 * Home skills toggle is Settings/app.json only (no env override).
 */

import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillSourceKind } from "@okf-wiki/contract";
import { copySkillTree } from "./skill-fork.js";
import {
  homeProducerSkillPath,
  homeSkillsDir,
  workspaceProducerSkillPath,
} from "./product-home.js";
import { getLoadHomeSkills } from "./workspace-store.js";

export type ResolveSkillSourceOptions = {
  /** Explicit skill root from workspace.skillPath. */
  skillPath?: string;
  /** Workspace root for `{root}/.agents/skills` discovery. */
  workspaceRoot?: string;
};

export type ResolvedSkillSource = {
  path: string;
  kind: SkillSourceKind;
};

async function existsSkillDir(candidate: string): Promise<boolean> {
  try {
    await access(path.join(candidate, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Monorepo sibling of `@okf-wiki/core`: `packages/core/{src,dist}` → `packages/skill`.
 * Does not use process.cwd().
 */
function monorepoSiblingSkillCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/core/dist|src → packages/skill
  return [path.resolve(here, "..", "..", "skill")];
}

/**
 * Resolve the package-embedded Producer Skill directory (`@okf-wiki/skill`).
 * Order: Node package resolve → monorepo sibling packages/skill.
 */
export async function resolvePackageSkillPath(): Promise<string> {
  const errors: string[] = [];

  // 1) createRequire from this module (respects core/node_modules links)
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@okf-wiki/skill/package.json");
    const root = path.dirname(pkgJson);
    if (await existsSkillDir(root)) {
      return root;
    }
    errors.push(`linked package missing SKILL.md: ${root}`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  // 2) ESM import.meta.resolve
  try {
    const resolved = import.meta.resolve("@okf-wiki/skill/package.json");
    const root = path.dirname(fileURLToPath(resolved));
    if (await existsSkillDir(root)) {
      return root;
    }
    errors.push(`import.meta.resolve path missing SKILL.md: ${root}`);
  } catch (error) {
    errors.push(
      `import.meta.resolve: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 3) Monorepo sibling (no install link required when repo is checked out)
  for (const candidate of monorepoSiblingSkillCandidates()) {
    if (await existsSkillDir(candidate)) {
      return candidate;
    }
    errors.push(`sibling not found: ${candidate}`);
  }

  throw new Error(
    `package skill (@okf-wiki/skill) not found. ` +
      `Run \`pnpm install\` from the monorepo root, or place a skill under ` +
      `${homeSkillsDir()}/ or {workspace}/.agents/skills/. ` +
      `(details: ${errors.join("; ")})`,
  );
}

/**
 * Ensure the home Producer Skill exists by seeding from the package when missing.
 * Does not overwrite an existing home skill (operator may have customized it).
 * If the home skill already exists, package resolution is skipped.
 */
export async function ensureHomeProducerSkill(
  packageSkillPath?: string,
): Promise<{ path: string; seeded: boolean }> {
  const dest = homeProducerSkillPath();
  if (await existsSkillDir(dest)) {
    return { path: dest, seeded: false };
  }
  const source = packageSkillPath ?? (await resolvePackageSkillPath());
  return copySkillTree({
    sourceSkillPath: source,
    destSkillPath: dest,
    force: false,
  });
}

/**
 * Resolve the active Producer Skill for a Wiki Run / Settings.
 *
 * Priority:
 * 1. Explicit skillPath
 * 2. `{workspaceRoot}/.agents/skills/repository-wiki-producer`
 * 3. `~/.agents/skills/…` when loadHomeSkills (Settings)
 * 4. Package-embedded skill
 */
export async function resolveSkillSource(
  options: ResolveSkillSourceOptions = {},
): Promise<ResolvedSkillSource> {
  if (typeof options.skillPath === "string" && options.skillPath.trim()) {
    const resolved = path.resolve(options.skillPath.trim());
    if (!(await existsSkillDir(resolved))) {
      throw new Error(`skill path missing SKILL.md: ${resolved}`);
    }
    return { path: resolved, kind: "fork" };
  }

  if (typeof options.workspaceRoot === "string" && options.workspaceRoot.trim()) {
    const projectSkill = workspaceProducerSkillPath(options.workspaceRoot.trim());
    if (await existsSkillDir(projectSkill)) {
      return { path: projectSkill, kind: "fork" };
    }
  }

  const loadHome = await getLoadHomeSkills();
  if (loadHome) {
    const home = await ensureHomeProducerSkill();
    return { path: home.path, kind: "home" };
  }

  const pkg = await resolvePackageSkillPath();
  return { path: pkg, kind: "package" };
}

/** Resolve skill root path only. */
export async function resolveSkillPath(
  options: ResolveSkillSourceOptions = {},
): Promise<string> {
  const source = await resolveSkillSource(options);
  return source.path;
}

/** Operator-facing paths for Settings. */
export function skillLayoutPaths(): {
  homeSkillsDir: string;
  homeProducerSkill: string;
  workspaceSkillsRelative: string;
} {
  return {
    homeSkillsDir: homeSkillsDir(),
    homeProducerSkill: homeProducerSkillPath(),
    workspaceSkillsRelative: path.join(".agents", "skills"),
  };
}
