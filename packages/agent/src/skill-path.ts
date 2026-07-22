/**
 * Re-export skill resolution from `@okf-wiki/core` for agent-internal convenience.
 * Server and other packages should import from `@okf-wiki/core` directly.
 */

export {
  resolveSkillPath,
  resolveSkillSource,
  resolvePackageSkillPath,
  ensureHomeProducerSkill,
  skillLayoutPaths,
  type ResolveSkillSourceOptions,
  type ResolvedSkillSource,
} from "@okf-wiki/core";
