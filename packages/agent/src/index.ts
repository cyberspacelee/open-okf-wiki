/**
 * Mastra-backed Wiki Run agent assembly.
 * Keep framework imports out of @okf-wiki/core and @okf-wiki/contract.
 */

export {
  runWikiAgent,
  stagingDirForRun,
  redactErrorMessage,
  type WikiRunAgentInput,
  type WikiRunAgentResult,
} from "./run.js";
