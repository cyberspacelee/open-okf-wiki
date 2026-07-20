/** Mirrors contract ToolPartState for the web package. */
export type ToolPartState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

/**
 * Normalized Session timeline item (AI SDK UIMessage-part inspired).
 * Built from RunSseEvent on the client.
 */
export type SessionTimelineItem =
  | {
      kind: "text";
      id: string;
      text: string;
      nodeId?: string;
    }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      toolCallId?: string;
      toolState?: ToolPartState;
      inputSummary?: string;
      outputSummary?: string;
      nodeId?: string;
    }
  | {
      kind: "status";
      id: string;
      message: string;
      status?: string;
    };
