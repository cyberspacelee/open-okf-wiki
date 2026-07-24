/**
 * Right-pane context: Plan | Agents (nav) | Run status.
 * HITL actions live only on the Transcript. Nav to Sources/Wiki/Settings is Subnav.
 */

import { ExternalLinkIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { StoredRunRecord, WikiRunPlan, WorkspaceConfig } from "../../api";
import { useI18n } from "../../i18n";
import { workspaceHref } from "../../lib/workspace-path";
import type { ProduceUnit } from "../hooks/project/produce";
import { AgentTree } from "./AgentTree";

export type ContextPanelsProps = {
  workspaceId: string;
  rootPath?: string;
  workspace: WorkspaceConfig | null;
  plan?: WikiRunPlan | null;
  linkedRunId?: string | null;
  phase?: string | null;
  recentRuns?: StoredRunRecord[];
  produceUnits?: ProduceUnit[];
  focusedUnitId?: string | null;
  onFocusUnit?: (unitId: string) => void;
  className?: string;
};

function PanelShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <ScrollArea className={cn("min-h-0 flex-1", className)}>
      <div className="flex flex-col gap-3 p-3 text-sm">{children}</div>
    </ScrollArea>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground">{text}</p>;
}

function PlanPageList({
  pages,
}: {
  pages: Array<{ path: string; purpose?: string }>;
}) {
  const n = pages.length;
  if (n === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded border border-border/60 bg-background/40"
      data-testid="context-plan-pages"
    >
      <div className="sticky top-0 z-[1] border-b border-border/40 bg-background/90 px-2 py-1 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
        {n} page{n === 1 ? "" : "s"}
      </div>
      <ul
        className={cn(
          "min-w-0 overflow-y-auto overscroll-contain px-1.5 py-1 font-mono text-[11px] leading-snug",
          n > 20 ? "max-h-72" : n > 10 ? "max-h-56" : "max-h-48",
        )}
      >
        {pages.map((page, i) => (
          <li
            key={page.path}
            className="min-w-0 break-all rounded px-1.5 py-1.5 text-foreground/90 odd:bg-muted/25"
            title={page.path}
          >
            <span className="mr-1.5 tabular-nums text-muted-foreground/70">
              {String(i + 1).padStart(2, "0")}
            </span>
            {page.path}
            {page.purpose ? (
              <span className="mt-0.5 block font-sans text-[10px] leading-snug text-muted-foreground">
                {page.purpose}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ContextPanels({
  workspaceId,
  rootPath,
  plan = null,
  linkedRunId = null,
  phase = null,
  recentRuns = [],
  produceUnits = [],
  focusedUnitId = null,
  onFocusUnit,
  className,
}: ContextPanelsProps) {
  const { t } = useI18n();

  return (
    <div
      data-testid="agent-context-panels"
      className={cn("flex h-full min-h-0 flex-col", className)}
    >
      <Tabs defaultValue="plan" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 border-b border-border px-2 pt-2 pb-0">
          <TabsList variant="line" className="h-8 w-full justify-start gap-0 overflow-x-auto">
            <TabsTrigger value="plan" className="text-xs">
              {t.agentWorkspace.panelPlan}
            </TabsTrigger>
            <TabsTrigger value="agents" className="text-xs">
              {t.agentWorkspace.panelAgents}
            </TabsTrigger>
            <TabsTrigger value="status" className="text-xs">
              {t.agentWorkspace.panelRun}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="plan" className="mt-0 flex min-h-0 flex-1 flex-col data-hidden:hidden">
          <PanelShell>
            <span className="text-xs font-medium">{t.agentWorkspace.panelPlan}</span>
            {!plan ? (
              <EmptyHint text={t.agentWorkspace.planEmpty} />
            ) : (
              <div className="flex flex-col gap-2">
                {plan.summary ? (
                  <p className="text-xs whitespace-pre-wrap">{plan.summary}</p>
                ) : null}
                {"domains" in plan &&
                Array.isArray((plan as { domains?: unknown }).domains) &&
                ((plan as { domains: Array<{ id: string; title?: string; scope?: string }> })
                  .domains?.length ?? 0) > 0 ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {t.agentWorkspace.domains}
                    </span>
                    <ul className="flex flex-col gap-1">
                      {(
                        plan as {
                          domains: Array<{
                            id: string;
                            title?: string;
                            scope?: string;
                          }>;
                        }
                      ).domains.map((d) => (
                        <li
                          key={d.id}
                          className="rounded border border-border/60 px-2 py-1 text-[11px]"
                        >
                          <span className="font-mono font-medium">{d.id}</span>
                          {d.title ? (
                            <span className="text-muted-foreground"> — {d.title}</span>
                          ) : null}
                          {d.scope ? (
                            <span className="mt-0.5 block break-words text-muted-foreground">
                              {d.scope}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {plan.notes ? (
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">{plan.notes}</p>
                ) : null}
                <PlanPageList pages={plan.pages ?? []} />
              </div>
            )}
            <EmptyHint text={t.agentWorkspace.planJumpToGate} />
          </PanelShell>
        </TabsContent>

        <TabsContent
          value="agents"
          className="mt-0 flex min-h-0 flex-1 flex-col data-hidden:hidden"
        >
          <PanelShell>
            <AgentTree
              hasRun={Boolean(linkedRunId)}
              phase={phase}
              produceUnits={produceUnits}
              focusedUnitId={focusedUnitId}
              onFocusUnit={onFocusUnit}
            />
          </PanelShell>
        </TabsContent>

        <TabsContent
          value="status"
          className="mt-0 flex min-h-0 flex-1 flex-col data-hidden:hidden"
        >
          <PanelShell>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">{t.agentWorkspace.panelRun}</span>
              <Link
                to={workspaceHref(workspaceId, "/run", rootPath)}
                className={cn(buttonVariants({ size: "xs", variant: "ghost" }), "no-underline")}
              >
                <ExternalLinkIcon data-icon="inline-start" />
                {t.agentWorkspace.openFull}
              </Link>
            </div>
            <dl className="grid gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">{t.agentWorkspace.linkedRun}</dt>
                <dd className="mt-0.5 break-all font-mono">{linkedRunId ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t.agentWorkspace.phase}</dt>
                <dd className="mt-0.5">
                  <Badge variant="secondary">
                    {phase
                      ? (t.agentWorkspace.phases[phase as keyof typeof t.agentWorkspace.phases] ??
                        phase)
                      : "idle"}
                  </Badge>
                </dd>
              </div>
            </dl>
            {recentRuns.length === 0 ? (
              <EmptyHint text={t.agentWorkspace.runsEmpty} />
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {recentRuns.slice(0, 8).map((run) => (
                  <li
                    key={run.runId}
                    className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1 text-[11px]"
                  >
                    <span className="truncate font-mono">{run.runId}</span>
                    <Badge variant="outline">{run.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </PanelShell>
        </TabsContent>
      </Tabs>
    </div>
  );
}
