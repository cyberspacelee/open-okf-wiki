/**
 * Concurrent Session chat turn lock (in-process + durable TTL decision).
 * Pure dual-lock helpers live here so routes stay thin and unit tests avoid HTTP.
 */

import path from "node:path";
import type { OperatorSession } from "@okf-wiki/contract";
import { isSessionTurnLocked } from "@okf-wiki/core";

/**
 * In-process lock so rapid double-submit cannot start two Wiki Runs before
 * the first turn finalizes session messages. Keyed by workspace root + session.
 */
const sessionChatInFlight = new Set<string>();

export function sessionChatLockKey(rootPath: string, sessionId: string): string {
  return `${path.resolve(rootPath)}::${sessionId}`;
}

/**
 * Dual lock decision (pure): in-process Set OR durable session.status=running TTL.
 * Extracted so unit tests can assert concurrent-turn rejection without HTTP.
 */
export function isSessionChatTurnBlocked(input: {
  inFlight: boolean;
  wouldRunWorkflow: boolean;
  session: Pick<OperatorSession, "status" | "updatedAt">;
  nowMs?: number;
}): boolean {
  return (
    input.inFlight ||
    (input.wouldRunWorkflow &&
      isSessionTurnLocked(input.session, input.nowMs))
  );
}

export function acquireSessionChatLock(key: string): boolean {
  if (sessionChatInFlight.has(key)) {
    return false;
  }
  sessionChatInFlight.add(key);
  return true;
}

export function releaseSessionChatLock(key: string): void {
  sessionChatInFlight.delete(key);
}

export function hasSessionChatLock(key: string): boolean {
  return sessionChatInFlight.has(key);
}

/** Test helper: mark / clear in-process lock without opening a chat stream. */
export function setSessionChatInFlightForTests(
  key: string,
  inFlight: boolean,
): void {
  if (inFlight) {
    sessionChatInFlight.add(key);
  } else {
    sessionChatInFlight.delete(key);
  }
}

export function isSessionChatInFlightForTests(key: string): boolean {
  return sessionChatInFlight.has(key);
}
