/**
 * Product inject projection: phase/gate cards + work_run chips.
 */

import {
  isRecord,
  makeId,
  nowIso,
} from "./format.ts";
import type {
  AgentMessage,
  AgentProductMeta,
  PlanProgressPage,
  ProductSseLike,
  WorkAgentChip,
} from "./types.ts";

/** Human phase labels for operator timeline (not protocol enums). */
function phaseLabel(phase: string | undefined): string {
  switch (phase) {
    case "idle":
      return "Ready";
    case "planning":
      return "Planning wiki structure";
    case "awaiting_plan":
      return "Waiting for plan approval";
    case "writing":
    case "producing":
      return "Writing wiki pages";
    case "awaiting_publish":
    case "awaiting_publication":
      return "Waiting for publish approval";
    case "publishing":
      return "Publishing";
    case "done":
    case "published":
      return "Published";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "publication_declined":
      return "Publication declined";
    default:
      return phase?.replace(/_/g, " ") || "Working";
  }
}

export function productCardContent(event: ProductSseLike): string {
  switch (event.kind) {
    case "run_phase": {
      const head = phaseLabel(event.phase);
      if (typeof event.message === "string" && event.message.trim()) {
        return `${head} — ${event.message.trim()}`;
      }
      return head;
    }
    case "gate": {
      if (event.gate === "plan") {
        const n = event.pages?.length;
        return n
          ? `Plan ready — ${n} page(s). Approve, revise, or deny below.`
          : "Plan ready. Approve, revise, or deny below.";
      }
      if (event.gate === "publication") {
        return "Wiki ready to publish. Approve or deny below.";
      }
      return event.question?.trim() || "Input needed";
    }
    case "run_link": {
      const short = event.runId ? event.runId.slice(0, 8) : "—";
      if (event.status) {
        return `Linked job ${short} · ${String(event.status).replace(/_/g, " ")}`;
      }
      return `Linked job ${short}`;
    }
    case "progress": {
      const head = phaseLabel(event.phase);
      return event.label?.trim() ? `${head} — ${event.label.trim()}` : head;
    }
    case "plan_progress": {
      const pages = Array.isArray(event.pages) ? event.pages : [];
      const done = pages.filter(
        (p) =>
          typeof p === "object" &&
          p &&
          "status" in p &&
          (p as PlanProgressPage).status === "done",
      ).length;
      const total = pages.length;
      const lines = pages.slice(0, 12).map((p) => {
        if (typeof p === "string") return `· ${p}`;
        const pg = p as PlanProgressPage;
        const mark =
          pg.status === "done" ? "✓" : pg.status === "writing" ? "…" : "·";
        return `${mark} ${pg.path}`;
      });
      const more =
        pages.length > 12 ? `\n… +${pages.length - 12} more` : "";
      return [`Writing pages ${done}/${total}`, ...lines].join("\n") + more;
    }
    case "work_unit": {
      const role = event.role ?? "agent";
      const task = event.task?.trim();
      const status = event.status?.replace(/_/g, " ") ?? "";
      if (task) return `${role}: ${task}${status ? ` (${status})` : ""}`;
      return `${role}${status ? ` · ${status}` : ""}`;
    }
    case "work_run": {
      const agents = event.agents ?? [];
      const running = agents.filter(
        (a) => a.status === "running" || a.status === "pending",
      ).length;
      const done = agents.filter(
        (a) =>
          a.status === "settled" ||
          a.status === "complete" ||
          a.status === "done",
      ).length;
      const bits = [
        "Wiki work",
        running ? `${running} running` : null,
        done ? `${done} done` : null,
        agents.length ? `${agents.length} unit(s)` : null,
      ].filter(Boolean);
      return bits.join(" · ");
    }
    case "defects": {
      if (event.clean) {
        return `Review passed (round ${event.round ?? 1})`;
      }
      return `Review found ${event.defectCount ?? 0} issue(s) (round ${event.round ?? 1})`;
    }
    default: {
      const _exhaustive: never = event.kind;
      return String(_exhaustive);
    }
  }
}

