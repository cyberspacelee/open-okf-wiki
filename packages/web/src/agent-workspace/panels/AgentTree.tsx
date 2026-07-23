/**
 * Run-panel work unit tree: live units from work_run chips + analysis receipts.
 * Click a node to open the Work drawer (unitId is canonical).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRightIcon,
  EyeIcon,
  GitBranchIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  getRunReceipt,
  listRunReceipts,
  type AnalysisReceiptDetail,
  type AnalysisReceiptSummary,
} from "../../api";
import { useI18n } from "../../i18n";
import type { AgentMessage, WorkUnits } from "../hooks/useSessionAgent";
import { AgentUnitBody } from "./AgentFocusDrawer";

export type AgentTreeNode = {
  id: string;
  role: string;
  status: string;
  parentId: string | null;
  label?: string;
  task?: string;
  detail?: string;
  receiptPath?: string;
  /** Canonical unitId for Work surface lookup. */
  unitId?: string;
  source: "unit" | "receipt";
};

function nodesFromMessages(messages: AgentMessage[]): AgentTreeNode[] {
  const byId = new Map<string, AgentTreeNode>();
  for (const m of messages) {
    const p = m.product;
    if (!p) continue;
    // Prefer aggregated Work chip agents (one card per run); agentId === unitId.
    if (p.kind === "work_run" && p.agents?.length) {
      for (const a of p.agents) {
        const id = a.agentId;
        if (!id) continue;
        byId.set(id, {
          id,
          role: a.role ?? "agent",
          status: a.status ?? "unknown",
          parentId: a.parentId && a.parentId !== "root" ? a.parentId : null,
          label: a.task,
          task: a.task,
          detail: a.detail,
          receiptPath: a.receiptPath,
          unitId: a.agentId,
          source: "unit",
        });
      }
    }
  }
  return [...byId.values()];
}

/** Merge live units fold into tree nodes (status / body freshness). */
function mergeUnits(
  spans: AgentTreeNode[],
  units: WorkUnits,
): AgentTreeNode[] {
  const byId = new Map(spans.map((n) => [n.id, n]));
  for (const unit of Object.values(units)) {
    const existing = byId.get(unit.unitId);
    if (existing) {
      byId.set(unit.unitId, {
        ...existing,
        role: unit.role || existing.role,
        status: unit.status || existing.status,
        parentId:
          unit.parentId && unit.parentId !== "root"
            ? unit.parentId
            : existing.parentId,
        task: unit.task || existing.task,
        detail:
          unit.summary ||
          unit.message?.text ||
          unit.error ||
          existing.detail,
        receiptPath: unit.receiptPath || existing.receiptPath,
        unitId: unit.unitId,
        source: "unit",
      });
    } else {
      byId.set(unit.unitId, {
        id: unit.unitId,
        role: unit.role,
        status: unit.status,
        parentId:
          unit.parentId && unit.parentId !== "root" ? unit.parentId : null,
        label: unit.task,
        task: unit.task,
        detail: unit.summary || unit.message?.text || unit.error,
        receiptPath: unit.receiptPath,
        unitId: unit.unitId,
        source: "unit",
      });
    }
  }
  return [...byId.values()];
}

