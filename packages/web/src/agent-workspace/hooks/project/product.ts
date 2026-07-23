/**
 * Product inject projection: phase/gate/progress strips + work_block anchors.
 *
 * work_unit body never lands as a message card — it updates the units fold
 * (applyWorkUnit). Timeline only gets a thin work_block anchor per runId so
 * the Work block has a stable scroll position (ADR 0031 UI cut).
 */

import { makeId, nowIso } from "./format.ts";
import type {
  AgentMessage,
  AgentProductMeta,
  PlanProgressPage,
  ProductSseLike,
  WorkUnits,
  WorkUnitView,
} from "./types.ts";

/**
 * English fallback body for product cards (tests / cold-load dump).
 * Live UI formats via formatProductCardContent + i18n (see product-copy.ts).
 */
export function productCardContent(event: ProductSseLike): string {
  switch (event.kind) {
    case "run_phase": {
      const head = event.phase?.replace(/_/g, " ") || "phase";
      if (typeof event.message === "string" && event.message.trim()) {
        return `${head} — ${event.message.trim()}`;
      }
      return head;
    }
    case "gate": {
      if (event.gate === "plan") {
        const n = event.pages?.length;
        return n
          ? `plan gate · ${n} page(s)`
          : "plan gate";
      }
      if (event.gate === "publication") return "publication gate";
      return event.question?.trim() || "gate";
    }
    case "run_link": {
      const short = event.runId ? event.runId.slice(0, 8) : "—";
      if (event.status) {
        return `run ${short} · ${String(event.status).replace(/_/g, " ")}`;
      }
      return `run ${short}`;
    }
    case "progress": {
      const head = event.phase?.replace(/_/g, " ") || "progress";
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
      return `pages ${done}/${pages.length}`;
    }
    case "work_unit":
      return "";
    case "defects": {
      if (event.clean) return `review clean · round ${event.round ?? 1}`;
      return `review defects ${event.defectCount ?? 0} · round ${event.round ?? 1}`;
    }
    default: {
      const _exhaustive: never = event.kind;
      return String(_exhaustive);
    }
  }
}

export function productMeta(event: ProductSseLike): AgentProductMeta | null {
  switch (event.kind) {
    case "run_phase":
      return {
        kind: "run_phase",
        phase: event.phase,
        runId: event.runId,
        status: event.status,
        label:
          typeof event.message === "string" && event.message.trim()
            ? event.message.trim()
            : undefined,
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
      return null;
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

/** Find work_block anchor for runId (newest-first). */
export function findWorkBlockIndex(
  messages: readonly AgentMessage[],
  runId?: string,
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.product?.kind !== "work_block") continue;
    if (runId && m.product.runId && m.product.runId !== runId) continue;
    return i;
  }
  return -1;
}

function ensureWorkBlockAnchor(
  prev: AgentMessage[],
  runId: string | undefined,
  timestamp?: string,
): AgentMessage[] {
  if (!runId?.trim()) return prev;
  if (findWorkBlockIndex(prev, runId) >= 0) return prev;
  return [
    ...prev,
    {
      id: makeId("work_block"),
      role: "system",
      content: "",
      createdAt: typeof timestamp === "string" ? timestamp : nowIso(),
      product: { kind: "work_block", runId },
      status: "work_block",
    },
  ];
}

/**
 * Upsert the latest product strip of `kind` for a run (newest-first match).
 * Prevents run_link / progress spam when server re-emits or cold+SSE reapply.
 */
function upsertProductStrip(
  prev: AgentMessage[],
  card: AgentMessage,
  kind: AgentProductMeta["kind"],
  runId: string | undefined,
  match?: (m: AgentMessage) => boolean,
): AgentMessage[] | null {
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i]!;
    if (m.product?.kind !== kind) continue;
    if (runId && m.product.runId && m.product.runId !== runId) continue;
    if (match && !match(m)) continue;
    const next = prev.slice();
    next[i] = { ...card, id: m.id };
    return next;
  }
  return null;
}

