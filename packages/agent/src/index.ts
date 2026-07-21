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
  parsePlanFromAgentText,
  type WikiRunAgentInput,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
} from "./run.js";

export {
  resolveSkillPath,
  resolveSkillSource,
  resolvePackageSkillPath,
  ensureHomeProducerSkill,
  skillLayoutPaths,
  type ResolveSkillSourceOptions,
  type ResolvedSkillSource,
} from "./skill-path.js";

export { sanitizeSummary } from "./stream-parts.js";

export {
  projectToolInput,
  projectToolOutput,
  projectUiMessageChunk,
  projectSessionToolPart,
  projectSessionMessages,
  buildPlanProgressData,
  buildPhaseProgressData,
  writePathFromToolFields,
  UI_READ_CONTENT_MAX,
  UI_WRITE_PREVIEW_MAX,
  UI_LIST_ENTRIES_MAX,
  type PlanProgressData,
  type PhaseProgressData,
  type PlanPageStatus,
} from "./ui-projection.js";

export {
  createSubagents,
  subagentsAsAgentsMap,
  type SubagentBundle,
} from "./subagents.js";

export { ADAPTIVE_RUN_LIMITS, adaptiveLimitsInstruction } from "./limits.js";

export {
  createSessionWorkflowStream,
  uiMessagesToSessionMessages,
  sessionMessagesToUIMessages,
  helpTextForSessionTurn,
  isKickoff,
  isKickoffPhrase,
  normalizeSessionUserText,
  resolveSessionTurnMode,
  type SessionStreamResult,
  type SessionStreamBody,
  type SessionStreamSideEffects,
  type SessionTurnHelpReason,
  type SessionTurnModeResult,
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

export {
  mapWorkflowResult,
  extractSuspendGate,
  sessionViewFromTerminal,
  isDurableRunStatus,
  type WikiWorkflowTerminal,
  type SessionTerminalView,
  type SuspendGatePayload,
} from "./workflow-result.js";

export {
  openWikiRunWorkflow,
  stepIdForGate,
  type WikiRunOpenParams,
  type WikiRunStartParams,
  type WikiRunResumeParams,
  type WikiRunWorkflowHandle,
} from "./wiki-run-orchestrator.js";

export {
  openWikiRunUiProjection,
  openWikiWorkflowUiStream,
  type WikiWorkflowUiParams,
  type WikiWorkflowUiHandle,
  type WikiWorkflowUiStart,
  type WikiWorkflowUiResume,
} from "./workflow-ui-stream.js";
export { mapWorkflowStreamEvent } from "./workflow-events.js";

export {
  bindRunAbortSignal,
  unbindRunAbortSignal,
  getRunAbortSignal,
  combineAbortSignals,
} from "./run-abort.js";
