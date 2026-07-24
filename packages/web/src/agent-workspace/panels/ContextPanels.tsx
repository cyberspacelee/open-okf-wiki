/** Read-only workspace context beside the sole Operator Session surface. */

import { BookOpenIcon, ExternalLinkIcon, FolderGit2Icon } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { StoredRunRecord, WorkspaceConfig } from "../../api";
import { useI18n } from "../../i18n";
import { workspaceHref } from "../../lib/workspace-path";

export type ContextPanelsProps = {
  workspaceId: string;
  rootPath?: string;
  workspace: WorkspaceConfig | null;
  recentRuns?: StoredRunRecord[];
  className?: string;
};

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 p-3 text-sm">{children}</div>
    </ScrollArea>
  );
}

function OpenLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className={cn(buttonVariants({ size: "xs", variant: "ghost" }), "no-underline")}>
      <ExternalLinkIcon data-icon="inline-start" />
      {label}
    </Link>
  );
}

export function ContextPanels({
  workspaceId,
  rootPath,
  workspace,
  recentRuns = [],
  className,
}: ContextPanelsProps) {
  const { t } = useI18n();
  const sources = workspace?.sources ?? [];

  return (
    <div
      data-testid="agent-context-panels"
      className={cn("flex h-full min-h-0 flex-col", className)}
    >
      <Tabs defaultValue="sources" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 border-b border-border px-2 pt-2 pb-0">
          <TabsList variant="line" className="h-8 w-full justify-start gap-0 overflow-x-auto">
            <TabsTrigger value="sources" className="text-xs">
              {t.agentWorkspace.panelSources}
            </TabsTrigger>
            <TabsTrigger value="runs" className="text-xs">
              {t.agentWorkspace.panelRun}
            </TabsTrigger>
            <TabsTrigger value="wiki" className="text-xs">
              {t.agentWorkspace.panelWiki}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="sources"
          className="mt-0 flex min-h-0 flex-1 flex-col data-hidden:hidden"
        >
          <PanelShell>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                <FolderGit2Icon className="size-3.5" />
                {t.agentWorkspace.panelSources}
              </span>
              <OpenLink
                to={workspaceHref(workspaceId, "/sources", rootPath)}
                label={t.agentWorkspace.openFull}
              />
            </div>
            {sources.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t.sources.description}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {sources.map((source) => (
                  <li key={source.id} className="rounded border border-border/60 px-2 py-1.5">
                    <div className="truncate font-mono text-xs font-medium">{source.id}</div>
                    <div className="mt-0.5 break-all text-[10px] text-muted-foreground">
                      {source.path}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </PanelShell>
        </TabsContent>

        <TabsContent value="runs" className="mt-0 flex min-h-0 flex-1 flex-col data-hidden:hidden">
          <PanelShell>
            <span className="text-xs font-medium">{t.agentWorkspace.panelRun}</span>
            {recentRuns.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t.agentWorkspace.runsEmpty}</p>
            ) : (
              <ul className="flex flex-col gap-1.5" data-testid="agent-readonly-runs">
                {recentRuns.slice(0, 12).map((run) => (
                  <li
                    key={run.runId}
                    className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1.5 text-[11px]"
                  >
                    <span className="min-w-0 truncate font-mono" title={run.runId}>
                      {run.runId}
                    </span>
                    <Badge variant="outline">{run.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </PanelShell>
        </TabsContent>

        <TabsContent value="wiki" className="mt-0 flex min-h-0 flex-1 flex-col data-hidden:hidden">
          <PanelShell>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                <BookOpenIcon className="size-3.5" />
                {t.agentWorkspace.panelWiki}
              </span>
              <OpenLink
                to={workspaceHref(workspaceId, "/wiki", rootPath)}
                label={t.agentWorkspace.openFull}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t.wiki.description}</p>
            <p className="break-all font-mono text-[10px] text-muted-foreground">
              {workspace?.publicationPath ?? "—"}
            </p>
          </PanelShell>
        </TabsContent>
      </Tabs>
    </div>
  );
}
