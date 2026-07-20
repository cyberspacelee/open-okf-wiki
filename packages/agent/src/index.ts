/**
 * Mastra-backed Wiki Run agent assembly.
 * Keep framework imports out of @okf-wiki/core and @okf-wiki/contract.
 */

export {
  runWikiAgent,
  stagingDirForRun,
  redactErrorMessage,
  shouldUseFixtureMode,
  resolveModelConfig,
  type WikiRunAgentInput,
  type WikiRunAgentResult,
} from "./run.js";

export { resolveSkillPath, resolveBundledSkillPath } from "./skill-path.js";

export {
  projectMastraChunk,
  fixtureStreamParts,
  sanitizeSummary,
  type WikiStreamPart,
} from "./stream-parts.js";

export {
  createSubagents,
  subagentsAsAgentsMap,
  type SubagentBundle,
} from "./subagents.js";

export { ADAPTIVE_RUN_LIMITS, adaptiveLimitsInstruction } from "./limits.js";

export {
  createSessionChatStream,
  uiMessagesToSessionMessages,
  type SessionChatResult,
} from "./session-chat.js";
