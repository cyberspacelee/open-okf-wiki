/**
 * Left-pane session list for Agent Workspace (Pi sessions).
 */

import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PiSessionSummary } from "../../../api";
import { useI18n } from "../../../i18n";

export type SessionListProps = {
  sessions: PiSessionSummary[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  creating?: boolean;
  className?: string;
};

function formatLabel(session: PiSessionSummary): string {
  const name = session.name?.trim();
  if (name && name !== `${session.id}.json`) {
    return name.replace(/\.jsonl?$/i, "");
  }
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
  creating = false,
  className,
}: SessionListProps) {
  const { t } = useI18n();

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
    <div
      data-testid="agent-session-list"
      className={cn("flex h-full min-h-0 flex-col", className)}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2.5 py-2">
        <span className="text-xs font-semibold tracking-wide uppercase">
          {t.agentWorkspace.sessions}
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="agent-session-new"
          disabled={creating}
          onClick={() => onCreate()}
        >
          <PlusIcon data-icon="inline-start" />
          {creating
            ? t.agentWorkspace.creatingSession
            : t.agentWorkspace.newSession}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {uniqueSessions.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {t.agentWorkspace.noSessions}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5 p-1.5">
            {uniqueSessions.map((session) => {
              const active = session.id === activeSessionId;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    data-testid="agent-session-item"
                    data-session-id={session.id}
                    data-active={active ? "true" : "false"}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left",
                      active
                        ? "border-border bg-muted"
                        : "border-transparent hover:bg-muted/60",
                    )}
                    onClick={() => onSelect(session.id)}
                  >
                    <div className="truncate text-sm font-medium">
                      {formatLabel(session)}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {session.placeholder ? (
                        <Badge
                          variant="outline"
                          className="h-4 px-1.5 text-[10px]"
                        >
                          stub
                        </Badge>
                      ) : null}
                      <span className="text-[10px] text-muted-foreground">
                        {formatUpdated(session.updatedAt)}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
