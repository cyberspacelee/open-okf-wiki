/**
 * Agent Workspace 3-pane shell (ADR 0030).
 *
 * left: session list · center: transcript + composer · right: context panels
 * Page-level Subnav owns workspace chrome; this shell only toggles panes on mobile.
 */

import { useState } from "react";
import { LayoutListIcon, PanelRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useI18n } from "../i18n";
import { ErrorBanner } from "../components/ErrorBanner";
import { Composer } from "./composer/Composer";
import { ContextPanels } from "./panels/ContextPanels";
import { SessionList } from "./session-list/SessionList";
import { Transcript } from "./transcript/Transcript";
import type {
  AgentMessage,
  AgentStatus,
  PendingGate,
  ResumeGateInput,
  WorkUnits,
  WorkUnitView,
} from "./hooks/useSessionAgent";
import type {
  ModelProfilePublic,
  PiSessionSummary,
  StoredRunRecord,
  WikiRunPlan,
  WorkspaceConfig,
} from "../api";
import { AgentFocusDrawer } from "./panels/AgentFocusDrawer";

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
  /** HITL only on Transcript — still needed for gate cards there. */
  pendingGate?: PendingGate | null;
  gateBusy?: boolean;
  onResumeGate?: (input: ResumeGateInput) => void | Promise<void>;
  recentRuns?: StoredRunRecord[];
  className?: string;
  /** Settings model catalog for wiki-run picker. */
  models?: ModelProfilePublic[];
  wikiModelProfileId?: string;
  onWikiModelProfileIdChange?: (profileId: string) => void;
  defaultModelProfileId?: string;
  /** Produce work units fold cache (Work surface). */
  units?: WorkUnits;
  focusAgentId?: string | null;
  onFocusAgentIdChange?: (agentId: string | null) => void;
  focusedUnit?: WorkUnitView | null;
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
  pendingGate = null,
  gateBusy = false,
  onResumeGate,
  recentRuns = [],
  className,
  models = [],
  wikiModelProfileId = "",
  onWikiModelProfileIdChange,
  defaultModelProfileId,
  units = {},
  focusAgentId = null,
  onFocusAgentIdChange,
  focusedUnit = null,
}: AgentWorkspaceShellProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [focusMeta, setFocusMeta] = useState<{
    role?: string;
    task?: string;
    detail?: string;
  }>({});

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

  const openAgent = (input: {
    agentId: string;
    role?: string;
    task?: string;
    detail?: string;
  }) => {
    setFocusMeta({
      role: input.role,
      task: input.task,
      detail: input.detail,
    });
    onFocusAgentIdChange?.(input.agentId);
  };

  const contextPanels = (
    <ContextPanels
      workspaceId={workspaceId}
      rootPath={rootPath}
      workspace={workspace}
      plan={plan}
      linkedRunId={linkedRunId}
      messages={messages}
      phase={phase}
      recentRuns={recentRuns}
      units={units}
      onOpenAgent={openAgent}
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
      {/* Mobile-only pane toggles — desktop chrome lives in page Subnav. */}
      {isMobile ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t.agentWorkspace.sessions}
            onClick={() => setLeftOpen(true)}
          >
            <LayoutListIcon />
          </Button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium">
            {workspace?.name ?? t.agentWorkspace.title}
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t.agentWorkspace.panels}
            onClick={() => setRightOpen(true)}
          >
            <PanelRightIcon />
          </Button>
        </header>
      ) : null}

      {agentError ? (
        <div className="shrink-0 px-2.5 pt-2">
          <ErrorBanner error={agentError} onDismiss={onDismissAgentError} />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {!isMobile ? (
          <aside className="flex w-56 shrink-0 flex-col border-r border-border md:w-60">
            {sessionList}
          </aside>
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Transcript
            messages={messages}
            pendingGate={pendingGate}
            gateBusy={gateBusy}
            onResumeGate={onResumeGate}
            workspaceId={workspaceId}
            rootPath={rootPath}
            onOpenAgent={openAgent}
          />
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

      <AgentFocusDrawer
        open={Boolean(focusAgentId)}
        onOpenChange={(open) => {
          if (!open) onFocusAgentIdChange?.(null);
        }}
        unitId={focusAgentId}
        role={focusMeta.role ?? focusedUnit?.role}
        task={focusMeta.task ?? focusedUnit?.task}
        unit={focusedUnit}
        fallbackDetail={focusMeta.detail}
      />
    </div>
  );
}
