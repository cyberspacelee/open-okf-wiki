/**
 * Left-pane session list for Agent Workspace (Pi sessions).
 * Supports delete (pi-web SessionListDialog) and displays auto titles.
 */

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { PiSessionSummary } from "../../api";
import { formatMessage, useI18n } from "../../i18n";

export type SessionListProps = {
  sessions: PiSessionSummary[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onDelete?: (sessionId: string) => void | Promise<void>;
  creating?: boolean;
  deletingId?: string | null;
  className?: string;
};

function formatLabel(session: PiSessionSummary): string {
  const title = session.title?.trim();
  if (title) return title;
  return session.id.slice(0, 10);
}

function formatUpdated(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  creating = false,
  deletingId = null,
  className,
}: SessionListProps) {
  const { t } = useI18n();
  const [deleteTarget, setDeleteTarget] = useState<PiSessionSummary | null>(null);

  // Server should already dedupe; keep first-seen id so React keys stay unique
  // if a stale API ever returns both `{id}.json` and `{id}/` for one session.
  const uniqueSessions: PiSessionSummary[] = [];
  const seenIds = new Set<string>();
  for (const session of sessions) {
    if (seenIds.has(session.id)) continue;
    seenIds.add(session.id);
    uniqueSessions.push(session);
  }

  return (
    <div data-testid="agent-session-list" className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2.5 py-2">
        <span className="text-xs font-medium">{t.agentWorkspace.sessions}</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="agent-session-new"
          disabled={creating}
          onClick={() => onCreate()}
        >
          <PlusIcon data-icon="inline-start" />
          {creating ? t.agentWorkspace.creatingSession : t.agentWorkspace.newSession}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {uniqueSessions.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">{t.agentWorkspace.noSessions}</p>
        ) : (
          <ul className="flex flex-col gap-0.5 p-1.5">
            {uniqueSessions.map((session) => {
              const active = session.id === activeSessionId;
              const deleting = deletingId === session.id;
              return (
                <li key={session.id} className="group relative">
                  <button
                    type="button"
                    data-testid="agent-session-item"
                    data-session-id={session.id}
                    data-active={active ? "true" : "false"}
                    disabled={deleting}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md border px-2 py-1.5 pr-8 text-left",
                      active ? "border-border bg-muted" : "border-transparent hover:bg-muted/60",
                      deleting && "opacity-50",
                    )}
                    onClick={() => onSelect(session.id)}
                  >
                    <div className="truncate text-sm font-medium">{formatLabel(session)}</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">
                        {formatUpdated(session.updatedAt)}
                      </span>
                    </div>
                  </button>
                  {onDelete ? (
                    <button
                      type="button"
                      data-testid="agent-session-delete"
                      data-session-id={session.id}
                      title={t.agentWorkspace.deleteSession}
                      aria-label={t.agentWorkspace.deleteSession}
                      disabled={deleting}
                      className={cn(
                        "absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground",
                        "opacity-80 transition-opacity focus-visible:opacity-100",
                        "hover:bg-destructive/10 hover:text-destructive hover:opacity-100",
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(session);
                      }}
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t.agentWorkspace.deleteSession}
        description={
          deleteTarget
            ? formatMessage(t.agentWorkspace.deleteSessionConfirm, {
                title: formatLabel(deleteTarget),
              })
            : undefined
        }
        confirmLabel={deletingId ? t.agentWorkspace.deletingSession : t.common.delete}
        cancelLabel={t.common.cancel}
        destructive
        confirmDisabled={deletingId != null}
        data-testid="agent-session-delete-dialog"
        confirmTestId="agent-session-delete-confirm"
        onConfirm={async () => {
          if (!deleteTarget || !onDelete) return;
          const id = deleteTarget.id;
          setDeleteTarget(null);
          await onDelete(id);
        }}
      />
    </div>
  );
}
