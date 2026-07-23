/**
 * Coalesce high-frequency work_unit product injects (ADR 0031).
 *
 * Pure message/thinking/text streaming is debounced per unitId (~rAF).
 * Structural / terminal updates always flush immediately so SSE + trajectory
 * never drop open/pending, tool map changes, settled, or failed.
 */

import type { ProductWorkUnitEvent, WorkUnitToolState } from "@okf-wiki/contract";

/** Default coalesce window for pure message streaming (16–50ms band). */
export const WORK_UNIT_COALESCE_MS = 32;

export type WorkUnitCoalesceTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type WorkUnitCoalescer = {
  /** Accept a mapped product work_unit; may delay pure streaming updates. */
  push(event: ProductWorkUnitEvent): void;
  /** Flush one unit's pending snapshot (if any). */
  flush(unitId: string): void;
  /** Flush all pending units (e.g. run teardown). */
  flushAll(): void;
  /** Cancel timers without emitting. */
  dispose(): void;
};

type PendingSlot = {
  event: ProductWorkUnitEvent;
  timer: unknown;
};

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sameTools(
  a: readonly WorkUnitToolState[] | undefined,
  b: readonly WorkUnitToolState[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a?.length && !b?.length) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.toolCallId !== y.toolCallId) return false;
    if (x.toolName !== y.toolName) return false;
    if (x.state !== y.state) return false;
    if (x.errorText !== y.errorText) return false;
    if (stableJson(x.input) !== stableJson(y.input)) return false;
    if (stableJson(x.output) !== stableJson(y.output)) return false;
  }
  return true;
}

/**
 * True when `next` is a pure streaming body tick relative to last *emitted*
 * snapshot: same structural fields, only message/updatedAt/timestamp may differ.
 * Never coalesce pending / settled / failed or first-open (no prior emit).
 */
export function isCoalesceableWorkUnitUpdate(
  prev: ProductWorkUnitEvent | undefined,
  next: ProductWorkUnitEvent,
): boolean {
  if (
    next.status === "pending" ||
    next.status === "settled" ||
    next.status === "failed"
  ) {
    return false;
  }
  if (!prev) return false;
  if (prev.status !== next.status) return false;
  if (prev.role !== next.role) return false;
  if (prev.task !== next.task) return false;
  if (prev.parentId !== next.parentId) return false;
  if (prev.summary !== next.summary) return false;
  if (prev.receiptPath !== next.receiptPath) return false;
  if (prev.error !== next.error) return false;
  if (prev.runId !== next.runId) return false;
  if (!sameTools(prev.tools, next.tools)) return false;
  return true;
}

export type CreateWorkUnitCoalescerOpts = {
  /** Deliver a work_unit to SSE + trajectory (caller still assertProductInject). */
  emit: (event: ProductWorkUnitEvent) => void;
  /** Coalesce window; default WORK_UNIT_COALESCE_MS. */
  windowMs?: number;
  /** Injectable timers for tests. */
  timers?: WorkUnitCoalesceTimers;
};

/**
 * Per-session coalescer: Map unitId → pending timer + latest snapshot.
 * Create one instance per `mapOrchestratorOnEvent` handler (one run stream).
 */
export function createWorkUnitCoalescer(
  opts: CreateWorkUnitCoalescerOpts,
): WorkUnitCoalescer {
  const windowMs = opts.windowMs ?? WORK_UNIT_COALESCE_MS;
  const timers: WorkUnitCoalesceTimers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    },
  };

  const pending = new Map<string, PendingSlot>();
  const lastEmitted = new Map<string, ProductWorkUnitEvent>();

  const clearTimer = (slot: PendingSlot | undefined): void => {
    if (!slot) return;
    timers.clearTimeout(slot.timer);
  };

  const emitNow = (event: ProductWorkUnitEvent): void => {
    opts.emit(event);
    lastEmitted.set(event.unitId, event);
  };

  const flush = (unitId: string): void => {
    const slot = pending.get(unitId);
    if (!slot) return;
    clearTimer(slot);
    pending.delete(unitId);
    emitNow(slot.event);
  };

  const dropPending = (unitId: string): void => {
    const slot = pending.get(unitId);
    if (!slot) return;
    clearTimer(slot);
    pending.delete(unitId);
  };

  const schedule = (event: ProductWorkUnitEvent): void => {
    const unitId = event.unitId;
    const existing = pending.get(unitId);
    if (existing) {
      existing.event = event;
      return;
    }
    const slot: PendingSlot = {
      event,
      timer: null,
    };
    slot.timer = timers.setTimeout(() => {
      const current = pending.get(unitId);
      if (!current || current !== slot) return;
      pending.delete(unitId);
      emitNow(current.event);
    }, windowMs);
    pending.set(unitId, slot);
  };

  const push = (event: ProductWorkUnitEvent): void => {
    const unitId = event.unitId;

    // Terminal: flush any coalesced body first, then emit settled/failed.
    if (event.status === "settled" || event.status === "failed") {
      flush(unitId);
      emitNow(event);
      return;
    }

    const prev = lastEmitted.get(unitId);
    if (isCoalesceableWorkUnitUpdate(prev, event)) {
      schedule(event);
      return;
    }

    // Structural / open / tool change: supersede pending with this snapshot.
    dropPending(unitId);
    emitNow(event);
  };

  const flushAll = (): void => {
    for (const unitId of [...pending.keys()]) {
      flush(unitId);
    }
  };

  const dispose = (): void => {
    for (const unitId of [...pending.keys()]) {
      dropPending(unitId);
    }
  };

  return { push, flush, flushAll, dispose };
}
