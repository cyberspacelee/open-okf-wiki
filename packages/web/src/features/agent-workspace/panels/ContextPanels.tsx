/**
 * Right-pane context tabs: Sources | Wiki | Plan | Run (audit).
 * Lightweight projections — full editors stay on legacy routes for now.
 */

import { Link } from "react-router-dom";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type {
  StoredRunRecord,
  WikiRunPlan,
  WorkspaceConfig,
  WorkspaceSource,
} from "../../../api";
import { useI18n } from "../../../i18n";
import { workspaceHref } from "../../../lib/workspace-path";

export type ContextPanelsProps = {
  workspaceId: string;
  rootPath?: string;
  workspace: WorkspaceConfig | null;
  /** Linked plan when known (from product gate inject or legacy session). */
  plan?: WikiRunPlan | null;
  linkedRunId?: string | null;
  phase?: string | null;
  recentRuns?: StoredRunRecord[];
  className?: string;
};

function PanelShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <ScrollArea className={cn("min-h-0 flex-1", className)}>
      <div className="flex flex-col gap-3 p-3 text-sm">{children}</div>
    </ScrollArea>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground">{text}</p>;
}

function OpenFullLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className={cn(
        buttonVariants({ size: "xs", variant: "ghost" }),
        "no-underline",
      )}
    >
      <ExternalLinkIcon data-icon="inline-start" />
      {label}
    </Link>
  );
}

export function ContextPanels({
  workspaceId,
  rootPath,
  workspace,
  plan = null,
  linkedRunId = null,
  phase = null,
  recentRuns = [],
  className,
}: ContextPanelsProps) {
  const { t } = useI18n();
  const sources: WorkspaceSource[] = workspace?.sources ?? [];

  return (
    <div
      data-testid="agent-context-panels"
      className={cn("flex h-full min-h-0 flex-col", className)}
    >
      <Tabs defaultValue="sources" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 border-b border-border px-2 pt-2 pb-0">
          <TabsList
            variant="line"
            className="h-8 w-full justify-start gap-0 overflow-x-auto"
          >
            <TabsTrigger value="sources" className="text-xs">
              {t.agentWorkspace.panelSources}
            </TabsTrigger>
            <TabsTrigger value="wiki" className="text-xs">
              {t.agentWorkspace.panelWiki}
            </TabsTrigger>
            <TabsTrigger value="plan" className="text-xs">
              {t.agentWorkspace.panelPlan}
            </TabsTrigger>
            <TabsTrigger value="run" className="text-xs">
              {t.agentWorkspace.panelRun}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="sources"
          className="mt-0 flex min-h-0 flex-1 flex-col data-hidden:hidden"
        >
          <PanelShell>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold tracking-wide uppercase">
                {t.agentWorkspace.panelSources}
              </span>
              <OpenFullLink
                to={workspaceHref(workspaceId, "/sources", rootPath)}
                label={t.agentWorkspace.openFull}
              />
            </div>
            {sources.length === 0 ? (
              <EmptyHint text={t.agentWorkspace.sourcesEmpty} />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {sources.map((source) => (
                  <li
                    key={source.id}
                    className="rounded-md border border-border/80 px-2 py-1.5"
                  >
                    <div className="font-mono text-xs font-medium">
                      {source.id}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {source.path}
                    </div>
                    <Badge variant="outline" className="mt-1 text-[10px]">
                      {source.origin?.type ?? "path"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </PanelShell>
        </TabsContent>

        <TabsContent
          value="wiki"
          className="mt-0 flex min-h-0 flex-1 flex-col data-hidden:hidden"
        >
          <PanelShell>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold tracking-wide uppercase">
                {t.agentWorkspace.panelWiki}
              </span>
              <OpenFullLink
                to={workspaceHref(workspaceId, "/wiki", rootPath)}
                label={t.agentWorkspace.openFull}
              />
            </div>
            <dl className="grid gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">
                  {t.agentWorkspace.publicationPath}
                </dt>
                <dd className="mt-0.5 break-all font-mono">
                  {workspace?.publicationPath ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t.agentWorkspace.wikiLanguage}
                </dt>
                <dd className="mt-0.5">{workspace?.wikiLanguage ?? "—"}</dd>
              </div>
            </dl>
            <EmptyHint text={t.agentWorkspace.wikiHint} />
          </PanelShell>
        </TabsContent>

        <TabsContent
          value="plan"
          className="mt-0 flex min-h-0 flex-1 flex-col data-hidden:hidden"
        >
          <PanelShell>
            <span className="text-xs font-semibold tracking-wide uppercase">
              {t.agentWorkspace.panelPlan}
            </span>
            {!plan ? (
              <EmptyHint text={t.agentWorkspace.planEmpty} />
            ) : (
              <div className="flex flex-col gap-2">
                {plan.summary ? (
                  <p className="text-xs whitespace-pre-wrap">{plan.summary}</p>
                ) : null}
                {plan.notes ? (
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                    {plan.notes}
                  </p>
                ) : null}
                <ul className="flex flex-col gap-1">
                  {(plan.pages ?? []).map((page) => (
                    <li
                      key={page.path}
                      className="rounded border border-border/70 px-2 py-1 font-mono text-[11px]"
                    >
                      {page.path}
                      {page.purpose ? (
                        <span className="mt-0.5 block font-sans text-muted-foreground">
                          {page.purpose}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </PanelShell>
        </TabsContent>

        <TabsContent
          value="run"
          className="mt-0 flex min-h-0 flex-1 flex-col data-hidden:hidden"
        >
          <PanelShell>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold tracking-wide uppercase">
                {t.agentWorkspace.panelRun}
              </span>
              <OpenFullLink
                to={workspaceHref(workspaceId, "/run", rootPath)}
                label={t.agentWorkspace.openFull}
              />
            </div>
            <dl className="grid gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">
                  {t.agentWorkspace.linkedRun}
                </dt>
                <dd className="mt-0.5 font-mono">{linkedRunId ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t.agentWorkspace.phase}
                </dt>
                <dd className="mt-0.5">
                  <Badge variant="secondary">{phase ?? "idle"}</Badge>
                </dd>
              </div>
            </dl>
            {recentRuns.length === 0 ? (
              <EmptyHint text={t.agentWorkspace.runsEmpty} />
            ) : (
              <ul className="flex flex-col gap-1">
                {recentRuns.slice(0, 8).map((run) => (
                  <li
                    key={run.runId}
                    className="flex items-center justify-between gap-2 rounded border border-border/70 px-2 py-1 text-[11px]"
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
