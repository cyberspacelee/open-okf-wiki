import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function existsDir(candidate: string): Promise<boolean> {
  try {
    await access(path.join(candidate, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the bundled monorepo skill directory (`packages/skill`).
 * Prefers `import.meta.url` relative to this package, then cwd heuristics.
 */
export async function resolveBundledSkillPath(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/agent/dist → packages/skill  OR  packages/agent/src → packages/skill
  const fromPackage = path.resolve(here, "..", "..", "skill");
  const candidates = [
    fromPackage,
    path.resolve(process.cwd(), "packages", "skill"),
    path.resolve(process.cwd(), "..", "skill"),
    path.resolve(process.cwd(), "skill"),
  ];

  for (const candidate of candidates) {
    if (await existsDir(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `bundled skill not found (looked for SKILL.md under: ${candidates.join(", ")})`,
  );
}

export async function resolveSkillPath(override?: string): Promise<string> {
  if (typeof override === "string" && override.trim()) {
    const resolved = path.resolve(override.trim());
    if (!(await existsDir(resolved))) {
      throw new Error(`skill path missing SKILL.md: ${resolved}`);
    }
    return resolved;
  }
  return resolveBundledSkillPath();
}
