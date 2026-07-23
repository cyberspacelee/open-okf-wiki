/**
 * Timeline Work block: main agent tracks subagent progress.
 *
 * Collapsed rows show role · task · recent activity (last tool / snippet).
 * Expand = full unit body (thinking / tools / text). Body authority = units fold.
 */

import { ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import {
  unitRecentActivity,
  unitsForRun,
  type WorkUnits,
  type WorkUnitView,
  workBlockProgress,
} from "../hooks/project-agent-events";
import { WorkUnitBody } from "./WorkUnitBody";

export type WorkBlockProps = {
  runId?: string | null;
  phase?: string | null;
  units: WorkUnits;
  expandedUnitId?: string | null;
  onExpandedUnitIdChange?: (unitId: string | null) => void;
  className?: string;
};

function statusDotClass(status: string): string {
  if (status === "failed") return "bg-destructive";
  if (status === "running" || status === "pending") return "bg-primary";
  if (status === "settled") return "bg-success";
  return "bg-muted-foreground/40";
}

function UnitRow({
  unit,
  open,
  onOpenChange,
  scrollIntoView,
}: {
  unit: WorkUnitView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scrollIntoView: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const isRunning = unit.status === "running" || unit.status === "pending";
  const isFailed = unit.status === "failed";
  const activity = unitRecentActivity(unit);

  useEffect(() => {
    if (scrollIntoView && ref.current) {
      ref.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [scrollIntoView]);

  const roleLabel =
    t.agentWorkspace.roles[unit.role as keyof typeof t.agentWorkspace.roles] ?? unit.role;
  const statusLabel =
    t.agentWorkspace.unitStatus[unit.status as keyof typeof t.agentWorkspace.unitStatus] ??
    unit.status;
  const title = unit.task?.trim() || roleLabel;

  return (
    <div
      ref={ref}
      className="w-full min-w-0"
      data-testid="work-unit-row"
      data-unit-id={unit.unitId}
      data-unit-status={unit.status}
    >
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50">
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
          {isRunning ? (
            <Spinner className="size-3 shrink-0 text-primary" />
          ) : (
            <span className={cn("size-2 shrink-0 rounded-full", statusDotClass(unit.status))} />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 text-muted-foreground">{roleLabel}</span>
              <span className="min-w-0 truncate font-medium">{title}</span>
            </span>
            {activity && !open ? (
              <span
                className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground"
                data-testid="work-unit-activity"
              >
                {activity}
              </span>
            ) : null}
            {isRunning && !activity && !open ? (
              <span
                className="mt-0.5 block text-[10px] text-muted-foreground"
                data-testid="waiting-for-events"
              >
                {t.agentWorkspace.waitingForEvents}
              </span>
            ) : null}
          </span>
          <span
            className={cn(
              "shrink-0 text-[11px]",
              isFailed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {statusLabel}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 border-l border-border/50 py-2 pl-4 ml-3">
          <WorkUnitBody unit={unit} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function WorkBlock({
  runId,
  phase,
  units,
  expandedUnitId = null,
  onExpandedUnitIdChange,
  className,
}: WorkBlockProps) {
  const { t } = useI18n();
  const list = unitsForRun(units, runId);
  const progress = useMemo(() => workBlockProgress(list), [list]);
  const phaseLabel = phase
    ? (t.agentWorkspace.phases[phase as keyof typeof t.agentWorkspace.phases] ??
      phase.replace(/_/g, " "))
    : null;

  const progressBits: string[] = [];
  if (progress.total > 0) {
    progressBits.push(
      t.agentWorkspace.workProgressDone
        .replace("{done}", String(progress.settled))
        .replace("{total}", String(progress.total)),
    );
  }
  if (progress.running + progress.pending > 0) {
    progressBits.push(
      t.agentWorkspace.workRunningCount.replace("{n}", String(progress.running + progress.pending)),
    );
  }
  if (progress.failed > 0) {
    progressBits.push(t.agentWorkspace.workFailedCount.replace("{n}", String(progress.failed)));
  }

  return (
    <div
      className={cn(
        "w-full min-w-0 max-w-[min(100%,42rem)] rounded-lg border border-border/70 bg-muted/20 px-2.5 py-2",
        className,
      )}
      data-testid="work-block"
      data-run-id={runId ?? undefined}
      data-unit-total={progress.total}
      data-unit-running={progress.running + progress.pending}
      data-unit-settled={progress.settled}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{t.agentWorkspace.workBlockTitle}</span>
        {phaseLabel ? <span className="text-muted-foreground">{phaseLabel}</span> : null}
        {progressBits.length > 0 ? (
          <span
            className="inline-flex items-center gap-1 text-muted-foreground"
            data-testid="work-block-progress"
          >
            {progress.running + progress.pending > 0 ? <Spinner className="size-3" /> : null}
            {progressBits.join(" · ")}
          </span>
        ) : null}
      </div>
      {list.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t.agentWorkspace.waitingForUnits}</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-0.5">
          {list.map((unit) => {
            const open = expandedUnitId === unit.unitId;
            return (
              <li key={unit.unitId} className="min-w-0">
                <UnitRow
                  unit={unit}
                  open={open}
                  scrollIntoView={open}
                  onOpenChange={(next) => {
                    onExpandedUnitIdChange?.(next ? unit.unitId : null);
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
