/**
 * Agent Workspace 3-pane shell (ADR 0030).
 *
 * left: session list · center: transcript + composer · right: context panels
 * Uses existing shadcn Sidebar primitives only for density cues; layout is
 * a plain flex split (not the app nav Sidebar).
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import {
  LayoutListIcon,
  PanelRightIcon,
  SettingsIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useI18n } from "../../i18n";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Composer } from "./composer/Composer";
import { ContextPanels } from "./panels/ContextPanels";
import { SessionList } from "./session-list/SessionList";
import { Transcript } from "./transcript/Transcript";
import type {
  AgentMessage,
  AgentStatus,
} from "./hooks/useSessionAgent";
import type {
  ModelProfilePublic,
  PiSessionSummary,
  StoredRunRecord,
  WikiRunPlan,
  WorkspaceConfig,
} from "../../api";

export type AgentWorkspaceShellProps = {
  workspaceId: string;
  workspace: WorkspaceConfig | null;
  rootPath?: string;
  sessions: PiSessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  creatingSession?: boolean;
  messages: AgentMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStartWikiRun: () => void;
  onAbort: () => void;
  agentStatus: AgentStatus;
  agentError?: unknown;
  onDismissAgentError?: () => void;
  plan?: WikiRunPlan | null;
  linkedRunId?: string | null;
  phase?: string | null;
  recentRuns?: StoredRunRecord[];
  className?: string;
  /** Settings model catalog for wiki-run picker. */
  models?: ModelProfilePublic[];
  wikiModelProfileId?: string;
  onWikiModelProfileIdChange?: (profileId: string) => void;
  defaultModelProfileId?: string;
};

export function AgentWorkspaceShell({
  workspaceId,
  workspace,
  rootPath,
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  creatingSession = false,
  messages,
  input,
  onInputChange,
  onSend,
  onStartWikiRun,
  onAbort,
  agentStatus,
  agentError,
  onDismissAgentError,
  plan = null,
  linkedRunId = null,
  phase = null,
  recentRuns = [],
  className,
  models = [],
  wikiModelProfileId = "",
  onWikiModelProfileIdChange,
  defaultModelProfileId,
}: AgentWorkspaceShellProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  const sessionList = (
    <SessionList
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelect={(id) => {
        onSelectSession(id);
        setLeftOpen(false);
      }}
      onCreate={onCreateSession}
      creating={creatingSession}
    />
  );

  const contextPanels = (
    <ContextPanels
      workspaceId={workspaceId}
      rootPath={rootPath}
      workspace={workspace}
      plan={plan}
      linkedRunId={linkedRunId}
      phase={phase}
      recentRuns={recentRuns}
    />
  );

  return (
    <div
      data-testid="agent-workspace-shell"
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background",
        className,
      )}
    >
      {/* Compact chrome */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5">
        {isMobile ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t.agentWorkspace.sessions}
            onClick={() => setLeftOpen(true)}
          >
            <LayoutListIcon />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-tight">
            {workspace?.name ?? t.agentWorkspace.title}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {workspace?.rootPath ?? rootPath ?? workspaceId}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          render={
            <Link
              to={`/workspaces/${encodeURIComponent(workspaceId)}/settings${
                rootPath
                  ? `?${new URLSearchParams({ rootPath }).toString()}`
                  : ""
              }`}
            />
          }
        >
          <SettingsIcon data-icon="inline-start" />
          <span className="hidden sm:inline">
            {t.agentWorkspace.workspaceSettings}
          </span>
        </Button>
        {isMobile ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t.agentWorkspace.panels}
            onClick={() => setRightOpen(true)}
          >
            <PanelRightIcon />
          </Button>
        ) : null}
      </header>

      {agentError ? (
        <div className="shrink-0 px-2.5 pt-2">
          <ErrorBanner error={agentError} onDismiss={onDismissAgentError} />
        </div>
      ) : null}

      {/* 3 panes */}
      <div className="flex min-h-0 flex-1">
        {!isMobile ? (
          <aside className="flex w-56 shrink-0 flex-col border-r border-border md:w-60">
            {sessionList}
          </aside>
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Transcript messages={messages} />
          <Composer
            input={input}
            onInputChange={onInputChange}
            onSend={onSend}
            onStartWikiRun={onStartWikiRun}
            onAbort={onAbort}
            status={agentStatus}
            disabled={!activeSessionId}
            models={models}
            wikiModelProfileId={wikiModelProfileId}
            onWikiModelProfileIdChange={onWikiModelProfileIdChange}
            defaultModelProfileId={defaultModelProfileId}
          />
        </main>

        {!isMobile ? (
          <aside className="flex w-64 shrink-0 flex-col border-l border-border lg:w-72">
            {contextPanels}
          </aside>
        ) : null}
      </div>

      {isMobile ? (
        <>
          <Sheet open={leftOpen} onOpenChange={setLeftOpen}>
            <SheetContent side="left" className="w-[min(100%,18rem)] p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>{t.agentWorkspace.sessions}</SheetTitle>
              </SheetHeader>
              {sessionList}
            </SheetContent>
          </Sheet>
          <Sheet open={rightOpen} onOpenChange={setRightOpen}>
            <SheetContent side="right" className="w-[min(100%,20rem)] p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>{t.agentWorkspace.panels}</SheetTitle>
              </SheetHeader>
              {contextPanels}
            </SheetContent>
          </Sheet>
        </>
      ) : null}
    </div>
  );
}
