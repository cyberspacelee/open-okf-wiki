/**
 * Session page actions: picker, new/delete, status badges, link to Jobs.
 */

import { Link } from "react-router-dom";
import type {
  OperatorSessionDto,
  OperatorSessionSummary,
} from "../../api";
import { useI18n } from "../../i18n";
import { workspaceHref } from "../../lib/workspace-path";
import { formatSessionLabel } from "./session-extract";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SessionHeaderProps = {
  workspaceId: string;
  rootPathHint?: string;
  sessionMeta: OperatorSessionDto | null;
  sessionList: OperatorSessionSummary[];
  sessionSelectItems: Array<{ value: string; label: string }>;
  loading: boolean;
  switching: boolean;
  creating: boolean;
  deleting: boolean;
  onSwitchSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRequestDelete: () => void;
};

export function SessionHeader({
  workspaceId,
  rootPathHint,
  sessionMeta,
  sessionList,
  sessionSelectItems,
  loading,
  switching,
  creating,
  deleting,
  onSwitchSession,
  onNewSession,
  onRequestDelete,
}: SessionHeaderProps) {
  const { t } = useI18n();

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="session-list"
      >
        {sessionMeta && sessionList.length > 0 ? (
          <Select
            value={sessionMeta.id}
            onValueChange={(value) => {
              if (typeof value === "string" && value) {
                onSwitchSession(value);
              }
            }}
            items={sessionSelectItems}
            disabled={switching || creating || loading}
          >
            <SelectTrigger
              size="sm"
              className="min-w-[12rem] max-w-[18rem]"
              data-testid="session-select"
              aria-label={t.session.switchSession}
            >
              <SelectValue placeholder={t.session.sessions} />
            </SelectTrigger>
            <SelectContent>
              {sessionList.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {formatSessionLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onNewSession}
          disabled={creating || loading || switching || deleting}
          data-testid="session-new"
        >
          {creating ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PlusIcon data-icon="inline-start" aria-hidden />
          )}
          {creating ? t.session.creatingSession : t.session.newSession}
        </Button>
        {sessionMeta ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRequestDelete}
            disabled={deleting || loading || switching || creating}
            data-testid="session-delete"
            title={t.session.deleteSession}
          >
            {deleting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Trash2Icon data-icon="inline-start" aria-hidden />
            )}
            <span className="sr-only sm:not-sr-only">
              {deleting ? t.session.deletingSession : t.session.deleteSession}
            </span>
          </Button>
        ) : null}
      </div>
      {sessionMeta ? (
        <Badge
          variant="secondary"
          data-testid="session-status"
          data-status={sessionMeta.status}
        >
          {(t.session.lifecycle as Record<string, string>)[sessionMeta.status] ??
            sessionMeta.status}
        </Badge>
      ) : null}
      {sessionMeta?.workflow?.linkedRunId ? (
        <Badge variant="outline" data-testid="session-linked-run">
          {t.session.runPrefix} {sessionMeta.workflow.linkedRunId.slice(0, 8)}…
        </Badge>
      ) : null}
      <Link
        to={workspaceHref(workspaceId, "/run", rootPathHint)}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        data-testid="session-open-runs"
      >
        {t.session.openRuns}
      </Link>
    </>
  );
}
