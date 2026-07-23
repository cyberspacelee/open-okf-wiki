/**
 * Produce-owned Operator Event sink (ADR 0029 / 0031).
 * Adapters map these onto product SSE; Session must not invent them.
 *
 * Body channel is parent-visible `work_unit` only (ADR 0031 whitelist).
 */

import type { ParentUnitUpdate } from "./parent-visibility.js";

export type ProduceProgressPhase =
  | "planning"
  | "researching"
  | "writing"
  | "reviewing"
  | "repairing"
  | "done"
  | "failed";

/** Operator-visible supervisor role for work_unit tags. */
export type ProduceAgentRole =
  | "domain"
  | "leaf"
  | "reviewer"
  | "root"
  | "planner";

/**
 * Produce → operator sink.
 * Only whitelist product injects; conversation body is work_unit snapshots.
 */
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
  defects?: (p: {
    round: number;
    clean: boolean;
    defectCount: number;
    summary?: string;
  }) => void;
  /**
   * Parent-visible produce unit (ADR 0031 PVU).
   * Fold last-by-unitId on cold load. Requires runId for trajectory binding.
   */
  workUnit?: (p: ParentUnitUpdate & { runId: string }) => void;
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
      defects: (p) => events.push({ kind: "defects", payload: p }),
      workUnit: (p) => events.push({ kind: "work_unit", payload: p }),
    },
  };
}
