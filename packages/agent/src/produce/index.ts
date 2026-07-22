/**
 * Produce module surface (Pi path, ADR 0030).
 * Live/fixture production: produceWithPi. Plan parse is pure text.
 */

export {
  produceWithPi,
  shouldUsePiFixtureMode,
  hasModelCredentials,
  type ProduceWithPiInput,
  type ProduceWithPiResult,
  type LivePiRole,
} from "./live-pi.js";
export { parsePlanFromAgentText } from "./plan-parse.js";
export {
  stagingDirForRun,
  buildSourceMap,
  normalizeWikiPath,
  type WikiRunAgentInput,
  type WikiRunAgentPhase,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
} from "./types.js";
