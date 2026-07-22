/**
 * @okf-wiki/agent — Pi + product shell Wiki Run surface (ADR 0030).
 * No Mastra / AI SDK. Framework imports stay out of core/contract.
 *
 * Skill resolve lives in `@okf-wiki/core` — re-exported here for convenience.
 * Server should prefer importing skill resolve from `@okf-wiki/core`.
 */

export {
  startWikiRun,
  resumeWikiRun,
  extractSuspendGate,
  sessionViewFromTerminal,
  type StartWikiRunInput,
  type ResumeWikiRunInput,
  type WikiRunOrchestrationResult,
  type WikiWorkflowJobEvent,
  type WikiWorkflowTerminal,
  type WikiRunModelFactory,
} from "./wiki-run.js";

export {
  produceWithPi,
  produceWiki,
  shouldUsePiFixtureMode,
  hasModelCredentials,
  parsePlanFromAgentText,
  stagingWikiDirForRun,
  type ProduceWithPiInput,
  type ProduceWithPiResult,
  type ProduceWikiInput,
  type ProduceWikiResult,
  type ProduceEventSink,
  type LivePiRole,
  type WikiRunAgentInput,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
} from "./produce/index.js";

export {
  runChildSession,
  runChildrenParallel,
  type ChildRole,
  type RunChildSessionInput,
  type RunChildSessionResult,
} from "./produce/children.js";

export { redactErrorMessage, sanitizeSummary, truncate } from "./run-redact.js";

/** Prefer `@okf-wiki/core` — re-export for agent convenience. */
export {
  resolveSkillPath,
  resolveSkillSource,
  resolvePackageSkillPath,
  ensureHomeProducerSkill,
  skillLayoutPaths,
  isDurableRunStatus,
  type ResolveSkillSourceOptions,
  type ResolvedSkillSource,
} from "@okf-wiki/core";

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

export {
  runReviewCouncil,
  type ReviewerOutput,
} from "./review-council.js";

/** Re-export single gate UI map (also on @okf-wiki/contract). */
export {
  mapSuspendToGateUi,
  mapRunGateToGateUi,
  optionsForPlanGate,
  optionsForPublishGate,
  type SuspendPayloadForGate,
  type GateUiMap,
} from "@okf-wiki/contract";

/** Pi harness (ADR 0030) — tool policy + run workdir layout. */
export {
  toolNamesForRole,
  roleMayWrite,
  assertSafeWikiToolList,
  isReadOnlyToolList,
  FORBIDDEN_WIKI_TOOLS,
  type PiFsToolName,
  type WikiAgentRole,
} from "./pi/tool-policy.js";
export {
  assertPathAllowed,
  assertAbsolutePathAllowed,
  isUnder,
  isWriteScopeRel,
  isReadOnlyTreeRel,
  isIgnoredSourceRel,
  normalizeRelPath,
  parseSourceMountPath,
  buildWikiScopedToolDefinitions,
  createWikiReadOperations,
  createWikiWriteOperations,
  createWikiEditOperations,
  WRITE_SCOPE_PREFIXES,
  READ_ONLY_PREFIXES,
  type PathAccessMode,
  type SourceIgnoreInput,
  type AssertPathAllowedOptions,
  type WikiToolOperationsOptions,
  type BuildWikiScopedToolsInput,
} from "./pi/tool-operations.js";
export {
  materializeRunWorkdir,
  runWorkdirPromptPaths,
  type RunWorkdirLayout,
  type MaterializeRunWorkdirInput,
} from "./pi/run-workdir.js";
export {
  createWikiSession,
  resolveWikiSessionTools,
  buildWikiSessionCustomTools,
  type CreateWikiSessionInput,
  type WikiSessionHandle,
} from "./pi/create-wiki-session.js";
export {
  resolvePiModelFromProvider,
  resolveWorkspacePiModel,
  piApiFromShape,
  servedModelIdFromProfile,
  okfProviderId,
  hasLiveProviderCredentials,
  OKF_PROVIDER_KINDS,
  type OkfProviderKind,
  type ResolvePiModelInput,
  type ResolvedPiModel,
} from "./pi/provider-model.js";
export {
  resolveContextBudget,
  compactionSettingsFromBudget,
  type ContextBudget,
  type ContextBudgetInput,
} from "./pi/context-budget.js";
export {
  resolveWikiSkillPaths,
  type ResolveWikiSkillPathsInput,
} from "./pi/skill-paths.js";
export {
  modelRefForRole,
  resolveModelSelection,
  type WikiModelRole,
  type ResolvedModelRef,
} from "./pi/role-model.js";
export {
  piSessionsDir,
  piRunsDir,
  piSessionPath,
  piRunWorkDir,
} from "./pi/session-paths.js";
export {
  loadPiSessionHistory,
  findPiSessionFile,
  type PiSessionHistory,
  type ProjectedHistoryMessage,
} from "./pi/session-history.js";

/** WikiRunShell — pure product phase machine (no Mastra). */
export {
  startShell,
  enterPlanGate,
  resumeGate,
  markProducing,
  markHardValidate,
  markAwaitingPublish,
  markPublished,
  markPublicationDeclined,
  markFailed,
  markCancelled,
  shellPhaseLabel,
  isTerminalPhase,
  applyPlanRevision,
  assertValidResumeGate,
  isWikiRunGateAction,
  isWikiRunGateKind,
  type StartShellInput,
  type WikiRunShellState,
  type WikiRunShellPhase,
  type ResumeGateInput,
  type WikiRunGateAction,
  type WikiRunGateKind,
} from "./shell/wiki-run-shell.js";
