/**
 * Producer Skill resolution — Agent Skills (`.agents/skills`) layout:
 *
 * 1. Explicit workspace.skillPath (operator fork / override)
 * 2. Workspace project skill: `{root}/.agents/skills/repository-wiki-producer`
 * 3. User home skill (when Settings loadHomeSkills): `~/.agents/skills/…`
 * 4. Package assets: `@okf-wiki/skill` (seed source + fallback when home off)
 *
 * Does not scan monorepo paths via cwd heuristics.
 * Home skills toggle is Settings/app.json only (no env override).
 */

import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillSourceKind } from "@okf-wiki/contract";
import {
  copySkillTree,
  getLoadHomeSkills,
  homeProducerSkillPath,
  homeSkillsDir,
  workspaceProducerSkillPath,
} from "@okf-wiki/core";

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
 * Resolve the package-embedded Producer Skill directory (`@okf-wiki/skill`).
 * Uses package exports — not monorepo cwd heuristics.
 */
export async function resolvePackageSkillPath(): Promise<string> {
  const require = createRequire(import.meta.url);
  try {
    const pkgJson = require.resolve("@okf-wiki/skill/package.json");
    const root = path.dirname(pkgJson);
    if (await existsSkillDir(root)) {
      return root;
    }
    throw new Error(`package skill missing SKILL.md: ${root}`);
  } catch (error) {
    try {
      const resolved = import.meta.resolve("@okf-wiki/skill/package.json");
      const root = path.dirname(fileURLToPath(resolved));
      if (await existsSkillDir(root)) {
        return root;
      }
    } catch {
      // fall through
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `package skill (@okf-wiki/skill) not found: ${message}. ` +
        `Install @okf-wiki/skill or place a skill under ${homeSkillsDir()}/` +
        ` or {workspace}/.agents/skills/.`,
    );
  }
}

/**
 * Ensure the home Producer Skill exists by seeding from the package when missing.
 * Does not overwrite an existing home skill (operator may have customized it).
 */
export async function ensureHomeProducerSkill(
  packageSkillPath?: string,
): Promise<{ path: string; seeded: boolean }> {
  const source = packageSkillPath ?? (await resolvePackageSkillPath());
  const dest = homeProducerSkillPath();
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
