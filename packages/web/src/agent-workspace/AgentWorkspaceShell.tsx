/**
 * Agent Workspace 3-pane shell (ADR 0030 / 0031 WP6).
 *
 * left: session list · center: transcript + composer · right: context panels
 * Produce trail = produceUnits cards on the transcript (SSE/cold okf.produce_progress).
 */

import { LayoutListIcon, PanelRightIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type {
  ModelProfilePublic,
  PiSessionSummary,
  StoredRunRecord,
  WikiRunPlan,
  WorkspaceConfig,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { useI18n } from "../i18n";
import { Composer } from "./composer/Composer";
import type { ProduceUnit } from "./hooks/project/produce";
import type {
  AgentMessage,
  AgentStatus,
  PendingGate,
  ResumeGateInput,
} from "./hooks/useSessionAgent";
import { ContextPanels } from "./panels/ContextPanels";
import { SessionList } from "./session-list/SessionList";
import { Transcript } from "./transcript/Transcript";

export type AgentWorkspaceShellProps = {
  workspaceId: string;
  workspace: WorkspaceConfig | null;
  rootPath?: string;
  sessions: PiSessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
  creatingSession?: boolean;
  deletingSessionId?: string | null;
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
  pendingGate?: PendingGate | null;
  gateBusy?: boolean;
  onResumeGate?: (input: ResumeGateInput) => void | Promise<void>;
  recentRuns?: StoredRunRecord[];
  produceUnits?: ProduceUnit[];
  className?: string;
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
  onDeleteSession,
  creatingSession = false,
  deletingSessionId = null,
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
  produceUnits = [],
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
      onDelete={onDeleteSession}
      creating={creatingSession}
      deletingId={deletingSessionId}
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
      produceUnits={produceUnits}
    />
  );

  return (
    <div
      data-testid="agent-workspace-shell"
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden bg-background", className)}
    >
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
          <aside className="flex w-52 shrink-0 flex-col border-r border-border md:w-56">
            {sessionList}
          </aside>
        ) : null}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Transcript
            messages={messages}
            pendingGate={pendingGate}
            gateBusy={gateBusy}
            onResumeGate={onResumeGate}
            phase={phase}
            onStartWikiRun={onStartWikiRun}
            produceUnits={produceUnits}
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
          <aside className="flex w-60 shrink-0 flex-col border-l border-border lg:w-64">
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
