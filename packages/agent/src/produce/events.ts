/**
 * Produce-owned business Operator Event sink (ADR 0029).
 * Adapters map these onto product SSE; Session must not invent them.
 */

export type ProduceProgressPhase =
  | "planning"
  | "researching"
  | "writing"
  | "reviewing"
  | "repairing"
  | "done"
  | "failed";

/** Operator-visible supervisor role for agent_span / child stream tags. */
export type ProduceAgentRole =
  | "domain"
  | "leaf"
  | "reviewer"
  | "root"
  | "planner";

/**
 * Live Pi event from a produce child session (planner / domain / leaf / reviewer).
 * Server fans these out as `source:"pi"` with `okfAgent` metadata so the UI can
 * stream thinking / text / tools under the correct span.
 */
export type ProduceChildPiEvent = {
  agentId: string;
  role: ProduceAgentRole;
  /** Pi AgentSession event type (`message_update`, `tool_execution_start`, …). */
  kind: string;
  /** Full Pi event payload (type + message + assistantMessageEvent + …). */
  payload: unknown;
};

export type ProduceEventSink = {
  progress?: (p: {
    phase: ProduceProgressPhase;
    label?: string;
    written?: number;
    total?: number;
    defectCount?: number;
  }) => void;
  planProgress?: (p: {
    pages: Array<{ path: string; status: "pending" | "writing" | "done" }>;
  }) => void;
  agentSpan?: (p: {
    spanId: string;
    agentId: string;
    role: ProduceAgentRole;
    status: "running" | "complete" | "failed";
    promptSummary?: string;
    /** Expandable preview body (capped). */
    detail?: string;
    /** Short task description for the span card. */
    task?: string;
    parentId?: string;
    runId: string;
    error?: string;
    receiptPath?: string;
  }) => void;
  defects?: (p: {
    round: number;
    clean: boolean;
    defectCount: number;
    summary?: string;
  }) => void;
  /** Stream child Pi session events (thinking / text / tools) to the operator. */
  childPiEvent?: (p: ProduceChildPiEvent) => void;
};

/** No-op sink for tests / CLI silence. */
export const silentProduceEvents: ProduceEventSink = {};

/** Collect events for unit tests. */
export function recordingProduceEvents(): {
  sink: ProduceEventSink;
  events: Array<{ kind: string; payload: unknown }>;
} {
  const events: Array<{ kind: string; payload: unknown }> = [];
  return {
    events,
    sink: {
      progress: (p) => events.push({ kind: "progress", payload: p }),
      planProgress: (p) => events.push({ kind: "plan_progress", payload: p }),
      agentSpan: (p) => events.push({ kind: "agent_span", payload: p }),
      defects: (p) => events.push({ kind: "defects", payload: p }),
      childPiEvent: (p) => events.push({ kind: "child_pi", payload: p }),
    },
  };
}