function mergeReceiptNodes(
  spans: AgentTreeNode[],
  receipts: AnalysisReceiptSummary[],
): AgentTreeNode[] {
  const byId = new Map(spans.map((n) => [n.id, n]));
  // Index by unitId / receipt node for linking children
  const byReceiptNode = new Map<string, string>();
  for (const n of byId.values()) {
    if (n.unitId) byReceiptNode.set(n.unitId, n.id);
    if (n.role === "domain" || n.role === "leaf" || n.role === "planner") {
      byReceiptNode.set(n.id, n.id);
    }
  }

  for (const r of receipts) {
    let hitId = byReceiptNode.get(r.nodeId);
    if (!hitId) {
      for (const n of byId.values()) {
        if (
          n.unitId === r.nodeId ||
          n.id === r.nodeId ||
          n.receiptPath?.includes(r.nodeId)
        ) {
          hitId = n.id;
          break;
        }
      }
    }
    if (hitId && byId.has(hitId)) {
      const hit = byId.get(hitId)!;
      byId.set(hitId, {
        ...hit,
        unitId: hit.unitId ?? r.nodeId,
        receiptPath: r.relativePath,
        detail: hit.detail || r.summary,
        task: hit.task || r.scope,
        status:
          hit.status === "running" || hit.status === "pending"
            ? hit.status
            : r.status,
        parentId:
          hit.parentId ??
          (r.parentId && r.parentId !== "root" ? r.parentId : null),
      });
      byReceiptNode.set(r.nodeId, hitId);
    } else {
      const id = r.nodeId;
      byId.set(id, {
        id,
        role: r.nodeId.startsWith("leaf-")
          ? "leaf"
          : r.nodeId.startsWith("domain-")
            ? "domain"
            : "agent",
        status: r.status,
        parentId: r.parentId && r.parentId !== "root" ? r.parentId : null,
        label: r.summary.slice(0, 80),
        task: r.scope,
        detail: r.summary,
        receiptPath: r.relativePath,
        unitId: r.nodeId,
        source: "receipt",
      });
      byReceiptNode.set(r.nodeId, id);
    }
  }

  // Remap parentId receipt node names → tree ids when possible
  for (const n of byId.values()) {
    if (n.parentId && byReceiptNode.has(n.parentId)) {
      const mapped = byReceiptNode.get(n.parentId)!;
      if (mapped !== n.id) {
        byId.set(n.id, { ...n, parentId: mapped });
      }
    }
  }

  return [...byId.values()];
}

function childrenOf(nodes: AgentTreeNode[], parentId: string): AgentTreeNode[] {
  return nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function rootsOf(nodes: AgentTreeNode[]): AgentTreeNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes
    .filter((n) => !n.parentId || !ids.has(n.parentId))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "running" || status === "pending") return "default";
  if (status === "settled" || status === "complete" || status === "done") {
    return "secondary";
  }
  return "outline";
}

