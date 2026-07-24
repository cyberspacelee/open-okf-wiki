/**
 * Agents panel — nav-only (ADR 0031 WP6).
 *
 * Lists produce unit roles for navigation. Click focuses the matching
 * produce card on the transcript (scroll + open). Not a fold authority.
 */

import { GitBranchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import type { ProduceUnit } from "../hooks/project/produce";
import {
  orderProduceUnits,
  produceDisplayRoots,
  produceUnitKey,
} from "../hooks/project/produce";

export type AgentTreeProps = {
  hasRun?: boolean;
  phase?: string | null;
  produceUnits?: ProduceUnit[];
  focusedUnitId?: string | null;
  onFocusUnit?: (unitId: string) => void;
  className?: string;
};

type TreeRow = {
  unitId: string;
  role: string;
  status: string;
  task?: string;
  depth: number;
};

function flattenTreeRows(units: readonly ProduceUnit[], depth = 0): TreeRow[] {
  const out: TreeRow[] = [];
  for (const u of units) {
    out.push({
      unitId: produceUnitKey(u),
      role: String(u.role),
      status: String(u.status),
      task: u.task,
      depth,
    });
    if (u.children?.length) {
      out.push(...flattenTreeRows(u.children, depth + 1));
    }
  }
  return out;
}

export function AgentTree({
  hasRun = false,
  phase = null,
  produceUnits = [],
  focusedUnitId = null,
  onFocusUnit,
  className,
}: AgentTreeProps) {
  const { t } = useI18n();
  const phaseLabel = phase
    ? (t.agentWorkspace.phases[phase as keyof typeof t.agentWorkspace.phases] ??
      phase.replace(/_/g, " "))
    : null;

  // Prefer nested display roots (domain → leaf); fall back to flat chronological.
  const roots = produceDisplayRoots(produceUnits);
  const rows =
    roots.length > 0
      ? flattenTreeRows(roots)
      : orderProduceUnits(produceUnits).map((u) => ({
          unitId: produceUnitKey(u),
          role: String(u.role),
          status: String(u.status),
          task: u.task,
          depth: 0,
        }));

  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="agent-tree">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <GitBranchIcon className="size-3.5" />
        {t.agentWorkspace.agentTreeTitle}
      </div>
      {!hasRun && rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.agentWorkspace.agentTreeNoRun}</p>
      ) : (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {phaseLabel ? (
            <p>
              {t.agentWorkspace.phase}: {phaseLabel}
            </p>
          ) : null}
          {rows.length === 0 ? (
            <p data-testid="agent-tree-hint">{t.agentWorkspace.agentTreeEmpty}</p>
          ) : (
            <ul className="flex flex-col gap-0.5" data-testid="agent-tree-units">
              {rows.map((r) => {
                const roleLabel =
                  t.agentWorkspace.produceUnitRole[
                    r.role as keyof typeof t.agentWorkspace.produceUnitRole
                  ] ?? r.role;
                const statusLabel =
                  t.agentWorkspace.produceUnitStatus[
                    r.status as keyof typeof t.agentWorkspace.produceUnitStatus
                  ] ?? r.status;
                const active = focusedUnitId === r.unitId;
                const isRunning = r.status === "running" || r.status === "pending";
                return (
                  <li key={r.unitId} style={{ paddingLeft: r.depth * 10 }}>
                    <button
                      type="button"
                      className={cn(
                        "w-full rounded border px-2 py-1 text-left text-[11px] transition-colors",
                        active
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border/60 hover:bg-muted/40",
                        isRunning && !active && "border-border bg-muted/20",
                      )}
                      data-unit-id={r.unitId}
                      data-unit-role={r.role}
                      data-unit-status={r.status}
                      data-testid="agent-tree-unit"
                      onClick={() => onFocusUnit?.(r.unitId)}
                    >
                      <span className="font-medium text-foreground/80">{roleLabel}</span>
                      <span className="ml-1.5 text-muted-foreground">{statusLabel}</span>
                      {r.task ? (
                        <span className="mt-0.5 block truncate text-muted-foreground">{r.task}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
