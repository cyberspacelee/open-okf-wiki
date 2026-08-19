import { WikiProductionRuns } from "./production-run.js";
import type { WikiProducer } from "./producer-types.js";

/** Public factory. Hides Pi types from the root declaration graph. */
export function createProductionWikiProducer(): WikiProducer {
  return new WikiProductionRuns();
}