export function productMeta(event: ProductSseLike): AgentProductMeta {
  switch (event.kind) {
    case "run_phase":
      return {
        kind: "run_phase",
        phase: event.phase,
        runId: event.runId,
        status: event.status,
      };
    case "gate":
      return {
        kind: "gate",
        gate: event.gate,
        runId: event.runId,
        question: event.question,
        pages: event.pages,
      };
    case "run_link":
      return {
        kind: "run_link",
        runId: event.runId,
        status: event.status,
      };
    case "progress":
      return {
        kind: "progress",
        phase: event.phase,
        runId: event.runId,
        label: event.label,
      };
    case "plan_progress":
      return {
        kind: "plan_progress",
        runId: event.runId,
        pages: event.pages,
      };
    case "work_unit":
      // work_unit folds into work_run chips; meta is not used as a card kind.
      return {
        kind: "work_run",
        runId: event.runId,
        agents: [],
      };
    case "work_run":
      return {
        kind: "work_run",
        runId: event.runId,
        phase: event.phase,
        agents: event.agents ?? [],
        status: event.status,
      };
    case "defects":
      return {
        kind: "defects",
        runId: event.runId,
        clean: event.clean,
        defectCount: event.defectCount,
        round: event.round,
        label: event.summary,
      };
    default: {
      const _exhaustive: never = event.kind;
      return _exhaustive;
    }
  }
}

/** Upsert one unit into a Work chip agent list (pure). agentId === unitId.
 * First-seen order is preserved: updates stay in place; new units append.
 * (Never unshift — newest must not jump above historical agents.)
 */
export function upsertWorkAgentChip(
  agents: WorkAgentChip[],
  chip: WorkAgentChip,
): WorkAgentChip[] {
  const next = [...agents];
  const idx = next.findIndex((a) => a.agentId === chip.agentId);
  if (idx >= 0) {
    next[idx] = {
      ...next[idx],
      ...chip,
      detail: chip.detail ?? next[idx]!.detail,
      task: chip.task ?? next[idx]!.task,
      parentId: chip.parentId ?? next[idx]!.parentId,
      receiptPath: chip.receiptPath ?? next[idx]!.receiptPath,
    };
  } else {
    next.push(chip);
  }
  return next;
}

/**
 * Find the work_run card for `runId` searching newest-first.
 * Different-run cards are skipped (not a hard stop) so late units for an
 * earlier run still attach to the original Work chip.
 */
export function findWorkRunIndex(
  messages: readonly AgentMessage[],
  runId?: string,
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.product?.kind !== "work_run") continue;
    if (runId && m.product.runId && m.product.runId !== runId) {
      continue;
    }
    return i;
  }
  return -1;
}

function chipFromWorkUnit(event: ProductSseLike): WorkAgentChip | null {
  if (event.kind !== "work_unit" || !event.unitId) return null;
  const msg = isRecord(event.message) ? event.message : undefined;
  const detail =
    (typeof event.summary === "string" && event.summary) ||
    (typeof msg?.text === "string" && msg.text) ||
    (typeof event.error === "string" && event.error) ||
    undefined;
  return {
    agentId: event.unitId,
    role: event.role ?? "agent",
    status: String(event.status ?? "pending"),
    parentId: event.parentId,
    task: event.task,
    detail,
    receiptPath: event.receiptPath,
  };
}

/**
 * Apply a product inject. Phase cards upsert the latest run_phase row so the
 * transcript does not spam one card per phase transition for a single run.
 * Gate cards upsert the latest open gate of the same kind (plan/publication).
 * work_unit folds into a single work_run chip per run (timeline index).
 */
