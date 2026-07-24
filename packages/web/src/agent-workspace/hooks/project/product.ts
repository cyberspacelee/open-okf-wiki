/**
 * Product inject projection: thin phase/gate/progress strips only.
 *
 * ADR 0031 whitelist: run_link | run_phase | gate | plan_progress | defects.
 * No body channel. Produce trail is separate: SSE/cold `okf.produce_progress`
 * → produceUnits fold (see project/produce.ts), not product inject.
 */

import { makeId, nowIso } from "./format.ts";
import type { AgentMessage, AgentProductMeta, PlanProgressPage, ProductSseLike } from "./types.ts";

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
        return n ? `plan gate · ${n} page(s)` : "plan gate";
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
    case "plan_progress": {
      const pages = Array.isArray(event.pages) ? event.pages : [];
      const done = pages.filter(
        (p) =>
          typeof p === "object" && p && "status" in p && (p as PlanProgressPage).status === "done",
      ).length;
      return `pages ${done}/${pages.length}`;
    }
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
    case "plan_progress":
      return {
        kind: "plan_progress",
        runId: event.runId,
        pages: event.pages,
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
 * Apply a product inject to the timeline (thin strips only).
 *
 * Stateful strips (phase / gate / run_link / plan_progress / defects)
 * upsert in place per run so the scroller never stacks identical job cards.
 */
export function applyProductEvent(prev: AgentMessage[], event: ProductSseLike): AgentMessage[] {
  // Ignore unknown / removed kinds defensively (e.g. stale ring frames).
  if (
    event.kind !== "run_phase" &&
    event.kind !== "gate" &&
    event.kind !== "run_link" &&
    event.kind !== "plan_progress" &&
    event.kind !== "defects"
  ) {
    return prev;
  }

  const meta = productMeta(event);
  if (!meta) return prev;

  const card: AgentMessage = {
    id: makeId(`product_${event.kind}`),
    role: "system",
    content: productCardContent(event),
    createdAt: typeof event.timestamp === "string" ? event.timestamp : nowIso(),
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
    const upserted = upsertProductStrip(prev, card, "run_phase", event.runId);
    return upserted ?? [...prev, card];
  }

  if (event.kind === "plan_progress") {
    const upserted = upsertProductStrip(prev, card, "plan_progress", event.runId);
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
    const upserted = upsertProductStrip(prev, card, "run_link", event.runId);
    return upserted ?? [...prev, card];
  }

  if (event.kind === "defects") {
    const upserted = upsertProductStrip(prev, card, "defects", event.runId);
    return upserted ?? [...prev, card];
  }

  return [...prev, card];
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
