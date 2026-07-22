/**
 * Session chat panel: wires useSessionChat → timeline + composer.
 */

import type { OperatorSessionDto, WorkspaceConfig } from "../../api";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SessionComposer } from "./SessionComposer";
import { SessionTimeline } from "./SessionTimeline";
import { useSessionChat } from "./useSessionChat";

export type SessionChatPanelProps = {
  workspaceId: string;
  workspace: WorkspaceConfig;
  session: OperatorSessionDto;
  rootPathHint?: string;
  kickoff?: boolean;
  onSessionMetaChange?: (session: OperatorSessionDto) => void;
  onNewSession?: () => void;
  onResetSession?: () => void;
  onDeleteSession?: () => void;
};

export function SessionChatPanel({
  workspaceId,
  workspace,
  session,
  rootPathHint,
  kickoff,
  onSessionMetaChange,
  onNewSession,
  onResetSession,
  onDeleteSession,
}: SessionChatPanelProps) {
  const chat = useSessionChat({
    workspaceId,
    workspace,
    session,
    rootPathHint,
    kickoff,
    onSessionMetaChange,
    onNewSession,
    onResetSession,
    onDeleteSession,
  });

  return (
    <>
      <ErrorBanner error={chat.error} onDismiss={() => chat.clearError()} />
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
        data-testid="session-chat-shell"
      >
        {/*
          Immersive chat: no top status bar. Stop lives on PromptInputSubmit;
          one Badge near the composer tools. Linked-run id stays in page actions.
        */}
        <SessionTimeline
          messages={chat.messages}
          session={session}
          sessionWrittenPaths={chat.sessionWrittenPaths}
          latestAssistantId={chat.latestAssistantId}
          suppressDecisions={chat.suppressDecisions}
          onChoice={chat.handleChoice}
        />
        <SessionComposer
          session={session}
          input={chat.input}
          onInputChange={chat.setInput}
          status={chat.status}
          linkedRunId={chat.linkedRunId}
          isBusy={chat.isBusy}
          choiceOnly={chat.choiceOnly}
          inputOnly={chat.inputOnly}
          planReviseMode={chat.planReviseMode}
          canType={chat.canType}
          hasSources={chat.hasSources}
          composerDisabled={chat.composerDisabled}
          pending={chat.pending}
          suggestionChips={chat.suggestionChips}
          slashMenuOpen={chat.slashMenuOpen}
          slashCommands={chat.slashCommands}
          slashHighlight={chat.slashHighlight}
          onSlashHighlight={chat.setSlashHighlight}
          onSubmit={chat.handleSubmit}
          onKeyDown={chat.handleComposerKeyDown}
          onStop={chat.handleStop}
          onOpenSlash={chat.openSlashMenu}
          onApplyCommand={chat.applyCommandDef}
          onSuggestionClick={chat.onSuggestionClick}
        />
      </div>
    </>
  );
}
