/**
 * Single product mapping: Mastra wiki-run workflow result → WikiWorkflowTerminal.
 * Session and Run console both use this (ADR 0025: one write path, two entry projections).
 */

import type {
  OperatorSession,
  SessionWorkflowState,
  WikiRunPlan,
  WikiRunRecordStatus,
} from "@okf-wiki/contract";
import {
  isDurableRunStatus as coreIsDurableRunStatus,
  sessionViewFromRunStatus,
} from "@okf-wiki/core";
import { redactErrorMessage } from "./run.js";
import type { WikiRunWorkflowOutput } from "./wiki-workflow.js";

/** Re-export Run Boundary durable-status rule for agent call sites. */
export const isDurableRunStatus = coreIsDurableRunStatus;

/** Product terminal view of one wiki-run workflow settlement. */
export type WikiWorkflowTerminal = {
  status: WikiRunRecordStatus;
  pages?: string[];
  plan?: WikiRunPlan;
  summary?: string;
  error?: string;
  publicationPath?: string;
  /** True when workflow is suspended waiting for operator resume. */
  suspended?: boolean;
  suspendGate?: "plan" | "publication";
};

export type SuspendGatePayload = {
  gate?: string;
  plan?: WikiRunPlan;
  pages?: string[];
  summary?: string;
};

type MastraLikeResult = {
  status?: string;
  error?: unknown;
  result?: WikiRunWorkflowOutput;
  suspendPayload?: unknown;
  steps?: Record<
    string,
    { status?: string; suspendPayload?: unknown; output?: unknown }
  >;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asGatePayload(value: unknown): SuspendGatePayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const gate = value.gate;
  if (typeof gate !== "string") {
    return null;
  }
  return value as SuspendGatePayload;
}

/**
 * Collect suspend payloads from top-level, nested step-id maps, and still-suspended steps.
 * Order: top-level (if gate) → nested under top → currently suspended steps.
 */
