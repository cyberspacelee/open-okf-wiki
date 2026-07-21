export type DecisionMode = "choice_only" | "input_only" | "choice_or_input";

export type PendingInteraction = {
  type: "approval" | "choice" | "input" | "confirmation";
  question: string;
  mode: DecisionMode;
  selectionMode: "single" | "multi";
  options: Array<{ id: string; label: string; description?: string }>;
  inputPlaceholder?: string;
  toolCallId?: string;
  /** Product gate kind when sourced from data-gate. */
  gate?: "plan" | "publication";
};

/** Structured resume for workflow plan/publication gates (no string protocol). */
export type SessionResumePayload = {
  action: "approve" | "deny" | "revise";
  /** Optional plan when approving / revising plan-gate. */
  plan?: {
    summary: string;
    pages: Array<{ path: string; purpose: string }>;
    notes?: string;
  };
  /** Free-text revision feedback when action is revise. */
  feedback?: string;
};

type MessageLike = {
  role: string;
  parts: Array<{
    type: string;
    input?: unknown;
    data?: unknown;
    state?: string;
  }>;
};

function asPending(
  raw: unknown,
): PendingInteraction | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const d = raw as PendingInteraction & { cancelled?: boolean; gate?: string };
  if (d.cancelled || (d.options?.length ?? 0) === 0) {
    return null;
  }
  if (!d.question) {
    return null;
  }
  return {
    type: d.type ?? "choice",
    question: d.question,
    mode: d.mode ?? "choice_only",
    selectionMode: d.selectionMode ?? "single",
    options: d.options ?? [],
    inputPlaceholder: d.inputPlaceholder,
    toolCallId: d.toolCallId,
    gate:
      d.gate === "publication" || d.gate === "plan"
        ? d.gate
        : undefined,
  };
}

/**
 * Live HITL from the latest assistant message.
 * Prefers product `data-gate` (current protocol). Does not use model tool fakes.
 */
export function extractPendingFromMessages(
  messages: MessageLike[],
): PendingInteraction | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") {
      continue;
    }
    for (const part of m.parts) {
      if (part.type === "data-gate" && part.data) {
        const pending = asPending(part.data);
        if (pending) {
          return pending;
        }
      }
    }
    // Latest assistant only — older gates are neutralized after answer.
    break;
  }
  return null;
}
