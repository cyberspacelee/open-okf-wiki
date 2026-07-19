/**
 * Mastra-backed Wiki Run agent assembly.
 * Keep framework imports out of @okf-wiki/core and @okf-wiki/contract.
 */

export {
  resolveContainedPath,
  assertContainedPathSafe,
  toPosixRelative,
} from "./path-policy.js";
export {
  listDirContained,
  readFileContained,
  writeFileContained,
  listMarkdownPages,
} from "./fs-ops.js";
export { createWikiRunTools } from "./tools.js";
export { resolveBundledSkillPath, resolveSkillPath } from "./skill-path.js";
export {
  runWikiAgent,
  shouldUseFixtureMode,
  stagingDirForRun,
  redactErrorMessage,
  type WikiRunAgentInput,
  type WikiRunAgentResult,
} from "./run.js";
