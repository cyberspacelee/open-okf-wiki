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

export { sanitizeSummary } from "./stream-parts.js";

export {
  createSubagents,
  subagentsAsAgentsMap,
  type SubagentBundle,
} from "./subagents.js";

export { ADAPTIVE_RUN_LIMITS, adaptiveLimitsInstruction } from "./limits.js";

export {
  createSessionWorkflowStream,
  uiMessagesToSessionMessages,
  type SessionStreamResult,
  type SessionStreamBody,
  type SessionStreamSideEffects,
} from "./session-stream.js";

export { getMastra, mastraStorageDir, resetMastraForTests } from "./mastra-instance.js";

export {
  wikiRunWorkflow,
  WIKI_RUN_WORKFLOW_ID,
  type WikiRunWorkflowInput,
  type WikiRunWorkflowOutput,
} from "./wiki-workflow.js";

export {
  startWikiRun,
  resumeWikiRun,
  type StartWikiRunInput,
  type ResumeWikiRunInput,
  type WikiRunOrchestrationResult,
  type WikiWorkflowJobEvent,
} from "./wiki-run.js";

export { openWikiWorkflowUiStream } from "./workflow-ui-stream.js";
export { mapWorkflowStreamEvent } from "./workflow-events.js";
