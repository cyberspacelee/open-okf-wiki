/**
 * Pure projection of Operator Session → transcript + thin product strips.
 *
 * ADR 0031:
 * - Parent Pi events → snapshot reducer (reducePiEvent)
 * - Product whitelist → thin cards only (no body channel)
 * - Produce units → last-by-unitId fold from wiki_produce tool details / cold load
 */

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
  type ToolDisplaySummary,
  toolPathLabel,
} from "./project/format.ts";
export {
  createPiStreamState,
  reducePiEvent,
  viewMessages,
} from "./project/pi.ts";
export {
  buildProduceTree,
  flattenProduceTree,
  foldProduceToolDetails,
  foldProduceUnit,
  orderProduceUnits,
  produceDisplayRoots,
  produceUnitsActive,
  type ProduceUnit,
  type ProduceUnitMessage,
  type ProduceUnitRole,
  type ProduceUnitStatus,
  type ProduceUnitTool,
  type ProduceUnitTrailItem,
  parseProduceUnitPayload,
  produceUnitFromToolPayload,
  produceUnitKey,
  produceUnitRoles,
  seedProduceUnits,
  WIKI_PRODUCE_TOOL_NAME,
} from "./project/produce.ts";
export {
  applyProductEvent,
  isTerminalOrWaitingPhase,
  lastAssistantIsError,
  productCardContent,
  productMeta,
} from "./project/product.ts";
export { formatProductCardContent } from "./project/product-copy.ts";
export type {
  AgentContentPart,
  AgentMessage,
  AgentMessageRole,
  AgentProductMeta,
  AgentToolCall,
  PiStreamState,
  PlanProgressPage,
  ProductSseLike,
  StreamingRefs,
} from "./project/types.ts";