/**
 * Apply a product inject to the timeline.
 * work_unit only ensures a work_block anchor (body → units fold).
 *
 * Stateful strips (phase / gate / progress / run_link / plan_progress / defects)
 * upsert in place per run so the scroller never stacks identical job cards.
 */
export function applyProductEvent(
  prev: AgentMessage[],
  event: ProductSseLike,
): AgentMessage[] {
  if (event.kind === "work_unit") {
    return ensureWorkBlockAnchor(prev, event.runId, event.timestamp);
  }

  const meta = productMeta(event);
  if (!meta) return prev;

  const card: AgentMessage = {
    id: makeId(`product_${event.kind}`),
    role: "system",
    content: productCardContent(event),
    createdAt:
      typeof event.timestamp === "string" ? event.timestamp : nowIso(),
    product: meta,
    status: event.kind,
  };

  if (event.kind === "run_phase") {
    // Session bootstrap noise — keep phase state on the wire, but do not paint
    // a transcript strip ("agent session created") that looks like a chat card.
    const bootstrapIdle =
      event.phase === "idle" &&
      typeof event.message === "string" &&
      /agent session created/i.test(event.message);
    if (bootstrapIdle) {
      return prev;
    }
    const base = ensureWorkBlockAnchor(prev, event.runId, event.timestamp);
    const upserted = upsertProductStrip(base, card, "run_phase", event.runId);
    return upserted ?? [...base, card];
  }

  if (event.kind === "plan_progress") {
    const upserted = upsertProductStrip(
      prev,
      card,
      "plan_progress",
      event.runId,
    );
    return upserted ?? [...prev, card];
  }

  if (event.kind === "gate" && event.gate) {
    const gate = event.gate;
    const upserted = upsertProductStrip(
      prev,
      card,
      "gate",
      event.runId,
      (m) => m.product?.gate === gate,
    );
    return upserted ?? [...prev, card];
  }

  if (event.kind === "run_link") {
    const base = ensureWorkBlockAnchor(prev, event.runId, event.timestamp);
    const upserted = upsertProductStrip(base, card, "run_link", event.runId);
    return upserted ?? [...base, card];
  }

  if (event.kind === "progress") {
    const upserted = upsertProductStrip(prev, card, "progress", event.runId);
    return upserted ?? [...prev, card];
  }

  if (event.kind === "defects") {
    const upserted = upsertProductStrip(prev, card, "defects", event.runId);
    return upserted ?? [...prev, card];
  }

  return [...prev, card];
}

/**
 * Cold-load: ensure every runId in the units fold has a work_block anchor.
 * Does not invent agent chips on the timeline.
 */
export function ensureWorkBlockAnchors(
  messages: AgentMessage[],
  units: WorkUnits,
): AgentMessage[] {
  let next = messages;
  const seen = new Set<string>();
  for (const unit of Object.values(units)) {
    const runId = unit.runId?.trim();
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    next = ensureWorkBlockAnchor(next, runId);
  }
  return next;
}

/** Units for a run, stable order (parent-before-child when parentId known). */
export function unitsForRun(
  units: WorkUnits,
  runId?: string | null,
): WorkUnitView[] {
  const list = Object.values(units).filter((u) => {
    if (!runId) return true;
    return !u.runId || u.runId === runId;
  });
  const byId = new Map(list.map((u) => [u.unitId, u]));
  const roots = list.filter(
    (u) => !u.parentId || u.parentId === "root" || !byId.has(u.parentId),
  );
  const out: WorkUnitView[] = [];
  const visit = (u: WorkUnitView) => {
    out.push(u);
    for (const child of list
      .filter((c) => c.parentId === u.unitId)
      .sort((a, b) => a.unitId.localeCompare(b.unitId))) {
      visit(child);
    }
  };
  for (const r of roots.sort((a, b) => a.unitId.localeCompare(b.unitId))) {
    visit(r);
  }
  // Orphans already visited as roots; dedupe
  const seen = new Set(out.map((u) => u.unitId));
  for (const u of list) {
    if (!seen.has(u.unitId)) out.push(u);
  }
  return out;
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
