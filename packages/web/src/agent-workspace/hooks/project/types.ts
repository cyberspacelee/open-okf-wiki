/**
 * Shared types for Operator Session projection (Pi-native + thin product).
 *
 * ADR 0031: authority is parent Pi message snapshots (live SSE / cold JSONL).
 * Product injects are thin strips only (run_link | run_phase | gate |
 * plan_progress | defects). No second body channel.
 */

export type AgentMessageRole = "user" | "assistant" | "tool" | "system";

export type AgentToolCall = {
  id: string;
  name: string;
  input?: string;
  output?: string;
  status: "pending" | "running" | "done" | "error";
};

/**
 * Ordered transcript parts for one assistant turn (Pi content[] order).
 * Tools are referenced by id; execution status lives on `AgentMessage.tools`.
 */
export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool"; toolId: string };

export type PlanProgressPage = {
  path: string;
  status: "pending" | "writing" | "done" | string;
};

/**
 * Product / view meta on a timeline row (whitelist injects only).
 */
export type AgentProductMeta = {
  kind: "run_phase" | "gate" | "run_link" | "plan_progress" | "defects";
  phase?: string;
  gate?: "plan" | "publication";
  runId?: string;
  status?: string;
  question?: string;
  /** Publication gate / plan_progress page paths. */
  pages?: string[] | PlanProgressPage[];
  label?: string;
  parentId?: string;
  receiptPath?: string;
  detail?: string;
  task?: string;
  defectCount?: number;
  clean?: boolean;
  round?: number;
};

/**
 * Thin view model derived from Pi message snapshots (not a dual store).
 * `content` / `thinking` / `tools` come from content blocks or tool_execution_*.
 * `parts` preserves interleaving (text → tool → text) for chronological render.
 */
export type AgentMessage = {
  id: string;
  role: AgentMessageRole;
  content: string;
  /** Streamed / final thinking (Pi type:"thinking" blocks). */
  thinking?: string;
  thinkingStatus?: "streaming" | "done";
  createdAt: string;
  tools?: AgentToolCall[];
  /**
   * Chronological body parts (text / thinking / tool refs).
   * When present, UI renders these instead of dumping all text then all tools.
   */
  parts?: AgentContentPart[];
  status?: string;
  /** Provider / agent error when status is "error". */
  errorMessage?: string;
  product?: AgentProductMeta;
};

/**
 * Pi-web style stream state: finalized messages + one streaming snapshot.
 */
export type PiStreamState = {
  messages: AgentMessage[];
  /** Latest in-flight assistant snapshot, or null when idle. */
  streamingMessage: AgentMessage | null;
  /** Last finalized (or streaming) assistant id — tools attach here. */
  lastAssistantId: string | null;
  /** True between agent_start and agent_end/agent_settled. */
  turnActive: boolean;
};

/** @deprecated Use PiStreamState; kept as alias for fixture imports during migration. */
export type StreamingRefs = PiStreamState;

/** Loose product SSE row accepted by projectors (whitelist kinds only). */
export type ProductSseLike = {
  kind: "run_phase" | "gate" | "run_link" | "plan_progress" | "defects";
  phase?: string;
  gate?: "plan" | "publication";
  runId?: string;
  status?: string;
  question?: string;
  message?: string | { thinking?: string; text?: string };
  pages?: string[] | PlanProgressPage[];
  plan?: unknown;
  timestamp?: string;
  label?: string;
  parentId?: string;
  receiptPath?: string;
  detail?: string;
  task?: string;
  round?: number;
  clean?: boolean;
  defectCount?: number;
  summary?: string;
};
