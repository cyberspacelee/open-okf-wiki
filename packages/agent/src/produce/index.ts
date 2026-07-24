/**
 * Produce module surface (Pi path, ADR 0030 / 0031).
 * Deep entry: produceWiki. Primitive: produceWithPi.
 * Child visibility: host-local onProgress → ProduceToolDetails bridge (WP3).
 * No product work_unit inject.
 */

export {
  attachProgress,
  type CreateProgressTrackerOpts,
  createProgressTracker,
  messageFromPiContent,
  type ProduceAgentRole,
  type ProduceEventSink,
  type ProduceProgress,
  type ProduceProgressMessage,
  type ProduceProgressPhase,
  type ProduceProgressStatus,
  type ProduceProgressTool,
  type ProduceProgressTracker,
  recordingProduceEvents,
  silentProduceEvents,
} from "./events.js";
export {
  hasModelCredentials,
  type LivePiRole,
  type ProduceWithPiInput,
  type ProduceWithPiResult,
  produceWithPi,
  shouldUsePiFixtureMode,
} from "./live-pi.js";
export {
  type ProduceWikiInput,
  type ProduceWikiModels,
  type ProduceWikiResult,
  produceWiki,
} from "./orchestrate.js";
export { type PlanWikiSpecInput, type PlanWikiSpecResult, planWikiSpec } from "./plan.js";
export { parsePlanFromAgentText } from "./plan-parse.js";
export {
  plannerPrompt,
  rootWritePrompt,
  rootWriteSystemPrompt,
  type WikiLanguage,
} from "./prompts.js";
export {
  buildReceiptIndex,
  persistResearchReceipt,
} from "./receipts.js";
export {
  aggregateProduceDetails,
  type CreateProduceProgressBridgeOpts,
  createProduceProgressBridge,
  OKF_PRODUCE_PROGRESS_CUSTOM_TYPE,
  type ProduceProgressBridge,
  type ProduceProgressSessionManager,
  type ProduceToolDetails,
  progressToDetails,
} from "./tools/wiki-produce-progress.js";
export {
  buildSourceMap,
  normalizeWikiPath,
  stagingWikiDirForRun,
  type WikiRunAgentInput,
  type WikiRunAgentPhase,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
} from "./types.js";
