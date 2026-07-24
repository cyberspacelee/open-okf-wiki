/** Public seam for the Pi-only Agent Workspace projector (ADR 0032). */

export {
  formatToolDisplay,
  formatToolResultText,
  makeId,
} from "./project/format.ts";
export { createPiStreamState, projectAgentEvent, viewMessages } from "./project/pi.ts";
export type {
  AgentMessage,
  AgentSseLike,
  AgentToolCall,
  PiStreamState,
} from "./project/types.ts";
