/**
 * Chain-of-thought phase strip for a Wiki Run produce turn.
 * Driven by Host data-progress.steps (ADR 0028 UI plan).
 */

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import {
  CheckCircle2Icon,
  CircleIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type PhaseStep = {
  id: string;
  label: string;
  status: "pending" | "active" | "complete" | "failed";
  description?: string;
};

export type RunPhaseStripProps = {
  label?: string;
  steps: PhaseStep[];
  defaultOpen?: boolean;
};

function iconFor(status: PhaseStep["status"]): LucideIcon {
  if (status === "complete") {
    return CheckCircle2Icon;
  }
  if (status === "active") {
    return LoaderIcon;
  }
  if (status === "failed") {
    return XCircleIcon;
  }
  return CircleIcon;
}

function mapStatus(
  status: PhaseStep["status"],
): "complete" | "active" | "pending" {
  if (status === "failed") {
    return "active";
  }
  return status;
}

export function RunPhaseStrip({
  label = "Wiki Run",
  steps,
  defaultOpen = true,
}: RunPhaseStripProps) {
  if (!steps.length) {
    return null;
  }
  return (
    <div className="mb-3" data-testid="session-run-phase-strip">
      <ChainOfThought defaultOpen={defaultOpen}>
        <ChainOfThoughtHeader>{label}</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          {steps.map((s) => (
            <ChainOfThoughtStep
              key={s.id}
              icon={iconFor(s.status)}
              label={s.label}
              description={s.description}
              status={mapStatus(s.status)}
              data-step-id={s.id}
              data-step-status={s.status}
              className={
                s.status === "active"
                  ? "[&_svg]:animate-pulse"
                  : s.status === "failed"
                    ? "text-destructive"
                    : undefined
              }
            />
          ))}
        </ChainOfThoughtContent>
      </ChainOfThought>
    </div>
  );
}
