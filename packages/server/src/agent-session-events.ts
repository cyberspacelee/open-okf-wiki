/**
 * Ephemeral fan-out for genuine live Pi events.
 *
 * Durable history comes from SessionManager and is sent as the first SSE
 * snapshot. This module deliberately has no replay, sequence, or product
 * event channel.
 */
import type { AgentSseEvent } from "@okf-wiki/contract";

export type PiAgentSessionEvent = Extract<AgentSseEvent, { source: "pi" }>;
export type AgentSessionEventListener = (event: PiAgentSessionEvent) => void;

const listeners = new Map<string, Set<AgentSessionEventListener>>();

function sessionKey(workspaceId: string, sessionId: string): string {
  return workspaceId + "::" + sessionId;
}

/** Forward one event emitted by the live parent AgentSession. */
export function emitAgentSessionEvent(
  workspaceId: string,
  sessionId: string,
  event: PiAgentSessionEvent,
): PiAgentSessionEvent {
  const current = listeners.get(sessionKey(workspaceId, sessionId));
  if (!current) return event;
  for (const listener of current) {
    try {
      listener(event);
    } catch {
      // A disconnected response must not break the parent AgentSession.
    }
  }
  return event;
}

export function subscribeAgentSessionEvents(
  workspaceId: string,
  sessionId: string,
  listener: AgentSessionEventListener,
): () => void {
  const key = sessionKey(workspaceId, sessionId);
  const current = listeners.get(key) ?? new Set<AgentSessionEventListener>();
  current.add(listener);
  listeners.set(key, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

/** Test helper. */
export function resetAgentSessionEventBusesForTests(): void {
  listeners.clear();
}
