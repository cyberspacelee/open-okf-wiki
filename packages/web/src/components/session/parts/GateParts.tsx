/**
 * HITL gate parts: decision chips and input-only hints (data-gate).
 */

import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import {
  Suggestion,
  Suggestions,
} from "@/components/ai-elements/suggestion";
import { useI18n } from "../../../i18n";
import type { PendingInteraction } from "../decision-types";
import { asDecision, localizeDecisionOption } from "./message-part-utils";

export function DecisionChips({
  decision,
  onChoice,
}: {
  decision: PendingInteraction;
  onChoice: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2" data-testid="session-decision">
      <p className="text-sm text-muted-foreground">{decision.question}</p>
      <Suggestions>
        {decision.options.map((opt) => {
          const localized = localizeDecisionOption(opt, t);
          return (
            <Suggestion
              key={opt.id}
              suggestion={localized.label}
              onClick={() => onChoice(opt.id)}
              data-testid={`session-choice-${opt.id}`}
            />
          );
        })}
      </Suggestions>
    </div>
  );
}

export function renderGatePart(
  key: string,
  part: UIMessage["parts"][number],
  opts: {
    isLatestAssistant?: boolean;
    onChoice?: (optionId: string) => void;
  },
): ReactNode {
  if (part.type !== "data-gate") {
    return undefined;
  }
  const data = "data" in part ? part.data : undefined;
  const decision = asDecision(data);
  const cancelled =
    data &&
    typeof data === "object" &&
    "cancelled" in data &&
    Boolean((data as { cancelled?: unknown }).cancelled);
  if (
    decision &&
    !cancelled &&
    opts.isLatestAssistant &&
    opts.onChoice &&
    decision.mode !== "input_only"
  ) {
    return (
      <DecisionChips
        key={key}
        decision={decision}
        onChoice={opts.onChoice}
      />
    );
  }
  if (
    decision &&
    !cancelled &&
    opts.isLatestAssistant &&
    decision.mode === "input_only"
  ) {
    return (
      <p
        key={key}
        className="text-sm text-muted-foreground"
        data-testid="session-input-only-hint"
      >
        {decision.question}
        {decision.inputPlaceholder
          ? ` — ${decision.inputPlaceholder}`
          : ""}
      </p>
    );
  }
  return null;
}