export function collectSuspendPayloads(result: MastraLikeResult): SuspendGatePayload[] {
  const payloads: SuspendGatePayload[] = [];
  const seen = new Set<string>();

  const push = (raw: unknown) => {
    const p = asGatePayload(raw);
    if (!p) {
      return;
    }
    const key = `${p.gate}:${p.plan?.summary ?? ""}:${(p.pages ?? []).join(",")}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    payloads.push(p);
  };

  const top = result.suspendPayload;
  if (isRecord(top)) {
    // Direct gate payload at top level.
    push(top);
    // Nested by step id: { 'plan-gate': { gate, plan } }
    for (const v of Object.values(top)) {
      push(v);
    }
  }

  const steps = result.steps ?? {};
  for (const step of Object.values(steps)) {
    if (step?.status !== "suspended") {
      continue;
    }
    push(step.suspendPayload);
  }

  return payloads;
}

/** Map suspend payloads → product terminal, or null if not suspended. */
export function mapSuspendedResult(
  result: MastraLikeResult,
): WikiWorkflowTerminal | null {
  if (result.status !== "suspended") {
    return null;
  }

  for (const payload of collectSuspendPayloads(result)) {
    if (payload.gate === "plan" && payload.plan) {
      return {
        status: "awaiting_plan",
        plan: payload.plan,
        summary: "Awaiting plan confirmation",
        suspended: true,
        suspendGate: "plan",
      };
    }
    if (payload.gate === "publication") {
      return {
        status: "awaiting_publication",
        pages: payload.pages,
        summary: payload.summary ?? "Awaiting publication approval",
        suspended: true,
        suspendGate: "publication",
      };
    }
  }

  return {
    status: "needs_input",
    summary: "Workflow suspended",
    suspended: true,
  };
}

function mapSuccessResult(result: MastraLikeResult): WikiWorkflowTerminal {
  const output = result.result;
  if (!output) {
    return {
      status: "failed",
      error: "workflow finished without output",
    };
  }
  return {
    status: output.status,
    pages: output.pages,
    plan: output.plan,
    summary: output.summary,
    error: output.error,
    publicationPath: output.publicationPath,
  };
}

/**
 * Pull a short human error from a failed Mastra result.
 * Prefer step-level error/message; never stringify entire step graphs (workspace dumps).
 */
export function extractWorkflowFailureMessage(result: MastraLikeResult): string {
  if (result.error !== undefined && result.error !== null) {
    const msg = redactErrorMessage(result.error);
    if (msg && msg !== "[object Object]") {
      return msg;
    }
  }
  const steps = result.steps ?? {};
  for (const [stepId, step] of Object.entries(steps)) {
    if (!step || typeof step !== "object") {
      continue;
    }
    const s = step as Record<string, unknown>;
    if (s.status !== "failed" && s.status !== "error") {
      continue;
    }
    const candidate =
      s.error ??
      s.err ??
      (isRecord(s.output) ? s.output.error ?? s.output.message : undefined) ??
      s.message;
    if (candidate !== undefined && candidate !== null) {
      const msg = redactErrorMessage(candidate);
      if (msg && msg !== "[object Object]") {
        return `${stepId}: ${msg}`;
      }
    }
    return `${stepId} failed`;
  }
  return "Wiki Run failed";
}

/**
 * Map a settled Mastra workflow run result into product Wiki Run terminal status.
 * Callers: job orchestration (`wiki-run`) and Session stream finalize.
 */
export function mapWorkflowResult(raw: unknown): WikiWorkflowTerminal {
  const result = (raw ?? {}) as MastraLikeResult;

  const suspended = mapSuspendedResult(result);
  if (suspended) {
    return suspended;
  }

  if (result.status === "failed") {
    return {
      status: "failed",
      error: extractWorkflowFailureMessage(result),
    };
  }

  // Operator plan deny (and similar clean exits) use Mastra bail — not failed.
  if (result.status === "bailed" || result.status === "canceled") {
    const output = result.result;
    return {
      status: "cancelled",
      plan: output?.plan,
      pages: output?.pages,
      summary:
        output?.summary ??
        (result.status === "bailed"
          ? "Plan declined by operator"
          : "Wiki Run cancelled"),
      error: output?.error ?? "plan declined",
    };
  }

  // success / completed / unknown with result payload
  if (result.result || result.status === "success") {
    return mapSuccessResult(result);
  }

  return {
    status: "failed",
    error: redactErrorMessage(
      result.error ?? `unexpected workflow status: ${result.status ?? "unknown"}`,
    ),
  };
}

/** First suspend gate payload for Session decision UI (or null). */
export function extractSuspendGate(
  raw: unknown,
): SuspendGatePayload | null {
  const terminal = mapWorkflowResult(raw);
  if (!terminal.suspended || !terminal.suspendGate) {
    return null;
  }
  return {
    gate: terminal.suspendGate,
    plan: terminal.plan,
    pages: terminal.pages,
    summary: terminal.summary,
  };
}

/**
 * Session-facing projection of a product terminal.
 * Thin adapter over core P2 `sessionViewFromRunStatus` / `transition` —
 * no second phase map (ADR 0027).
 */
export type SessionTerminalView = {
  status: OperatorSession["status"];
  workflowPhase: SessionWorkflowState["phase"];
  pages?: string[];
  plan?: WikiRunPlan;
  summary?: string;
  runStatus?: string;
};

export function sessionViewFromTerminal(
  terminal: WikiWorkflowTerminal,
): SessionTerminalView {
  // Unknown product statuses still surface as failed for the Session shell.
  const known = terminal.status;
  if (
    known !== "running" &&
    known !== "published" &&
    known !== "needs_input" &&
    known !== "failed" &&
    known !== "cancelled" &&
    known !== "awaiting_plan" &&
    known !== "awaiting_publication" &&
    known !== "publication_declined"
  ) {
    return {
      status: "failed",
      workflowPhase: "idle",
      summary:
        typeof terminal.error === "string" && terminal.error
          ? `Wiki Run failed: ${terminal.error}`
          : typeof terminal.summary === "string"
            ? terminal.summary
            : `Wiki Run ended: ${terminal.status}`,
      runStatus: terminal.status,
    };
  }

  return sessionViewFromRunStatus({
    status: known,
    pages: terminal.pages,
    plan: terminal.plan,
    summary: terminal.summary,
    error: terminal.error,
    suspended: terminal.suspended,
    suspendGate: terminal.suspendGate,
  });
}

