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
    role: "domain" | "leaf" | "reviewer" | "root" | "planner";
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
    },
  };
}
