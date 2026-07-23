/**
 * Agents tree — navigation only over units fold.
 * Click selects unit for timeline expand/scroll (no second body host).
 */

import { ChevronRightIcon, GitBranchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { unitRecentActivity } from "../hooks/project-agent-events";
import type { WorkUnits, WorkUnitView } from "../hooks/useSessionAgent";

export type AgentTreeNode = {
  id: string;
  role: string;
  status: string;
  parentId: string | null;
  task?: string;
  unitId: string;
  activity?: string;
};

function nodesFromUnits(units: WorkUnits): AgentTreeNode[] {
  return Object.values(units).map((u: WorkUnitView) => ({
    id: u.unitId,
    unitId: u.unitId,
    role: u.role,
    status: u.status,
    parentId: u.parentId && u.parentId !== "root" ? u.parentId : null,
    task: u.task,
    activity: unitRecentActivity(u),
  }));
}

function childrenOf(nodes: AgentTreeNode[], parentId: string): AgentTreeNode[] {
  return nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.id.localeCompare(b.id));
}

function rootsOf(nodes: AgentTreeNode[]): AgentTreeNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes
    .filter((n) => !n.parentId || !ids.has(n.parentId))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function statusDotClass(status: string): string {
  if (status === "failed") return "bg-destructive";
  if (status === "running" || status === "pending") return "bg-primary";
  if (status === "settled") return "bg-success";
  return "bg-muted-foreground/40";
}

function TreeNodeRow({
  node,
  nodes,
  depth,
  selectedId,
  onSelect,
}: {
  node: AgentTreeNode;
  nodes: AgentTreeNode[];
  depth: number;
  selectedId: string | null;
  onSelect: (unitId: string) => void;
}) {
  const { t } = useI18n();
  const kids = childrenOf(nodes, node.id);
  const [open, setOpen] = useState(depth < 2);
  const selected = selectedId === node.unitId;
  const isRunning = node.status === "running" || node.status === "pending";
  const roleLabel =
    t.agentWorkspace.roles[node.role as keyof typeof t.agentWorkspace.roles] ?? node.role;
  const statusLabel =
    t.agentWorkspace.unitStatus[node.status as keyof typeof t.agentWorkspace.unitStatus] ??
    node.status;

  return (
    <div className="flex flex-col gap-0.5" style={{ paddingLeft: depth * 10 }}>
      <div className="flex items-start gap-0.5">
        {kids.length > 0 ? (
          <button
            type="button"
            className="mt-1.5 shrink-0 rounded p-0.5 hover:bg-muted"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
            />
          </button>
        ) : (
          <span className="inline-block w-4 shrink-0" />
        )}
        <button
          type="button"
          data-testid="agent-tree-select"
          data-unit-id={node.unitId}
          className={cn(
            "min-w-0 flex-1 rounded-md px-1.5 py-1 text-left text-[11px]",
            selected ? "bg-muted" : "hover:bg-muted/50",
          )}
          onClick={() => onSelect(node.unitId)}
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  statusDotClass(node.status),
                  isRunning && "animate-pulse",
                )}
              />
              <span className="shrink-0 text-muted-foreground">{roleLabel}</span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {node.task?.trim() || roleLabel}
              </span>
              <span className="shrink-0 text-muted-foreground">{statusLabel}</span>
            </div>
            {node.activity ? (
              <span className="truncate pl-3 font-mono text-[10px] text-muted-foreground">
                {node.activity}
              </span>
            ) : null}
          </div>
        </button>
      </div>
      {kids.length > 0 && open
        ? kids.map((c) => (
            <TreeNodeRow
              key={c.id}
              node={c}
              nodes={nodes}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  );
}

export type AgentTreeProps = {
  units?: WorkUnits;
  selectedUnitId?: string | null;
  onSelectUnit?: (unitId: string) => void;
  hasRun?: boolean;
  className?: string;
};

export function AgentTree({
  units = {},
  selectedUnitId = null,
  onSelectUnit,
  hasRun = false,
  className,
}: AgentTreeProps) {
  const { t } = useI18n();
  const nodes = useMemo(() => nodesFromUnits(units), [units]);
  const roots = useMemo(() => rootsOf(nodes), [nodes]);

  if (!hasRun && roots.length === 0) {
    return <p className="text-xs text-muted-foreground">{t.agentWorkspace.agentTreeNoRun}</p>;
  }

  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="agent-tree">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <GitBranchIcon className="size-3.5" />
        {t.agentWorkspace.agentTreeTitle}
      </div>
      {roots.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.agentWorkspace.agentTreeEmpty}</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {roots.map((n) => (
            <TreeNodeRow
              key={n.id}
              node={n}
              nodes={nodes}
              depth={0}
              selectedId={selectedUnitId}
              onSelect={(id) => onSelectUnit?.(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
