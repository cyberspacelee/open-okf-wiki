/**
 * Phase chip on Session timeline — same SessionCard chrome as tools/workflow.
 */

import { useI18n } from "../../i18n";
import { SessionCard } from "./SessionCard";
import { sessionCardMeta } from "./session-card-styles";
import { ActivityIcon } from "lucide-react";

const PHASES = [
  "planning",
  "awaiting_plan",
  "writing",
  "awaiting_publish",
  "done",
] as const;

export type PhaseProgressProps = {
  phase: string;
  label?: string;
  runId?: string;
  failed?: boolean;
};

export function PhaseProgress({
  phase,
  label,
  runId,
  failed,
}: PhaseProgressProps) {
  const { t } = useI18n();
  const phaseLabels = t.session.phase as Record<string, string>;
  const title =
    label ||
    (failed ? phaseLabels.failed || "Failed" : undefined) ||
    phaseLabels[phase] ||
    phase.replace(/_/g, " ");

  const cur = PHASES.indexOf(phase as (typeof PHASES)[number]);

  return (
    <SessionCard
      title={title}
      icon={<ActivityIcon className="size-4" />}
      status={failed ? "failed" : phase === "done" ? "completed" : "running"}
      failed={failed}
      defaultOpen={false}
      data-testid="session-phase-progress"
      dataAttrs={{
        phase,
        failed: failed ? "true" : undefined,
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        {!failed ? (
          <div className="flex items-center gap-1.5">
            {PHASES.map((p, idx) => {
              const active = cur >= 0 && idx <= cur;
              const current = p === phase;
              return (
                <span
                  key={p}
                  title={phaseLabels[p] ?? p}
                  className={
                    current
                      ? "size-2 rounded-full bg-primary"
                      : active
                        ? "size-1.5 rounded-full bg-primary/50"
                        : "size-1.5 rounded-full bg-muted-foreground/30"
                  }
                />
              );
            })}
          </div>
        ) : null}
        {runId ? (
          <span className={`font-mono ${sessionCardMeta}`}>
            {runId.slice(0, 8)}…
          </span>
        ) : null}
        <span className={sessionCardMeta}>
          {phaseLabels[phase] ?? phase}
        </span>
      </div>
    </SessionCard>
  );
}
