/**
 * Produce module surface (Pi path, ADR 0030).
 * Deep entry: produceWiki. Primitive: produceWithPi.
 */

export {
  produceWithPi,
  shouldUsePiFixtureMode,
  hasModelCredentials,
  type ProduceWithPiInput,
  type ProduceWithPiResult,
  type LivePiRole,
} from "./live-pi.js";
export {
  produceWiki,
  type ProduceWikiInput,
  type ProduceWikiResult,
  type ProduceWikiModels,
} from "./orchestrate.js";
export {
  silentProduceEvents,
  recordingProduceEvents,
  type ProduceEventSink,
  type ProduceProgressPhase,
} from "./events.js";
export { parsePlanFromAgentText } from "./plan-parse.js";
export {
  stagingWikiDirForRun,
  buildSourceMap,
  normalizeWikiPath,
  type WikiRunAgentInput,
  type WikiRunAgentPhase,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
} from "./types.js";
