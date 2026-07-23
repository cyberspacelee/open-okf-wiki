/**
 * Pure projection of Operator Session → transcript + Work surface.
 *
 * ADR 0031 Wave 3:
 * - Parent Pi events → main timeline (applyPiEvent)
 * - Product whitelist (incl. work_unit) → cards + units fold cache
 * - WorkUnits is a fold cache only (last-by-unitId), not durability authority
 * - No dual-path child streams or span body channels (ADR 0031)
 *
 * Implementation is split under `./project/` for maintainability.
 * This module re-exports the public API so existing imports keep working.
 */

export type {
  AgentMessage,
  AgentMessageRole,
  AgentProductMeta,
  AgentToolCall,
  PlanProgressPage,
  ProductSseLike,
  StreamCursor,
  StreamingRefs,
  WorkAgentChip,
  WorkUnitEventLike,
  WorkUnits,
  WorkUnitView,
} from "./project/types.ts";

export {
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  formatPayloadText,
  formatToolDisplay,
  makeId,
  safeStringify,
  toolPathLabel,
  type ToolDisplaySummary,
} from "./project/format.ts";

export {
  applyWorkUnit,
  workUnitHasBody,
  workUnitsFromList,
  workUnitToolsToAgentTools,
} from "./project/work-unit.ts";

export { applyPiEvent } from "./project/pi.ts";

export {
  applyProductEvent,
  isTerminalOrWaitingPhase,
  lastAssistantIsError,
  productCardContent,
  productMeta,
  upsertWorkAgentChip,
  findWorkRunIndex,
  mergeWorkUnitsIntoTimeline,
} from "./project/product.ts";
