import type { RunSseEvent, WikiRunRecordStatus } from "@okf-wiki/contract";

export type RunEventListener = (event: RunSseEvent) => void;

type RunBus = {
  sequence: number;
  listeners: Set<RunEventListener>;
  /** Ring buffer of recent events for late subscribers (status snapshot covers most cases). */
  recent: RunSseEvent[];
};

const buses = new Map<string, RunBus>();
const MAX_RECENT = 64;

function getOrCreateBus(runId: string): RunBus {
  let bus = buses.get(runId);
  if (!bus) {
    bus = { sequence: 0, listeners: new Set(), recent: [] };
    buses.set(runId, bus);
  }
  return bus;
}

/**
 * Emit a progress event to all subscribers of `runId`.
 * Sequence numbers are assigned monotonically per run.
 */
export function emitRunEvent(
  runId: string,
  partial: Omit<RunSseEvent, "runId" | "sequence"> & { sequence?: number },
): RunSseEvent {
  const bus = getOrCreateBus(runId);
  bus.sequence += 1;
  const event: RunSseEvent = {
    type: partial.type,
    runId,
    sequence: partial.sequence ?? bus.sequence,
    ...(partial.status !== undefined ? { status: partial.status } : {}),
    ...(partial.message !== undefined ? { message: partial.message } : {}),
  };
  bus.recent.push(event);
  if (bus.recent.length > MAX_RECENT) {
    bus.recent.splice(0, bus.recent.length - MAX_RECENT);
  }
  for (const listener of bus.listeners) {
    try {
      listener(event);
    } catch {
      // Never let a bad subscriber break the bus.
    }
  }
  return event;
}

/** Convenience: status-change event. */
export function emitRunStatus(
  runId: string,
  status: WikiRunRecordStatus,
  message?: string,
): RunSseEvent {
  return emitRunEvent(runId, {
    type: status === "failed" ? "error" : "status",
    status,
    message,
  });
}

/** Convenience: terminal `done` event (closes SSE after delivery). */
export function emitRunDone(
  runId: string,
  status: WikiRunRecordStatus,
  message?: string,
): RunSseEvent {
  return emitRunEvent(runId, {
    type: "done",
    status,
    message,
  });
}

/**
 * Subscribe to subsequent events for `runId`.
 * Returns an unsubscribe function.
 */
export function subscribeRunEvents(
  runId: string,
  listener: RunEventListener,
): () => void {
  const bus = getOrCreateBus(runId);
  bus.listeners.add(listener);
  return () => {
    bus.listeners.delete(listener);
    // Drop idle buses to avoid unbounded growth across many runs.
    if (bus.listeners.size === 0 && bus.recent.length === 0) {
      buses.delete(runId);
    }
  };
}

/** In-flight AbortControllers for running agents (best-effort cancel). */
const abortControllers = new Map<string, AbortController>();

export function registerRunAbortController(runId: string): AbortSignal {
  // Replace any stale controller for the same id (should not happen).
  const existing = abortControllers.get(runId);
  if (existing) {
    existing.abort();
  }
  const controller = new AbortController();
  abortControllers.set(runId, controller);
  return controller.signal;
}

export function abortRun(runId: string): boolean {
  const controller = abortControllers.get(runId);
  if (!controller) {
    return false;
  }
  controller.abort();
  return true;
}

export function clearRunAbortController(runId: string): void {
  abortControllers.delete(runId);
}

/** Test/helper: drop all buses (not used in production paths). */
export function _resetRunEventBusesForTests(): void {
  buses.clear();
  abortControllers.clear();
}
