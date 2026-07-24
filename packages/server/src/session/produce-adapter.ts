/**
 * Map produce / WikiRun orchestrator job events → thin product SSE injects.
 *
 * ADR 0031 product whitelist only: run_link | run_phase | gate | plan_progress | defects.
 * No product body channel / no work_unit inject.
 *
 * Parent-visible produce trail (official Pi tool shape):
 * - Live: host-driven `wiki_produce` tool_execution_* on Operator Session (emitPi)
 * - Cold: toolResult.details + optional okf.produce_progress custom entries
 */

import type { WikiRunShellState } from "@okf-wiki/agent";
import type { WikiRunPlan, WikiRunRecordStatus } from "@okf-wiki/contract";
import { emitAgentSessionEvent } from "../agent-session-events.ts";
import {
  emitGate,
  emitPhase,
  emitRunLink,
  injectProductEvent,
  type ProductInjectTarget,
  type ProductPhase,
} from "./product-inject.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonPayload(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, v) => {
        if (typeof v === "bigint") return String(v);
        if (typeof v === "function" || typeof v === "symbol") return undefined;
        return v;
      }),
    );
  } catch {
    return { note: "non-serializable pi event" };
  }
}

/** Forward opaque parent Pi / host events on the session SSE bus. */
export function emitPi(
  workspaceId: string,
  sessionId: string,
  kind: string,
  payload?: unknown,
): void {
  emitAgentSessionEvent(workspaceId, sessionId, {
    source: "pi",
    kind,
    sessionId,
    payload: payload === undefined ? undefined : safeJsonPayload(payload),
    timestamp: nowIso(),
  });
}

/** Map WikiRunShell phase → product run_phase enum. */
export function productPhaseFromShell(phase: WikiRunShellState["phase"]): ProductPhase {
  switch (phase) {
    case "idle":
      return "idle";
    case "awaiting_plan":
      return "awaiting_plan";
    case "producing":
    case "hard_validate":
      return "writing";
    case "awaiting_publish":
      return "awaiting_publish";
    case "published":
    case "publication_declined":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

/** Map durable Run Record status → product phase (cold-load fallback). */
export function productPhaseFromRunStatus(
  status: WikiRunRecordStatus | string | undefined | null,
): ProductPhase | undefined {
  if (!status) return undefined;
  switch (status) {
    case "awaiting_plan":
      return "awaiting_plan";
    case "awaiting_publication":
      return "awaiting_publish";
    case "running":
    case "needs_input":
      return "writing";
    case "published":
    case "publication_declined":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

export type ProduceAdapterEntry = ProductInjectTarget & {
  shell?: WikiRunShellState;
};

/**
 * Adapter for startWikiRun / resumeWikiRun `onEvent` callbacks.
 *
 * - Whitelist product injects: gate / phase / plan_progress / defects / run_link
 * - Produce body is parent Session `wiki_produce` tool_execution_* (emitPi via
 *   parent tool runner) — not a product inject and not okf.produce_progress SSE.
 */
export function mapOrchestratorOnEvent(
  entry: ProduceAdapterEntry,
): (event: { type: string; message?: string; data?: unknown }) => void {
  return (event) => {
    const ts = nowIso();
    // Job produce_progress is optional legacy; live trail is wiki_produce tool events.
    if (event.type === "produce_progress") {
      return;
    }
    if (event.type === "gate") {
      const gate =
        event.message === "awaiting_plan" || event.message === "plan" ? "plan" : "publication";
      const data = (event.data ?? {}) as {
        plan?: WikiRunPlan;
        pages?: string[];
      };
      emitGate(
        entry,
        gate,
        gate === "plan"
          ? "Review and confirm the wiki Spec before produce"
          : "Review produced pages and approve publication",
        data.plan ?? entry.shell?.plan,
        data.pages ?? entry.shell?.pages,
      );
      emitPhase(
        entry,
        gate === "plan" ? "awaiting_plan" : "awaiting_publish",
        event.message,
        gate === "plan" ? "awaiting_plan" : "awaiting_publication",
      );
      emitRunLink(entry, gate === "plan" ? "awaiting_plan" : "awaiting_publication");
      return;
    }
    if (event.type === "phase") {
      const msg = event.message ?? "";
      const data = (event.data ?? {}) as { label?: string };
      if (msg === "planning") {
        emitPhase(entry, "planning", data.label ?? msg, "running");
        emitRunLink(entry, "running");
      } else if (
        msg === "producing" ||
        msg === "writing" ||
        msg === "researching" ||
        msg === "reviewing" ||
        msg === "repairing"
      ) {
        emitPhase(entry, "writing", data.label ?? msg, "running");
        emitRunLink(entry, "running");
      } else if (msg === "hard_validate") {
        emitPhase(entry, "writing", "hard-validate", "running");
      } else if (msg === "published" || msg === "done") {
        emitPhase(entry, "done", "published", "published");
        emitRunLink(entry, "published");
      } else if (msg === "failed") {
        emitPhase(entry, "failed", data.label ?? msg, "failed");
      } else {
        emitPhase(entry, productPhaseFromShell(entry.shell?.phase ?? "idle"), msg);
      }
      return;
    }
    if (event.type === "plan_progress") {
      const data = (event.data ?? {}) as {
        pages?: Array<{ path: string; status: "pending" | "writing" | "done" }>;
      };
      injectProductEvent(entry, {
        source: "product",
        kind: "plan_progress",
        sessionId: entry.sessionId,
        runId: entry.runId,
        pages: data.pages ?? [],
        timestamp: ts,
      });
      return;
    }
    if (event.type === "defects") {
      const data = (event.data ?? {}) as {
        round?: number;
        clean?: boolean;
        defectCount?: number;
        summary?: string;
      };
      injectProductEvent(entry, {
        source: "product",
        kind: "defects",
        sessionId: entry.sessionId,
        runId: entry.runId,
        round: data.round ?? 1,
        clean: data.clean ?? true,
        defectCount: data.defectCount ?? 0,
        summary: data.summary,
        timestamp: ts,
      });
      return;
    }
    // Non-whitelist job event types are ignored for product inject (ADR 0031).
    if (event.type === "error") {
      emitPi(entry.workspaceId, entry.sessionId, "error", {
        message: event.message,
        data: event.data,
      });
    }
  };
}

/**
 * Resolve operator phase for GET cold-load.
 * Prefer live shell, then durable Run Record status.
 */
export function resolveColdLoadPhase(input: {
  shellPhase?: WikiRunShellState["phase"];
  runStatus?: WikiRunRecordStatus | string | null;
}): ProductPhase | undefined {
  if (input.shellPhase) {
    return productPhaseFromShell(input.shellPhase);
  }
  return productPhaseFromRunStatus(input.runStatus);
}
