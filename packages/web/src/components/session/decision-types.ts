export type DecisionMode = "choice_only" | "input_only" | "choice_or_input";

export type PendingInteraction = {
  type: "approval" | "choice" | "input" | "confirmation";
  question: string;
  mode: DecisionMode;
  selectionMode: "single" | "multi";
  options: Array<{ id: string; label: string; description?: string }>;
  inputPlaceholder?: string;
  toolCallId?: string;
};

/** Structured resume for workflow plan/publication gates (no string protocol). */
export type SessionResumePayload = {
  action: "approve" | "deny";
  /** Optional plan when approving plan-gate. */
  plan?: {
    summary: string;
    pages: Array<{ path: string; purpose: string }>;
    notes?: string;
  };
};

export function extractPendingFromMessages(
  messages: Array<{
    role: string;
    parts: Array<{ type: string; input?: unknown; data?: unknown; state?: string }>;
  }>,
): PendingInteraction | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") {
      continue;
    }
    for (const part of m.parts) {
      if (part.type === "tool-request_user_decision" && part.state === "input-available") {
        const d = part.input as PendingInteraction | undefined;
        if (d?.question) {
          return {
            type: d.type ?? "choice",
            question: d.question,
            mode: d.mode ?? "choice_only",
            selectionMode: d.selectionMode ?? "single",
            options: d.options ?? [],
            inputPlaceholder: d.inputPlaceholder,
            toolCallId: d.toolCallId,
          };
        }
      }
      if (part.type === "data-choice" && part.data) {
        const d = part.data as PendingInteraction;
        if (d?.question) {
          return {
            type: d.type ?? "choice",
            question: d.question,
            mode: d.mode ?? "choice_only",
            selectionMode: d.selectionMode ?? "single",
            options: d.options ?? [],
            inputPlaceholder: d.inputPlaceholder,
            toolCallId: d.toolCallId,
          };
        }
      }
    }
    break;
  }
  return null;
}
