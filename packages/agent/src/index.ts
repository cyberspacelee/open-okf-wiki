/**
 * @okf-wiki/agent — Pi + product shell Wiki Run surface (ADR 0030).
 * No Mastra / AI SDK. Framework imports stay out of core/contract.
 *
 * Skill resolve lives in `@okf-wiki/core` — re-exported here for convenience.
 * Server should prefer importing skill resolve from `@okf-wiki/core`.
 */

/** Re-export single gate UI map (also on @okf-wiki/contract). */
export {
  type GateUiMap,
  mapRunGateToGateUi,
  mapSuspendToGateUi,
  optionsForPlanGate,
  optionsForPublishGate,
  type SuspendPayloadForGate,
} from "@okf-wiki/contract";
/** Prefer `@okf-wiki/core` — re-export for agent convenience. */
export {
  ensureHomeProducerSkill,
  isDurableRunStatus,
  type ResolvedSkillSource,
  type ResolveSkillSourceOptions,
  resolvePackageSkillPath,
  resolveSkillPath,
  resolveSkillSource,
  skillLayoutPaths,
} from "@okf-wiki/core";
export {
  evaluateWikiPublishable,
  hasBlockingDefects,
  mergeDefectReports,
  parseDefectReportFromText,
  readMergedDefects,
  writeMergedDefects,
} from "./defects.js";
export {
  DEFAULT_ORCHESTRATION,
  orchestrationLimitsInstruction,
  resolveOrchestration,
} from "./limits.js";
export {
  type AssistantOutcome,
  lastAssistantOutcome,
  resolveAssistantSummary,
} from "./pi/assistant-outcome.js";
export {
  type ContextBudget,
  type ContextBudgetInput,
  compactionSettingsFromBudget,
  resolveContextBudget,
} from "./pi/context-budget.js";
export {
  buildWikiSessionCustomTools,
  type CreateWikiSessionInput,
  createWikiSession,
  resolveWikiSessionTools,
  type WikiSessionHandle,
} from "./pi/create-wiki-session.js";
export {
  hasLiveProviderCredentials,
  OKF_PROVIDER_KINDS,
  type OkfProviderKind,
  okfProviderId,
  piApiFromShape,
  type ResolvedPiModel,
  type ResolvePiModelInput,
  resolvePiModelFromProvider,
  resolveWorkspacePiModel,
  servedModelIdFromProfile,
} from "./pi/provider-model.js";
export {
  modelRefForRole,
  type ResolvedModelRef,
  resolveModelSelection,
  type WikiModelRole,
} from "./pi/role-model.js";
export {
  type MaterializeRunWorkdirInput,
  materializeRunWorkdir,
  type RunWorkdirLayout,
  runWorkdirPromptPaths,
} from "./pi/run-workdir.js";
export {
  findPiSessionFile,
  foldProduceUnitDetails,
  isPiSessionJsonlName,
  loadPiSessionHistory,
  type PiAssistantMessage,
  type PiHistoryMessage,
  type PiImageContent,
  type PiSessionHistory,
  type PiTextContent,
  type PiThinkingContent,
  type PiToolCallContent,
  type PiToolResultMessage,
  type PiUserMessage,
  produceUnitsFromSessionEntries,
} from "./pi/session-history.js";
export {
  piRunsDir,
  piRunWorkDir,
  piSessionPath,
  piSessionsDir,
} from "./pi/session-paths.js";
export {
  type ResolveWikiSkillPathsInput,
  resolveWikiSkillPaths,
} from "./pi/skill-paths.js";
export {
  type AssertPathAllowedOptions,
  assertAbsolutePathAllowed,
  assertPathAllowed,
  type BuildWikiScopedToolsInput,
  buildWikiScopedToolDefinitions,
  createWikiEditOperations,
  createWikiReadOperations,
  createWikiWriteOperations,
  isIgnoredSourceRel,
  isReadOnlyTreeRel,
  isUnder,
  isWriteScopeRel,
  normalizeRelPath,
  type PathAccessMode,
  parseSourceMountPath,
  READ_ONLY_PREFIXES,
  type SourceIgnoreInput,
  type WikiToolOperationsOptions,
  WRITE_SCOPE_PREFIXES,
} from "./pi/tool-operations.js";
/** Pi harness (ADR 0030) — tool policy + run workdir layout. */
export {
  assertSafeWikiToolList,
  FORBIDDEN_WIKI_TOOLS,
  isReadOnlyToolList,
  type PiFsToolName,
  roleMayWrite,
  toolNamesForRole,
  type WikiAgentRole,
} from "./pi/tool-policy.js";
export {
  type ChildRole,
  produceRoleForChild,
  type RunChildSessionInput,
  type RunChildSessionResult,
  runChildrenParallel,
  runChildSession,
} from "./produce/children.js";
export {
  aggregateProduceDetails,
  attachProgress,
  type CreateProduceProgressBridgeOpts,
  createProduceProgressBridge,
  createProgressTracker,
  hasModelCredentials,
  type LivePiRole,
  messageFromPiContent,
  OKF_PRODUCE_PROGRESS_CUSTOM_TYPE,
  type ProduceAgentRole,
  type ProduceEventSink,
  type ProduceProgress,
  type ProduceProgressBridge,
  type ProduceProgressSessionManager,
  type ProduceProgressStatus,
  type ProduceProgressTracker,
  type ProduceToolDetails,
  type ProduceWikiInput,
  type ProduceWikiResult,
  type ProduceWithPiInput,
  type ProduceWithPiResult,
  parsePlanFromAgentText,
  produceWiki,
  produceWithPi,
  progressToDetails,
  shouldUsePiFixtureMode,
  stagingWikiDirForRun,
  type WikiRunAgentInput,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
} from "./produce/index.js";
export {
  type ReviewerOutput,
  runReviewCouncil,
} from "./review-council.js";
export { redactErrorMessage, sanitizeSummary, truncate } from "./run-redact.js";
/** WikiRunShell — pure product phase machine (no Mastra). */
export {
  applyPlanRevision,
  assertValidResumeGate,
  enterPlanGate,
  isTerminalPhase,
  isWikiRunGateAction,
  isWikiRunGateKind,
  markAwaitingPublish,
  markCancelled,
  markFailed,
  markHardValidate,
  markProducing,
  markPublicationDeclined,
  markPublished,
  type ResumeGateInput,
  resumeGate,
  type StartShellInput,
  shellPhaseLabel,
  startShell,
  type WikiRunGateAction,
  type WikiRunGateKind,
  type WikiRunShellPhase,
  type WikiRunShellState,
} from "./shell/wiki-run-shell.js";
export {
  readWikiRunSpec,
  runAnalysisDir,
  writeWikiRunSpec,
} from "./spec-store.js";
export {
  beginParentWikiProduceTool,
  completeParentWikiProduceTool,
  createWikiRunProduceBridge,
  extractSuspendGate,
  type ParentToolEventEmit,
  type ParentToolSessionManager,
  type ParentWikiProduceToolHandle,
  type ResumeWikiRunInput,
  resumeWikiRun,
  type StartWikiRunInput,
  sessionViewFromTerminal,
  startWikiRun,
  WIKI_PRODUCE_TOOL_NAME,
  type WikiRunModelFactory,
  type WikiRunOrchestrationResult,
  type WikiWorkflowJobEvent,
  type WikiWorkflowTerminal,
} from "./wiki-run.js";
