/**
 * Produce module surface (Pi path, ADR 0030 / 0031).
 * Deep entry: produceWiki. Primitive: produceWithPi.
 * Operator body channel: parent-visible work_unit only.
 */

export {
  type ProduceAgentRole,
  type ProduceEventSink,
  type ProduceProgressPhase,
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
export {
  attachWorkUnitSink,
  type CreateParentVisibilityReducerOpts,
  createParentVisibilityReducer,
  messageFromPiContent,
  type ParentUnitMessage,
  type ParentUnitStatus,
  type ParentUnitToolState,
  type ParentUnitUpdate,
  type ParentVisibilityReducer,
} from "./parent-visibility.js";
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
  buildSourceMap,
  normalizeWikiPath,
  stagingWikiDirForRun,
  type WikiRunAgentInput,
  type WikiRunAgentPhase,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
} from "./types.js";
