/**
 * Mid-flight session catch-up after hard refresh / background poll.
 *
 * Durable journal (GET session) is source of truth. Ephemeral `run-live-*`
 * bubbles from run SSE must never block accepting journal updates (that freeze
 * left the UI stuck on "Wiki Run in progress" while the server kept writing).
 */

export const RUN_LIVE_MSG_PREFIX = "run-live-";

export function isEphemeralRunLiveMessageId(id: string): boolean {
  return id.startsWith(RUN_LIVE_MSG_PREFIX);
}

export function stripEphemeralRunLiveMessages<T extends { id: string }>(
  messages: T[],
): T[] {
  return messages.filter((m) => !isEphemeralRunLiveMessageId(m.id));
}

export type CatchUpSessionMeta = {
  status?: string;
  workflow?: { phase?: string | null } | null;
};

/** Session is mid wiki-run (planning/writing) — catch-up poll is active. */
export function isSessionMidFlight(meta: CatchUpSessionMeta): boolean {
  const phase = meta.workflow?.phase;
  return (
    meta.status === "running" ||
    phase === "planning" ||
    phase === "writing"
  );
}

/**
 * Merge durable journal messages (`next`) into the local chat timeline (`prev`).
 *
 * - Empty journal never wipes local history.
 * - Ephemeral run-live SSE rows are ignored for length comparisons and dropped
 *   when accepting durable next (or when keeping prev under a shrink race).
 * - Mid-flight: refuse to shrink the durable timeline (transient partial write).
 * - Idle/terminal: always prefer durable next when non-empty.
 */
export function mergeSessionCatchUpTimeline<T extends { id: string }>(
  prev: T[],
  next: T[],
  meta: CatchUpSessionMeta,
): T[] {
  if (next.length === 0) {
    return prev;
  }
  const prevDurable = stripEphemeralRunLiveMessages(prev);
  if (next.length < prevDurable.length && isSessionMidFlight(meta)) {
    return prevDurable;
  }
  return next;
}

export type RunSseCatchUpEvent = {
  type?: string;
  message?: string;
  status?: string;
  text?: string;
};

export type RunSseCatchUpAction =
  | { action: "ignore" }
  | { action: "tick" }
  | { action: "line"; line: string };

const TERMINAL_RUN_STATUSES = new Set([
  "awaiting_plan",
  "awaiting_publication",
  "published",
  "failed",
  "cancelled",
  "publication_declined",
]);

/**
 * Classify a run SSE event for the Session mid-flight UI.
 *
 * Status/error/done (and terminal status fields) only trigger a journal poll —
 * they must not become chat bubbles. Empty-bus reconnect always sends a status
 * snapshot like "Wiki Run in progress"; treating that as a message froze catch-up.
 */
export function classifyRunSseForSessionCatchUp(
  event: RunSseCatchUpEvent,
): RunSseCatchUpAction {
  if (event.type === "done") {
    return { action: "tick" };
  }
  if (event.type === "status" || event.type === "error") {
    return { action: "tick" };
  }
  if (event.status && TERMINAL_RUN_STATUSES.has(event.status)) {
    return { action: "tick" };
  }
  const line = (event.message || event.text || "").trim();
  if (!line) {
    if (event.status) {
      return { action: "tick" };
    }
    return { action: "ignore" };
  }
  return { action: "line", line };
}

/**
 * Append an ephemeral progress line (or no-op if it duplicates the last bubble).
 * Pure: returns the next message list.
 */
export function appendEphemeralRunLiveLine<
  T extends { id: string; role: string; parts: unknown[] },
>(
  prev: T[],
  line: string,
  create: (id: string, line: string) => T,
  now: () => number = () => Date.now(),
): T[] {
  const id = `${RUN_LIVE_MSG_PREFIX}${now()}`;
  const last = prev[prev.length - 1];
  if (
    last &&
    last.role === "assistant" &&
    isEphemeralRunLiveMessageId(last.id) &&
    last.parts.some(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        "type" in p &&
        (p as { type?: string }).type === "text" &&
        "text" in p &&
        String((p as { text?: unknown }).text).endsWith(line),
    )
  ) {
    return prev;
  }
  return [...prev, create(id, line)];
}
