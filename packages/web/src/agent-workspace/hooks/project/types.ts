/** View types projected directly from one Pi Operator Session. */

import type { AgentSseEvent, WikiProduceToolDetails } from "@okf-wiki/contract";

export type AgentMessageRole = "user" | "assistant" | "tool" | "system";

export type AgentToolCall = {
  id: string;
  name: string;
  input?: string;
  output?: string;
  /** Structured details emitted by the real Pi wiki_produce tool. */
  details?: WikiProduceToolDetails;
  status: "pending" | "running" | "done" | "error";
};

/** Ordered Pi assistant content; tool status lives on AgentMessage.tools. */
export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool"; toolId: string };

export type AgentMessage = {
  id: string;
  role: AgentMessageRole;
  content: string;
  thinking?: string;
  thinkingStatus?: "streaming" | "done";
  createdAt: string;
  tools?: AgentToolCall[];
  parts?: AgentContentPart[];
  status?: "streaming" | "done" | "error" | "aborted";
  errorMessage?: string;
};

/** Durable Pi message shape retained by SessionManager. */
export type PiHistoryMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
};

/** Shared transport interface. Pi still owns event payload internals. */
export type AgentSseLike = AgentSseEvent;

/** Finalized durable rows plus at most one live Pi assistant snapshot. */
export type PiStreamState = {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  lastAssistantId: string | null;
  turnActive: boolean;
};
