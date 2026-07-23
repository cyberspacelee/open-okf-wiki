/**
 * Pure projection of Operator Session → transcript + work units fold.
 *
 * ADR 0031:
 * - Parent Pi events → main timeline (applyPiEvent)
 * - Product whitelist → cards + work_block anchors; work_unit → units fold only
 * - WorkUnits is a fold cache only (last-by-unitId), not durability authority
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
  WorkUnitEventLike,
  WorkUnits,
  WorkUnitView,
} from "./project/types.ts";

export {
  compactToolInput,
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  formatPayloadText,
  formatToolDisplay,
  formatToolResultText,
  makeId,
  safeStringify,
  toolPathLabel,
  type ToolDisplaySummary,
} from "./project/format.ts";

export {
  applyWorkUnit,
  unitRecentActivity,
  workBlockProgress,
  workUnitHasBody,
  workUnitsFromList,
  workUnitToolsToAgentTools,
} from "./project/work-unit.ts";

export { applyPiEvent } from "./project/pi.ts";

export {
  applyProductEvent,
  ensureWorkBlockAnchors,
  findWorkBlockIndex,
  isTerminalOrWaitingPhase,
  lastAssistantIsError,
  productCardContent,
  productMeta,
  unitsForRun,
} from "./project/product.ts";

export { formatProductCardContent } from "./project/product-copy.ts";
