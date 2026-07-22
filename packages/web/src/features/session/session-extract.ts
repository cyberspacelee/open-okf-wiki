/**
 * Pure Session extractors for structured workflow state.
 * Never parse run ids / gates from assistant markdown (ADR 0027 / 0029).
 */

import type { UIMessage } from "ai";
import type {
  OperatorSessionDto,
  OperatorSessionSummary,
  WikiRunPlan,
} from "../../api";
import { extractPendingFromMessages } from "../../components/session/decision-types";

/**
 * Server persists schemaVersion 3 SessionMessage rows in AI SDK UIMessage shape.
 * Thin cast only — no local part rewrite.
 */
export function sessionMessagesToUI(session: OperatorSessionDto): UIMessage[] {
  return session.messages.map((m) => ({
    id: m.id,
    role: m.role as UIMessage["role"],
    parts: (m.parts ?? []) as UIMessage["parts"],
  }));
}

/**
 * Linked run id: prefer latest structured data-run part (live stream),
 * then durable session.workflow (refreshed after stream).
 */
export function extractLinkedRunId(
  session: OperatorSessionDto,
  messages: UIMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") {
      continue;
    }
    for (let j = (m.parts ?? []).length - 1; j >= 0; j--) {
      const p = m.parts![j]!;
      if (p.type === "data-run" && p.data && typeof p.data === "object") {
        const runId = (p.data as { runId?: unknown }).runId;
        if (typeof runId === "string" && runId.length > 0) {
          return runId;
        }
      }
    }
  }
  return session.workflow?.linkedRunId;
}

/** Gate step from session.workflow.phase or structured data-gate. */
export function extractGateStep(
  session: OperatorSessionDto,
  messages: UIMessage[],
): "plan-gate" | "publish-gate" {
  const live = resolveLiveGate(session, messages);
  if (live.active) {
    return live.step;
  }
  return "plan-gate";
}

/**
 * Live HITL gate for resumeData attachment.
 * Prefer durable phase; fall back to latest decision/data-plan parts when meta lags.
 */
export function resolveLiveGate(
  session: OperatorSessionDto,
  messages: UIMessage[],
  linkedRunIdHint?: string,
  resumePlanHint?: WikiRunPlan,
): {
  active: boolean;
  step: "plan-gate" | "publish-gate";
  runId?: string;
  plan?: WikiRunPlan;
} {
  const runId =
    linkedRunIdHint ||
    extractLinkedRunId(session, messages) ||
    session.workflow?.linkedRunId;
  const plan =
    resumePlanHint || extractResumePlan(session, messages) || undefined;
  const phase = session.workflow?.phase;

  // Eager gate-exit persists phase as planning/writing while work is in flight.
  // Do not treat status===running alone as mid-flight: stuck "running" at a real
  // gate must still resume after refresh until reconcile rewrites status.
  if (phase === "planning" || phase === "writing") {
    return { active: false, step: "plan-gate", runId, plan };
  }

  if (phase === "awaiting_publish" && runId) {
    return { active: true, step: "publish-gate", runId, plan };
  }
  if (phase === "awaiting_plan" && runId) {
    return { active: true, step: "plan-gate", runId, plan };
  }

  // Meta lag: data-gate already on the latest assistant message.
  const pending = extractPendingFromMessages(messages);
  if (pending && runId) {
    if (pending.gate === "publication") {
      return { active: true, step: "publish-gate", runId, plan };
    }
    if (pending.gate === "plan") {
      return { active: true, step: "plan-gate", runId, plan };
    }
    if (pending.options.some((o) => o.id === "revise")) {
      return { active: true, step: "plan-gate", runId, plan };
    }
    if (/publish|staging/i.test(pending.question)) {
      return { active: true, step: "publish-gate", runId, plan };
    }
    if (pending.options.some((o) => o.id === "approve" || o.id === "deny")) {
      return { active: true, step: "plan-gate", runId, plan };
    }
  }

  return { active: false, step: "plan-gate", runId, plan };
}

/** Plan from durable session meta, data-plan, or Mastra data-workflow suspendPayload. */
export function extractResumePlan(
  session: OperatorSessionDto,
  messages: UIMessage[],
): WikiRunPlan | undefined {
  if (session.workflow?.plan) {
    return session.workflow.plan;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") {
      continue;
    }
    for (let j = (m.parts ?? []).length - 1; j >= 0; j--) {
      const p = m.parts![j]!;
      if (p.type === "data-plan" && p.data && typeof p.data === "object") {
        const plan = p.data as WikiRunPlan;
        if (plan && Array.isArray(plan.pages)) {
          return plan;
        }
      }
      if (
        (p.type === "data-workflow" || p.type === "data-workflow-step") &&
        p.data &&
        typeof p.data === "object"
      ) {
        const fromWorkflow = planFromDataWorkflow(p.data);
        if (fromWorkflow) {
          return fromWorkflow;
        }
      }
    }
  }
  return undefined;
}

export function planFromDataWorkflow(data: unknown): WikiRunPlan | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const tryPlan = (raw: unknown): WikiRunPlan | undefined => {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const plan = raw as WikiRunPlan;
    if (typeof plan.summary === "string" && Array.isArray(plan.pages)) {
      return plan;
    }
    return undefined;
  };
  const steps = (data as { steps?: Record<string, unknown> }).steps;
  if (steps && typeof steps === "object") {
    for (const step of Object.values(steps)) {
      if (!step || typeof step !== "object") {
        continue;
      }
      const payload = (step as { suspendPayload?: unknown }).suspendPayload;
      if (payload && typeof payload === "object") {
        const gate = (payload as { gate?: unknown }).gate;
        if (gate === "plan") {
          const plan = tryPlan((payload as { plan?: unknown }).plan);
          if (plan) {
            return plan;
          }
        }
      }
    }
  }
  const stepPayload = (data as { step?: { suspendPayload?: unknown } }).step
    ?.suspendPayload;
  if (stepPayload && typeof stepPayload === "object") {
    return tryPlan((stepPayload as { plan?: unknown }).plan);
  }
  return tryPlan(
    (data as { suspendPayload?: { plan?: unknown } }).suspendPayload?.plan,
  );
}

export function summaryFromSession(
  session: OperatorSessionDto,
): OperatorSessionSummary {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    pending: session.pending,
    workflow: session.workflow,
  };
}

export function upsertSessionSummary(
  list: OperatorSessionSummary[],
  summary: OperatorSessionSummary,
): OperatorSessionSummary[] {
  const next = list.filter((s) => s.id !== summary.id);
  next.push(summary);
  next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return next;
}

export function formatSessionLabel(session: OperatorSessionSummary): string {
  const when = session.updatedAt.slice(0, 16).replace("T", " ");
  return `${session.title} · ${when}`;
}
