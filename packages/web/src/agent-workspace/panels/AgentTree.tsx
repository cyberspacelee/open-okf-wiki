/**
 * Agents panel — nav-only (ADR 0031 WP6).
 *
 * Lists produce unit roles for navigation when parent-visible produceUnits
 * are available (SSE/cold okf.produce_progress). Not a fold authority —
 * transcript owns the expandable cards.
 */

import { GitBranchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import type { ProduceUnit } from "../hooks/project/produce";
import { produceUnitRoles } from "../hooks/project/produce";

export type AgentTreeProps = {
  hasRun?: boolean;
  phase?: string | null;
  /** Parent-visible produce units (roles only; no dual fold). */
  produceUnits?: ProduceUnit[];
  className?: string;
};

export function AgentTree({
  hasRun = false,
  phase = null,
  produceUnits = [],
  className,
}: AgentTreeProps) {
  const { t } = useI18n();
  const phaseLabel = phase
    ? (t.agentWorkspace.phases[phase as keyof typeof t.agentWorkspace.phases] ??
      phase.replace(/_/g, " "))
    : null;
  const roles = produceUnitRoles(produceUnits);

  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="agent-tree">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <GitBranchIcon className="size-3.5" />
        {t.agentWorkspace.agentTreeTitle}
      </div>
      {!hasRun && roles.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.agentWorkspace.agentTreeNoRun}</p>
      ) : (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {phaseLabel ? (
            <p>
              {t.agentWorkspace.phase}: {phaseLabel}
            </p>
          ) : null}
          {roles.length === 0 ? (
            <p data-testid="agent-tree-hint">{t.agentWorkspace.agentTreeEmpty}</p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="agent-tree-units">
              {roles.map((r) => {
                const roleLabel =
                  t.agentWorkspace.produceUnitRole[
                    r.role as keyof typeof t.agentWorkspace.produceUnitRole
                  ] ?? r.role;
                const statusLabel =
                  t.agentWorkspace.produceUnitStatus[
                    r.status as keyof typeof t.agentWorkspace.produceUnitStatus
                  ] ?? r.status;
                return (
                  <li
                    key={r.unitId}
                    className="rounded border border-border/60 px-2 py-1 text-[11px]"
                    data-unit-id={r.unitId}
                    data-unit-role={r.role}
                    data-unit-status={r.status}
                  >
                    <span className="font-medium text-foreground/80">{roleLabel}</span>
                    <span className="ml-1.5 text-muted-foreground">{statusLabel}</span>
                    {r.task ? (
                      <span className="mt-0.5 block truncate text-muted-foreground">{r.task}</span>
                    ) : null}
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
