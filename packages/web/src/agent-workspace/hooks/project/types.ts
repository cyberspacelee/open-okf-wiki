/**
 * Shared types for Operator Session projection (transcript + work units).
 *
 * ADR 0031: pure fold types only. work_unit body lives in WorkUnits fold;
 * timeline may carry a thin work_block anchor (UI-only, not a product inject).
 */

import type { WorkUnitStatus, WorkUnitToolState } from "@okf-wiki/contract";

export type AgentMessageRole = "user" | "assistant" | "tool" | "system";

export type AgentToolCall = {
  id: string;
  name: string;
  input?: string;
  output?: string;
  status: "pending" | "running" | "done" | "error";
};

export type PlanProgressPage = {
  path: string;
  status: "pending" | "writing" | "done" | string;
};

/**
 * Product / view meta on a timeline row.
 * `work_block` is a client-only anchor for the Work block (not an SSE inject kind).
 */
export type AgentProductMeta = {
  kind:
    | "run_phase"
    | "gate"
    | "run_link"
    | "progress"
    | "plan_progress"
    | "defects"
    | "work_block";
  phase?: string;
  gate?: "plan" | "publication";
  runId?: string;
  status?: string;
  question?: string;
  /** Publication gate page paths (when known). */
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
 * Fold-cache view of one produce work unit (from product work_unit events).
 * Empty running (no message/tools) must not be labeled as model "thinking".
 */
export type WorkUnitView = {
  unitId: string;
  role: string;
  status: WorkUnitStatus;
  runId?: string;
  task?: string;
  parentId?: string;
  message?: { thinking?: string; text?: string };
  tools?: Array<{
    toolCallId: string;
    toolName: string;
    state: WorkUnitToolState["state"];
    input?: unknown;
    output?: unknown;
    errorText?: string;
  }>;
  summary?: string;
  receiptPath?: string;
  error?: string;
  updatedAt?: number;
};

/** unitId → last-write fold (cache only). */
export type WorkUnits = Record<string, WorkUnitView>;

export type AgentMessage = {
  id: string;
  role: AgentMessageRole;
  content: string;
  /** Streamed / final thinking (Pi type:"thinking" blocks + thinking_delta). */
  thinking?: string;
  thinkingStatus?: "streaming" | "done";
  createdAt: string;
  tools?: AgentToolCall[];
  status?: string;
  /** Provider / agent error when status is "error". */
  errorMessage?: string;
  product?: AgentProductMeta;
};

export type StreamCursor = {
  /** In-flight assistant bubble id (null between assistant messages). */
  streamingAssistantId: string | null;
  /** Last assistant bubble in the current turn (tools attach here). */
  lastAssistantId: string | null;
  /**
   * True between agent_start and agent_end/agent_settled.
   * While active, pre-tool and post-tool assistant segments share one bubble.
   */
  turnActive: boolean;
};

export type StreamingRefs = StreamCursor;

/** Loose product SSE / trajectory row accepted by projectors. */
export type ProductSseLike = {
  kind:
    | "run_phase"
    | "gate"
    | "run_link"
    | "progress"
    | "plan_progress"
    | "defects"
    | "work_unit";
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
  /** work_unit fields */
  unitId?: string;
  role?: string;
  tools?: WorkUnitView["tools"];
  error?: string;
  updatedAt?: number;
};

/** Subset of ProductWorkUnitEvent used by applyWorkUnit (no source/sessionId required). */
export type WorkUnitEventLike = {
  kind?: "work_unit";
  unitId: string;
  role: string;
  status: WorkUnitStatus | string;
  runId?: string;
  task?: string;
  parentId?: string;
  message?: { thinking?: string; text?: string };
  tools?: WorkUnitView["tools"];
  summary?: string;
  receiptPath?: string;
  error?: string;
  updatedAt?: number;
};
