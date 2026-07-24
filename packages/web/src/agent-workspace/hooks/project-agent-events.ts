/** Public seam for the Pi-only Agent Workspace projector (ADR 0032). */

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
  projectAgentEvent,
  projectPiHistory,
  reducePiEvent,
  viewMessages,
} from "./project/pi.ts";
export type {
  AgentContentPart,
  AgentMessage,
  AgentMessageRole,
  AgentSseLike,
  AgentToolCall,
  PiHistoryMessage,
  PiStreamState,
} from "./project/types.ts";
