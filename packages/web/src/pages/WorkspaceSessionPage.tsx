/**
 * Session page shell: boot list, header actions, chat panel.
 * Chat logic lives in features/session/* (Phase 5).
 */

import { useParams, useSearchParams } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceShell } from "../components/WorkspaceShell";
import { SessionChatPanel } from "../features/session/SessionChatPanel";
import { SessionHeader } from "../features/session/SessionHeader";
import { useSessionList } from "../features/session/useSessionList";
import { useI18n } from "../i18n";

export function WorkspaceSessionPage() {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const kickoff = searchParams.get("kickoff") === "1";

  const list = useSessionList({ workspaceId: id, rootPathHint });

  return (
    <WorkspaceShell
      workspaceId={id}
      workspaceName={list.workspace?.name}
      breadcrumbLabel={t.session.breadcrumb}
      title={t.session.title}
      actions={
        <SessionHeader
          workspaceId={id}
          rootPathHint={rootPathHint}
          sessionMeta={list.sessionMeta}
          sessionList={list.sessionList}
          sessionSelectItems={list.sessionSelectItems}
          loading={list.loading}
          switching={list.switching}
          creating={list.creating}
          deleting={list.deleting}
          onSwitchSession={(sessionId) => void list.handleSwitchSession(sessionId)}
          onNewSession={() => void list.handleNewSession()}
          onRequestDelete={list.requestDeleteSession}
        />
      }
      error={list.bootError}
      onDismissError={() => list.setBootError(null)}
      compact
      testId="session-chat-page"
    >
      <ConfirmDialog
        open={list.deleteDialogOpen}
        onOpenChange={list.setDeleteDialogOpen}
        title={t.session.deleteConfirmTitle}
        description={t.session.deleteConfirmBody}
        confirmLabel={
          list.deleting
            ? t.session.deletingSession
            : t.session.deleteConfirmSubmit
        }
        cancelLabel={t.common.cancel}
        onConfirm={() => void list.handleDeleteSession()}
        confirmDisabled={list.deleting}
        data-testid="session-delete-dialog"
        confirmTestId="session-delete-confirm"
      />

      {list.loading || !list.sessionMeta || !list.workspace ? (
        // Compact shell fills the viewport; center the skeleton like empty chat.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
          <LoadingState label={t.session.loading} />
        </div>
      ) : (
        <SessionChatPanel
          key={`${list.sessionMeta.id}:${list.panelEpoch}`}
          workspaceId={id}
          workspace={list.workspace}
          session={list.sessionMeta}
          rootPathHint={rootPathHint}
          kickoff={kickoff}
          onSessionMetaChange={list.handleSessionMetaChange}
          onNewSession={() => void list.handleNewSession()}
          onResetSession={() => void list.handleResetSession()}
          onDeleteSession={list.requestDeleteSession}
        />
      )}
    </WorkspaceShell>
  );
}
