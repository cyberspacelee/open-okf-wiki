/**
 * Resolve Agent Skills directories for Pi DefaultResourceLoader.
 *
 * Product skill layout (agentskills.io):
 * - Producer Skill: resolved via core resolveSkillPath (fork / workspace / home / package)
 * - Workspace skills root: `{root}/.agents/skills`
 * - User home skills: `~/.agents/skills` when Settings loadHomeSkills is on
 *
 * createWikiSession keeps `noSkills: true` (skip Pi defaults) and injects
 * these paths via `additionalSkillPaths` so only product skills load.
 */

import { access } from "node:fs/promises";
import {
  getLoadHomeSkills,
  homeSkillsDir,
  isUnderHomeSkills,
  isUnderWorkspaceSkills,
  resolveSkillPath,
  workspaceSkillsDir,
} from "@okf-wiki/core";

export type ResolveWikiSkillPathsInput = {
  /** Workspace root for project skills + producer discovery. */
  workspaceRoot?: string;
  /** Explicit workspace.skillPath override. */
  skillPath?: string;
  /**
   * When set, overrides Settings loadHomeSkills.
   * When omitted, reads app.json via getLoadHomeSkills().
   */
  loadHomeSkills?: boolean;
  /** Include resolved Producer Skill directory (default true). */
  includeProducerSkill?: boolean;
};

async function dirExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unique, absolute skill roots for Pi additionalSkillPaths.
 * Missing dirs are omitted (no throw).
 *
 * Strategy: prefer skills *roots* (workspace / home) so sibling skills load.
 * Add the resolved Producer Skill only when it lives outside those roots
 * (package skill or explicit path).
 */
export async function resolveWikiSkillPaths(
  input: ResolveWikiSkillPathsInput = {},
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (p: string | undefined) => {
    if (!p) return;
    const abs = p.trim();
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };

  if (input.workspaceRoot?.trim()) {
    const workspaceRootSkills = workspaceSkillsDir(input.workspaceRoot);
    if (await dirExists(workspaceRootSkills)) {
      add(workspaceRootSkills);
    }
  }

  const loadHome =
    typeof input.loadHomeSkills === "boolean" ? input.loadHomeSkills : await getLoadHomeSkills();
  if (loadHome) {
    const homeRoot = homeSkillsDir();
    if (await dirExists(homeRoot)) {
      add(homeRoot);
    }
  }

  if (input.includeProducerSkill !== false) {
    try {
      const producer = await resolveSkillPath({
        skillPath: input.skillPath,
        workspaceRoot: input.workspaceRoot,
      });
      if (!(await dirExists(producer))) {
        return out;
      }
      // Skip if already covered by a parent skills root.
      const underWs = input.workspaceRoot && isUnderWorkspaceSkills(producer, input.workspaceRoot);
      const underHome = isUnderHomeSkills(producer);
      if (!underWs && !underHome) {
        add(producer);
      }
    } catch {
      // Producer skill optional for chat; produce materialize handles hard fail.
    }
  }

  return out;
}