function TreeNodeRow({
  node,
  nodes,
  depth,
  onPreview,
}: {
  node: AgentTreeNode;
  nodes: AgentTreeNode[];
  depth: number;
  onPreview: (node: AgentTreeNode) => void;
}) {
  const kids = childrenOf(nodes, node.id);
  const [open, setOpen] = useState(depth < 2);

  return (
    <div className="flex flex-col gap-0.5" style={{ paddingLeft: depth * 10 }}>
      <div className="flex items-start gap-1 rounded-md border border-border/60 bg-muted/20 px-1.5 py-1">
        {kids.length > 0 ? (
          <button
            type="button"
            className="mt-0.5 shrink-0 rounded p-0.5 hover:bg-muted"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform",
                open && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="inline-block w-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="outline" className="text-[10px] normal-case">
              {node.role}
            </Badge>
            <Badge
              variant={statusVariant(node.status)}
              className="text-[10px] normal-case"
            >
              {node.status}
            </Badge>
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {node.unitId || node.id}
            </span>
          </div>
          {(node.task || node.label) && (
            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
              {node.task || node.label}
            </p>
          )}
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="shrink-0"
          onClick={() => onPreview(node)}
          data-testid="agent-tree-preview"
        >
          <EyeIcon className="size-3.5" />
        </Button>
      </div>
      {kids.length > 0 && open
        ? kids.map((c) => (
            <TreeNodeRow
              key={c.id}
              node={c}
              nodes={nodes}
              depth={depth + 1}
              onPreview={onPreview}
            />
          ))
        : null}
    </div>
  );
}

export type AgentTreeProps = {
  workspaceId: string;
  rootPath?: string;
  runId?: string | null;
  messages: AgentMessage[];
  units?: WorkUnits;
  onOpenAgent?: (input: {
    agentId: string;
    role?: string;
    task?: string;
    detail?: string;
  }) => void;
  className?: string;
};

export function AgentTree({
  workspaceId,
  rootPath,
  runId,
  messages,
  units = {},
  onOpenAgent,
  className,
}: AgentTreeProps) {
  const { t } = useI18n();
  const [receipts, setReceipts] = useState<AnalysisReceiptSummary[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [previewNode, setPreviewNode] = useState<AgentTreeNode | null>(null);
  const [previewBody, setPreviewBody] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const spanNodes = useMemo(() => {
    const fromMessages = nodesFromMessages(messages);
    return mergeUnits(fromMessages, units);
  }, [messages, units]);

  const refreshReceipts = useCallback(async () => {
    if (!runId) {
      setReceipts([]);
      return;
    }
    setLoadingList(true);
    setListError(null);
    try {
      const res = await listRunReceipts(workspaceId, runId, rootPath);
      setReceipts(res.receipts ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingList(false);
    }
  }, [workspaceId, runId, rootPath]);

  useEffect(() => {
    void refreshReceipts();
  }, [refreshReceipts]);

  useEffect(() => {
    const hasCompleteReceipt = spanNodes.some(
      (n) =>
        n.receiptPath &&
        (n.status === "settled" ||
          n.status === "complete" ||
          n.status === "failed"),
    );
    if (hasCompleteReceipt && runId) {
      void refreshReceipts();
    }
  }, [spanNodes, runId, refreshReceipts]);

  const nodes = useMemo(
    () => mergeReceiptNodes(spanNodes, receipts),
    [spanNodes, receipts],
  );
  const roots = useMemo(() => rootsOf(nodes), [nodes]);

  const openPreview = useCallback(
    async (node: AgentTreeNode) => {
      const unitId = node.unitId || node.id;
      // Prefer Work surface (live unit) when parent provides a handler.
      if (onOpenAgent) {
        onOpenAgent({
          agentId: unitId,
          role: node.role,
          task: node.task || node.label,
          detail: node.detail,
        });
        return;
      }

      setPreviewNode(node);
      setSheetOpen(true);
      setPreviewBody(node.detail?.trim() || node.task || node.label || "");
      const nodeId = node.unitId || node.id;
      if (!runId || !nodeId) return;
      setPreviewLoading(true);
      try {
        const res = await getRunReceipt(
          workspaceId,
          runId,
          nodeId,
          rootPath,
        );
        const r: AnalysisReceiptDetail = res.receipt;
        const body = [
          `nodeId: ${r.nodeId}`,
          `status: ${r.status}`,
          `scope: ${r.scope}`,
          r.parentId ? `parentId: ${r.parentId}` : null,
          "",
          "## Summary",
          r.summary || "(empty)",
          "",
          r.findings?.length
            ? `## Findings (${r.findings.length})\n${r.findings.map((f) => `- ${f}`).join("\n")}`
            : null,
          r.openQuestions?.length
            ? `## Open questions\n${r.openQuestions.map((q) => `- ${q}`).join("\n")}`
            : null,
          r.childReceipts?.length
            ? `## Child receipts\n${r.childReceipts.map((c) => `- ${c}`).join("\n")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n");
        setPreviewBody(body);
      } catch {
        // Keep unit detail if API fails (e.g. planner has no receipt file).
      } finally {
        setPreviewLoading(false);
      }
    },
    [workspaceId, runId, rootPath, onOpenAgent],
  );

  if (!runId) {
    return (
      <p className="text-xs text-muted-foreground">
        {t.agentWorkspace.agentTreeNoRun}
      </p>
    );
  }

  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      data-testid="agent-tree"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
          <GitBranchIcon className="size-3.5" />
          {t.agentWorkspace.agentTreeTitle}
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={() => void refreshReceipts()}
          disabled={loadingList}
        >
          {loadingList ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
        </Button>
      </div>
      {listError ? (
        <p className="text-[11px] text-destructive">{listError}</p>
      ) : null}
      {roots.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t.agentWorkspace.agentTreeEmpty}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {roots.map((n) => (
            <TreeNodeRow
              key={n.id}
              node={n}
              nodes={nodes}
              depth={0}
              onPreview={(node) => void openPreview(node)}
            />
          ))}
        </div>
      )}

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col sm:max-w-lg"
          data-testid="agent-tree-sheet"
        >
          <SheetHeader>
            <SheetTitle className="font-mono text-sm">
              {[
                previewNode?.role,
                previewNode?.unitId || previewNode?.id,
              ]
                .filter(Boolean)
                .join(" · ")}
            </SheetTitle>
            <SheetDescription>
              {previewNode?.task ||
                previewNode?.label ||
                t.agentWorkspace.subagentPreviewHint}
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
            {previewLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" />
                {t.agentWorkspace.agentTreeLoading}
              </div>
            ) : (
              <div className="min-w-0">
                <AgentUnitBody
                  unit={
                    previewNode
                      ? units[previewNode.unitId ?? previewNode.id] ?? null
                      : null
                  }
                  fallbackDetail={previewBody}
                />
              </div>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}
