/**
 * Map produce / WikiRun orchestrator job events → product SSE + trajectory.
 *
 * ADR 0031: work_unit only for produce child body channel.
 */

import type {
  ProductSseEvent,
  ProductWorkUnitEvent,
  WikiRunPlan,
  WorkUnitRole,
  WorkUnitStatus,
} from "@okf-wiki/contract";
import type { WikiRunShellState } from "@okf-wiki/agent";
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
export function productPhaseFromShell(
  phase: WikiRunShellState["phase"],
): ProductPhase {
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

const WORK_UNIT_ROLES = new Set<string>([
  "planner",
  "domain",
  "leaf",
  "reviewer",
  "root",
]);

const WORK_UNIT_STATUSES = new Set<string>([
  "pending",
  "running",
  "settled",
  "failed",
]);

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
};

/**
 * Adapter for startWikiRun / resumeWikiRun `onEvent` callbacks.
 * Maps job events onto whitelist product injects (work_unit, progress, …).
 */
export function mapOrchestratorOnEvent(
  entry: ProduceAdapterEntry,
): (event: { type: string; message?: string; data?: unknown }) => void {
  return (event) => {
    const ts = nowIso();
    if (event.type === "gate") {
      const gate =
        event.message === "awaiting_plan" || event.message === "plan"
          ? "plan"
          : "publication";
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
      emitRunLink(
        entry,
        gate === "plan" ? "awaiting_plan" : "awaiting_publication",
      );
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
        emitPhase(
          entry,
          productPhaseFromShell(entry.shell?.phase ?? "idle"),
          msg,
        );
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
        typeof data.unitId === "string" && data.unitId.trim()
          ? data.unitId.trim()
          : "";
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
      const runId =
        (typeof data.runId === "string" && data.runId.trim()) ||
        entry.runId ||
        "";
      if (!runId) return;

      const product: ProductWorkUnitEvent = {
        source: "product",
        kind: "work_unit",
        sessionId: entry.sessionId,
        runId,
        unitId: unitId.slice(0, 120),
        role: role as WorkUnitRole,
        status: status as WorkUnitStatus,
        task:
          typeof data.task === "string" ? data.task.slice(0, 2000) : undefined,
        parentId:
          typeof data.parentId === "string"
            ? data.parentId.slice(0, 120)
            : undefined,
        message: data.message,
        tools: data.tools,
        summary:
          typeof data.summary === "string"
            ? data.summary.slice(0, 4000)
            : undefined,
        receiptPath:
          typeof data.receiptPath === "string"
            ? data.receiptPath.slice(0, 500)
            : undefined,
        error:
          typeof data.error === "string"
            ? data.error.slice(0, 4000)
            : undefined,
        updatedAt:
          typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
            ? data.updatedAt
            : Date.now(),
        timestamp: ts,
      };
      injectProductEvent(entry, product);
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
