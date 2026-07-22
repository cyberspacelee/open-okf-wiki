/**
 * In-memory bus for Pi agent session SSE (product injects + heartbeats).
 * When AgentSession factory lands, pi events should also fan out here.
 */

import type { AgentSseEvent, ProductSseEvent } from "@okf-wiki/contract";

export type AgentSessionEventListener = (event: AgentSseEvent) => void;

type SessionBus = {
  sequence: number;
  listeners: Set<AgentSessionEventListener>;
  recent: AgentSseEvent[];
};

const buses = new Map<string, SessionBus>();
const MAX_RECENT = 256;

function busKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}::${sessionId}`;
}

function getOrCreateBus(workspaceId: string, sessionId: string): SessionBus {
  const key = busKey(workspaceId, sessionId);
  let bus = buses.get(key);
  if (!bus) {
    bus = { sequence: 0, listeners: new Set(), recent: [] };
    buses.set(key, bus);
  }
  return bus;
}

function nextSequence(bus: SessionBus): number {
  bus.sequence += 1;
  return bus.sequence;
}

function publish(
  workspaceId: string,
  sessionId: string,
  event: AgentSseEvent,
): AgentSseEvent {
  const bus = getOrCreateBus(workspaceId, sessionId);
  const withSeq: AgentSseEvent =
    "sequence" in event && event.sequence !== undefined
      ? event
      : ({ ...event, sequence: nextSequence(bus) } as AgentSseEvent);

  bus.recent.push(withSeq);
  if (bus.recent.length > MAX_RECENT) {
    bus.recent.splice(0, bus.recent.length - MAX_RECENT);
  }
  for (const listener of bus.listeners) {
    try {
      listener(withSeq);
    } catch {
      // Never let a bad subscriber break the bus.
    }
  }
  return withSeq;
}

/** Emit a typed product inject (run_phase | gate | run_link). */
export function emitProductAgentEvent(
  workspaceId: string,
  event: ProductSseEvent,
): AgentSseEvent {
  return publish(workspaceId, event.sessionId, event);
}

/** Emit an opaque Pi / server event on the session bus. */
export function emitAgentSessionEvent(
  workspaceId: string,
  sessionId: string,
  event: AgentSseEvent,
): AgentSseEvent {
  return publish(workspaceId, sessionId, event);
}

export function getRecentAgentSessionEvents(
  workspaceId: string,
  sessionId: string,
): AgentSseEvent[] {
  const bus = buses.get(busKey(workspaceId, sessionId));
  if (!bus) {
    return [];
  }
  return bus.recent.slice();
}

export function subscribeAgentSessionEvents(
  workspaceId: string,
  sessionId: string,
  listener: AgentSessionEventListener,
): () => void {
  const bus = getOrCreateBus(workspaceId, sessionId);
  bus.listeners.add(listener);
  return () => {
    bus.listeners.delete(listener);
    if (bus.listeners.size === 0 && bus.recent.length === 0) {
      buses.delete(busKey(workspaceId, sessionId));
    }
  };
}

/** Test helper: drop all buses. */
export function resetAgentSessionEventBusesForTests(): void {
  buses.clear();
}