export function applyProductEvent(
  prev: AgentMessage[],
  event: ProductSseLike,
): AgentMessage[] {
  const card: AgentMessage = {
    id: makeId(`product_${event.kind}`),
    role: "system",
    content: productCardContent(event),
    createdAt:
      typeof event.timestamp === "string" ? event.timestamp : nowIso(),
    product: productMeta(event),
    status: event.kind,
  };

  if (event.kind === "run_phase") {
    // Keep Work chip phase in sync, then upsert the phase strip card.
    let base = prev;
    const workIdx = findWorkRunIndex(prev, event.runId);
    if (workIdx >= 0) {
      const m = prev[workIdx]!;
      const agents = m.product?.agents ?? [];
      const next = prev.slice();
      next[workIdx] = {
        ...m,
        content: productCardContent({
          kind: "work_run",
          runId: m.product?.runId,
          phase: event.phase,
          agents,
        }),
        product: { ...m.product!, phase: event.phase },
      };
      base = next;
    }
    for (let i = base.length - 1; i >= 0; i -= 1) {
      const m = base[i]!;
      if (m.product?.kind !== "run_phase") continue;
      if (
        event.runId &&
        m.product.runId &&
        m.product.runId !== event.runId
      ) {
        continue;
      }
      const next = base.slice();
      next[i] = { ...card, id: m.id };
      return next;
    }
    return base === prev ? [...prev, card] : [...base, card];
  }

  if (event.kind === "plan_progress") {
    // Upsert Spec pages card so page statuses refresh in place.
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      const m = prev[i]!;
      if (m.product?.kind !== "plan_progress") continue;
      if (
        event.runId &&
        m.product.runId &&
        m.product.runId !== event.runId
      ) {
        continue;
      }
      const next = prev.slice();
      next[i] = { ...card, id: m.id };
      return next;
    }
  }

  if (event.kind === "work_unit") {
    const chip = chipFromWorkUnit(event);
    if (!chip) return prev;
    const workIdx = findWorkRunIndex(prev, event.runId);
    if (workIdx >= 0) {
      const m = prev[workIdx]!;
      const agents = upsertWorkAgentChip(m.product?.agents ?? [], chip);
      const next = prev.slice();
      next[workIdx] = {
        ...m,
        content: productCardContent({
          kind: "work_run",
          runId: event.runId ?? m.product?.runId,
          phase: m.product?.phase,
          agents,
        }),
        product: {
          kind: "work_run",
          runId: event.runId ?? m.product?.runId,
          phase: m.product?.phase,
          agents,
        },
        status: "work_run",
      };
      return next;
    }
    const agents = [chip];
    return [
      ...prev,
      {
        id: makeId("product_work_run"),
        role: "system",
        content: productCardContent({
          kind: "work_run",
          runId: event.runId,
          agents,
        }),
        createdAt:
          typeof event.timestamp === "string" ? event.timestamp : nowIso(),
        product: {
          kind: "work_run",
          runId: event.runId,
          agents,
        },
        status: "work_run",
      },
    ];
  }

  if (event.kind === "gate" && event.gate) {
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      const m = prev[i]!;
      if (m.product?.kind !== "gate") continue;
      if (m.product.gate !== event.gate) continue;
      if (
        event.runId &&
        m.product.runId &&
        m.product.runId !== event.runId
      ) {
        continue;
      }
      const next = prev.slice();
      next[i] = { ...card, id: m.id };
      return next;
    }
  }

  return [...prev, card];
}

/**
 * Ensure every folded work unit appears on its Work chip (cold-load safety net).
 * Trajectory replay is primary; this fills gaps without reordering first-seen agents.
 */
export function mergeWorkUnitsIntoTimeline(
  messages: AgentMessage[],
  units: Record<
    string,
    {
      unitId: string;
      role: string;
      status: string;
      runId?: string;
      task?: string;
      parentId?: string;
      summary?: string;
      receiptPath?: string;
      error?: string;
      message?: { thinking?: string; text?: string };
    }
  >,
): AgentMessage[] {
  let next = messages;
  for (const unit of Object.values(units)) {
    if (!unit.unitId) continue;
    next = applyProductEvent(next, {
      kind: "work_unit",
      unitId: unit.unitId,
      role: unit.role,
      status: unit.status,
      runId: unit.runId,
      task: unit.task,
      parentId: unit.parentId,
      summary: unit.summary,
      receiptPath: unit.receiptPath,
      error: unit.error,
      message: unit.message,
    });
  }
  return next;
}

/** Whether a product run_phase should clear the busy/streaming chrome. */
export function isTerminalOrWaitingPhase(phase: string | undefined): boolean {
  return (
    phase === "done" ||
    phase === "failed" ||
    phase === "cancelled" ||
    phase === "idle" ||
    phase === "awaiting_plan" ||
    phase === "awaiting_publish"
  );
}

/** True when the latest projected messages include an assistant error. */
export function lastAssistantIsError(messages: AgentMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      return m.status === "error" || Boolean(m.errorMessage);
    }
  }
  return false;
}
