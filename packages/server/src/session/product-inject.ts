/**
 * Product inject boundary (ADR 0031).
 *
 * assertProductInject → live SSE bus only.
 * Whitelist: run_link | run_phase | gate | plan_progress | defects.
 * No trajectory body store (operator thin strip is live + Run Record / shell).
 */

import {
  assertProductInject,
  type ProductSseEvent,
  type WikiRunPlan,
  type WikiRunRecordStatus,
} from "@okf-wiki/contract";
import { updateRunRecord } from "@okf-wiki/core";
import { emitProductAgentEvent } from "../agent-session-events.ts";

/** Minimal session target for product injects. */
export type ProductInjectTarget = {
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  runId?: string;
};

export type ProductPhase = Extract<ProductSseEvent, { kind: "run_phase" }>["phase"];

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Assert whitelist and fan out on the session SSE bus.
 * Durability for cold-load is Run Record + session meta + Pi JSONL — not a
 * second product body store.
 */
export function injectProductEvent(target: ProductInjectTarget, event: ProductSseEvent): void {
  assertProductInject(event.kind);
  emitProductAgentEvent(target.workspaceId, event);
}

/** Emit run_phase product inject (+ optional Run Record status sync). */
export function emitPhase(
  entry: ProductInjectTarget,
  phase: ProductPhase,
  message?: string,
  status?: WikiRunRecordStatus,
): void {
  injectProductEvent(entry, {
    source: "product",
    kind: "run_phase",
    sessionId: entry.sessionId,
    runId: entry.runId,
    phase,
    status,
    message,
    timestamp: nowIso(),
  });
  if (status && entry.runId) {
    void updateRunRecord(entry.workspaceRoot, entry.runId, { status }).catch(() => {
      // best-effort; SSE still carries status
    });
  }
}

/** Emit gate product inject. */
export function emitGate(
  entry: ProductInjectTarget,
  gate: "plan" | "publication",
  question: string,
  plan?: WikiRunPlan,
  pages?: string[],
): void {
  injectProductEvent(entry, {
    source: "product",
    kind: "gate",
    sessionId: entry.sessionId,
    runId: entry.runId,
    gate,
    question,
    plan,
    pages,
    timestamp: nowIso(),
  });
}

/** Last emitted run_link status per session+run (avoid spam on every phase tick). */
const lastRunLinkStatus = new Map<string, string>();

function runLinkKey(sessionId: string, runId: string): string {
  return `${sessionId}\0${runId}`;
}

/** Emit run_link product inject (deduped when status unchanged). */
export function emitRunLink(entry: ProductInjectTarget, status?: WikiRunRecordStatus): void {
  if (!entry.runId) return;
  const key = runLinkKey(entry.sessionId, entry.runId);
  const statusKey = status ?? "";
  if (lastRunLinkStatus.get(key) === statusKey) {
    return;
  }
  lastRunLinkStatus.set(key, statusKey);
  injectProductEvent(entry, {
    source: "product",
    kind: "run_link",
    sessionId: entry.sessionId,
    runId: entry.runId,
    status,
    timestamp: nowIso(),
  });
}

/** Test helper: clear run_link emit dedupe (process-local). */
export function resetRunLinkDedupeForTests(): void {
  lastRunLinkStatus.clear();
}
