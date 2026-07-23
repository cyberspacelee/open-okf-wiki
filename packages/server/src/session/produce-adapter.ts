/**
 * Map produce / WikiRun orchestrator job events → product SSE + trajectory.
 *
 * ADR 0031: work_unit only for produce child body channel.
 */

import type { WikiRunShellState, WikiSessionHandle } from "@okf-wiki/agent";
import type {
  ProductSseEvent,
  ProductWorkUnitEvent,
  WikiRunPlan,
  WorkUnitRole,
  WorkUnitStatus,
} from "@okf-wiki/contract";
import { emitAgentSessionEvent } from "../agent-session-events.ts";
import {
  emitGate,
  emitPhase,
  emitRunLink,
  injectProductEvent,
  type ProductInjectTarget,
  type ProductPhase,
} from "./product-inject.ts";
import { createWorkUnitCoalescer } from "./work-unit-coalesce.ts";

/** Pi custom entry type for settle-only PVU summaries (not in LLM context). */
export const OKF_WORK_UNIT_CUSTOM_TYPE = "okf.work_unit" as const;

/**
 * Persist a compact PVU summary on the parent Pi JSONL via appendCustomEntry.
 * Not in convertToLlm context — safe for next operator prompt quality.
 * Does NOT invent toolCall/tool_execution bodies (ADR 0031 U3).
 */
export function appendParentWorkUnitCustomEntry(
  handle: WikiSessionHandle | undefined,
  unit: Pick<
    ProductWorkUnitEvent,
    | "unitId"
    | "role"
    | "status"
    | "runId"
    | "task"
    | "summary"
    | "receiptPath"
    | "error"
    | "parentId"
  >,
): void {
  if (!handle?.session?.sessionManager) return;
  if (unit.status !== "settled" && unit.status !== "failed") return;
  try {
    handle.session.sessionManager.appendCustomEntry(OKF_WORK_UNIT_CUSTOM_TYPE, {
      unitId: unit.unitId,
      role: unit.role,
      status: unit.status,
      runId: unit.runId,
      task: unit.task?.slice(0, 500),
      summary: unit.summary?.slice(0, 2000),
      receiptPath: unit.receiptPath,
      error: unit.error?.slice(0, 1000),
      parentId: unit.parentId,
    });
  } catch {
    // best-effort; trajectory remains authority for live UI
  }
}

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

const WORK_UNIT_ROLES = new Set<string>(["planner", "domain", "leaf", "reviewer", "root"]);

const WORK_UNIT_STATUSES = new Set<string>(["pending", "running", "settled", "failed"]);

type ParentUnitLike = {
  unitId?: string;
  role?: string;
  status?: string;
  runId?: string;
  task?: string;
  parentId?: string;
  message?: ProductWorkUnitEvent["message"];
  tools?: ProductWorkUnitEvent["tools"];
  summary?: string;
  receiptPath?: string;
  error?: string;
  updatedAt?: number;
};

export type ProduceAdapterEntry = ProductInjectTarget & {
  shell?: WikiRunShellState;
  /** Live parent Operator Session handle (for settle-only custom entries). */
  handle?: WikiSessionHandle;
};

/**
 * Adapter for startWikiRun / resumeWikiRun `onEvent` callbacks.
 * Maps job events onto whitelist product injects (work_unit, progress, …).
 *
 * work_unit body streaming is coalesced per unitId (see work-unit-coalesce.ts)
 * so high-frequency message_update frames do not spam trajectory + SSE.
 * Terminal / tool / status structural updates flush immediately.
 */
export function mapOrchestratorOnEvent(
  entry: ProduceAdapterEntry,
): (event: { type: string; message?: string; data?: unknown }) => void {
  const workUnitCoalesce = createWorkUnitCoalescer({
    emit: (product) => injectProductEvent(entry, product),
  });

  return (event) => {
    const ts = nowIso();
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
      if (
        msg === "planning" ||
        msg === "researching" ||
        msg === "writing" ||
        msg === "reviewing" ||
        msg === "repairing" ||
        msg === "done" ||
        msg === "failed"
      ) {
        injectProductEvent(entry, {
          source: "product",
          kind: "progress",
          sessionId: entry.sessionId,
          runId: entry.runId,
          phase: msg,
          label: data.label ?? event.message,
          timestamp: ts,
        });
      }
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
    if (event.type === "work_unit") {
      const data = (event.data ?? {}) as ParentUnitLike;
      const unitId =
        typeof data.unitId === "string" && data.unitId.trim() ? data.unitId.trim() : "";
      const role = data.role;
      const status = data.status;
      if (
        !unitId ||
        !role ||
        !status ||
        !WORK_UNIT_ROLES.has(role) ||
        !WORK_UNIT_STATUSES.has(status)
      ) {
        return;
      }
      const runId = (typeof data.runId === "string" && data.runId.trim()) || entry.runId || "";
      if (!runId) return;

      const product: ProductWorkUnitEvent = {
        source: "product",
        kind: "work_unit",
        sessionId: entry.sessionId,
        runId,
        unitId: unitId.slice(0, 120),
        role: role as WorkUnitRole,
        status: status as WorkUnitStatus,
        task: typeof data.task === "string" ? data.task.slice(0, 2000) : undefined,
        parentId: typeof data.parentId === "string" ? data.parentId.slice(0, 120) : undefined,
        message: data.message,
        tools: data.tools,
        summary: typeof data.summary === "string" ? data.summary.slice(0, 4000) : undefined,
        receiptPath:
          typeof data.receiptPath === "string" ? data.receiptPath.slice(0, 500) : undefined,
        error: typeof data.error === "string" ? data.error.slice(0, 4000) : undefined,
        updatedAt:
          typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
            ? data.updatedAt
            : Date.now(),
        timestamp: ts,
      };
      // Coalesce pure message streaming; assertProductInject still on emit path.
      workUnitCoalesce.push(product);
      // Settle/fail: durable parent Pi custom entry (not LLM context; not fake tools).
      if (product.status === "settled" || product.status === "failed") {
        appendParentWorkUnitCustomEntry(entry.handle, product);
      }
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
    // Non-whitelist job event types are ignored (ADR 0031).
    if (event.type === "error") {
      emitPi(entry.workspaceId, entry.sessionId, "error", {
        message: event.message,
        data: event.data,
      });
    }
  };
}

/** Resolve operator phase for GET cold-load: trajectory last, then shell. */
export function resolveColdLoadPhase(input: {
  shellPhase?: WikiRunShellState["phase"];
  trajectoryEvents?: readonly ProductSseEvent[];
  lastPhaseFromTrajectory?: ProductPhase;
}): ProductPhase | undefined {
  if (input.lastPhaseFromTrajectory) {
    return input.lastPhaseFromTrajectory;
  }
  if (input.trajectoryEvents) {
    for (let i = input.trajectoryEvents.length - 1; i >= 0; i -= 1) {
      const e = input.trajectoryEvents[i];
      if (e?.kind === "run_phase") return e.phase;
    }
  }
  if (input.shellPhase) {
    return productPhaseFromShell(input.shellPhase);
  }
  return undefined;
}
