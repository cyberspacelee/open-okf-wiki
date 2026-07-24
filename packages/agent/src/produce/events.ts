/**
 * Coarse, host-local callbacks from the Semantic Workflow.
 *
 * These callbacks are implementation seams for tests and for the owning
 * `wiki_produce` tool. They are not Session events, durable history, or an
 * operator-visible child trail; Pi owns the real tool lifecycle.
 */

export type ProducePhase =
  | "planning"
  | "researching"
  | "writing"
  | "reviewing"
  | "repairing"
  | "done"
  | "failed";

export type ProduceEventSink = {
  progress?: (progress: {
    phase: ProducePhase;
    label?: string;
    written?: number;
    total?: number;
    defectCount?: number;
  }) => void;
  planProgress?: (progress: {
    pages: Array<{ path: string; status: "pending" | "writing" | "done" }>;
  }) => void;
  defects?: (progress: {
    round: number;
    clean: boolean;
    defectCount: number;
    summary?: string;
  }) => void;
};

export const silentProduceEvents: ProduceEventSink = {};

/** Collect the coarse callbacks without inventing Pi events. */
export function recordingProduceEvents(): {
  sink: ProduceEventSink;
  events: Array<{ kind: "progress" | "plan_progress" | "defects"; payload: unknown }>;
} {
  const events: Array<{
    kind: "progress" | "plan_progress" | "defects";
    payload: unknown;
  }> = [];
  return {
    events,
    sink: {
      progress: (payload) => events.push({ kind: "progress", payload }),
      planProgress: (payload) => events.push({ kind: "plan_progress", payload }),
      defects: (payload) => events.push({ kind: "defects", payload }),
    },
  };
}
