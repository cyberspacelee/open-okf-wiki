import type {
  InteractionResume,
  PendingInteraction,
} from "@okf-wiki/contract";

/**
 * Validate a structured user resume against the pending interaction mode.
 * Throws with a short operator-safe message on invalid payloads.
 */
export function validateInteractionResume(
  pending: PendingInteraction | null | undefined,
  resume: InteractionResume,
): void {
  if (!pending) {
    throw new Error("no pending interaction to answer");
  }

  const mode = pending.mode ?? "choice_or_input";
  const optionIds = new Set((pending.options ?? []).map((o) => o.id));

  if (resume.channel === "choice") {
    if (mode === "input_only") {
      throw new Error("this step accepts free text only");
    }
    if (optionIds.size === 0) {
      throw new Error("no options available for choice");
    }
    for (const id of resume.selectedIds) {
      if (!optionIds.has(id)) {
        throw new Error(`invalid option id: ${id}`);
      }
    }
    if (pending.selectionMode === "single" && resume.selectedIds.length !== 1) {
      throw new Error("select exactly one option");
    }
    return;
  }

  // channel === input
  if (mode === "choice_only") {
    throw new Error("this step requires selecting an option");
  }
  if (!resume.text.trim()) {
    throw new Error("input text is required");
  }
}
