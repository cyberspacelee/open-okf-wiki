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
  resolveWikiModel,
  parsePlanFromAgentText,
  type WikiRunAgentInput,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
  type ResolvedWikiModel,
} from "./run.js";

export {
  CONTEXT_COMPACTION_RATIO,
  CONTEXT_TOOL_RESULT_RECENT_STEPS,
  resolveContextTargetTokens,
  resolveContextTargetForWorkspace,
  buildContextInputProcessors,
  type ResolveContextTargetInput,
} from "./context-limits.js";

export {
  OM_OBSERVATION_RATIO,
  OM_REFLECTION_RATIO,
  createWikiRunMemory,
  resolveObservationMessageTokens,
  resolveReflectionObservationTokens,
  wikiRunMemoryOption,
  type CreateWikiRunMemoryInput,
} from "./wiki-memory.js";

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
  replayWikiRunAuditEvents,
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

/** Re-export single gate UI map (also on @okf-wiki/contract). */
export {
  mapSuspendToGateUi,
  mapRunGateToGateUi,
  optionsForPlanGate,
  optionsForPublishGate,
  type SuspendPayloadForGate,
  type GateUiMap,
} from "@okf-wiki/contract";

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
  type WikiWorkflowUiParams,
  type WikiWorkflowUiHandle,
  type WikiWorkflowUiStart,
  type WikiWorkflowUiResume,
} from "./workflow-ui-stream.js";
export {
  openWikiRunAuditStream,
  loadWikiRunWorkflowSnapshot,
  minimalWorkflowStateForAudit,
} from "./workflow-audit-stream.js";
export {
  mapWorkflowStreamEvent,
  uiChunkToJobEvent,
} from "./workflow-events.js";

export {
  bindRunAbortSignal,
  unbindRunAbortSignal,
  getRunAbortSignal,
  combineAbortSignals,
} from "./run-abort.js";
