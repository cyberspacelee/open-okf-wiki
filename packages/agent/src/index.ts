/**
 * Mastra-backed Wiki Run agent assembly.
 * Keep framework imports out of @okf-wiki/core and @okf-wiki/contract.
 *
 * Skill resolve (`resolveSkillPath`, etc.) lives in `@okf-wiki/core` —
 * re-exported here for agent-internal convenience only. Server must import
 * skill resolve from `@okf-wiki/core`.
 */

export {
  runWikiAgent,
  stagingDirForRun,
  shouldUseFixtureMode,
  resolveModelConfig,
  resolveWikiModel,
  parsePlanFromAgentText,
  type WikiRunAgentInput,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
  type ResolvedWikiModel,
} from "./produce/index.js";

export { redactErrorMessage } from "./run-redact.js";

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

/** Prefer `@okf-wiki/core` — re-export for agent convenience. */
export {
  resolveSkillPath,
  resolveSkillSource,
  resolvePackageSkillPath,
  ensureHomeProducerSkill,
  skillLayoutPaths,
  type ResolveSkillSourceOptions,
  type ResolvedSkillSource,
} from "@okf-wiki/core";

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

export {
  DEFAULT_ORCHESTRATION,
  orchestrationLimitsInstruction,
  resolveOrchestration,
} from "./limits.js";

export {
  evaluateWikiPublishable,
  hasBlockingDefects,
  mergeDefectReports,
  parseDefectReportFromText,
  writeMergedDefects,
  readMergedDefects,
} from "./defects.js";

export {
  writeWikiRunSpec,
  readWikiRunSpec,
  runAnalysisDir,
} from "./spec-store.js";

export { resolveRoleModels } from "./role-models.js";

export {
  buildRootDelegationOptions,
  createDelegationCounters,
} from "./delegation.js";

export { runReviewCouncil } from "./review-council.js";

export {
  buildPhaseSteps,
  emitRunPhase,
  emitAgentSpan,
  emitSourcesIndex,
  roleFromAgentId,
} from "./run-timeline.js";

export {
  createSessionTurnStream,
  createSessionWorkflowStream,
  isRunCancelledError,
  uiMessagesToSessionMessages,
  sessionMessagesToUIMessages,
  helpTextForSessionTurn,
  isKickoff,
  isKickoffPhrase,
  normalizeSessionUserText,
  resolveSessionTurnMode,
  planToMarkdown,
  type SessionStreamResult,
  type SessionStreamBody,
  type SessionStreamSideEffects,
  type SessionTurnHooks,
  type CreateSessionTurnStreamInput,
  type SessionTurnHelpReason,
  type SessionTurnModeResult,
} from "./session-turn/index.js";

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
  type WikiWorkflowUiHandle,
} from "./workflow-ui-stream.js";
export {
  openWikiRunAuditStream,
  loadWikiRunWorkflowSnapshot,
  minimalWorkflowStateForAudit,
} from "./workflow-audit-stream.js";
export { uiChunkToJobEvent } from "./workflow-events.js";

export {
  bindRunAbortSignal,
  unbindRunAbortSignal,
  getRunAbortSignal,
  combineAbortSignals,
} from "./run-abort.js";
