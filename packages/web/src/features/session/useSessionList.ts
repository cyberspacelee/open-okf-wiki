/**
 * Session list lifecycle: boot, switch, create, delete, reset.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  createSession,
  deleteSession,
  getOrCreateSession,
  getSession,
  getWorkspace,
  listSessions,
  resetSession,
  type OperatorSessionDto,
  type OperatorSessionSummary,
  type WorkspaceConfig,
} from "../../api";
import {
  formatSessionLabel,
  summaryFromSession,
  upsertSessionSummary,
} from "./session-extract";

export type UseSessionListArgs = {
  workspaceId: string;
  rootPathHint?: string;
};

export function useSessionList({
  workspaceId,
  rootPathHint,
}: UseSessionListArgs) {
  const [searchParams, setSearchParams] = useSearchParams();

  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [sessionMeta, setSessionMeta] = useState<OperatorSessionDto | null>(
    null,
  );
  const [sessionList, setSessionList] = useState<OperatorSessionSummary[]>([]);
  const [bootError, setBootError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  /** Bump to remount chat panel after reset/delete without id change races. */
  const [panelEpoch, setPanelEpoch] = useState(0);

  const rootPath = workspace?.rootPath ?? rootPathHint;

  const syncSessionIdInUrl = useCallback(
    (sessionId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("sessionId", sessionId);
          // One-shot kickoff should not re-fire after navigation.
          next.delete("kickoff");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Boot workspace + session (url id or latest) + history list.
  // Intentionally does not re-run when we write sessionId into the URL after boot.
  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    let cancelled = false;
    const bootSessionId = searchParams.get("sessionId") ?? undefined;
    void (async () => {
      setLoading(true);
      setBootError(null);
      try {
        const ws = await getWorkspace(workspaceId, rootPathHint);
        if (cancelled) {
          return;
        }
        setWorkspace(ws.workspace);
        const root = ws.workspace.rootPath ?? rootPathHint;
        const listRes = await listSessions(workspaceId, root);
        if (cancelled) {
          return;
        }
        let session: OperatorSessionDto;
        if (bootSessionId) {
          try {
            const res = await getSession(workspaceId, bootSessionId, root);
            session = res.session;
          } catch {
            // Missing id → fall back to latest / create.
            const res = await getOrCreateSession(workspaceId, root);
            session = res.session;
          }
        } else {
          const res = await getOrCreateSession(workspaceId, root);
          session = res.session;
        }
        if (cancelled) {
          return;
        }
        setSessionMeta(session);
        setSessionList(
          upsertSessionSummary(listRes.sessions, summaryFromSession(session)),
        );
        // Ensure URL always carries sessionId for refresh restore.
        if (bootSessionId !== session.id) {
          syncSessionIdInUrl(session.id);
        }
      } catch (err) {
        if (!cancelled) {
          setBootError(err);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once per workspace; switcher owns later loads
  }, [workspaceId, rootPathHint]);

  const handleSessionMetaChange = useCallback((session: OperatorSessionDto) => {
    setSessionMeta(session);
    setSessionList((prev) =>
      upsertSessionSummary(prev, summaryFromSession(session)),
    );
  }, []);

  const handleSwitchSession = useCallback(
    async (sessionId: string) => {
      if (
        !workspaceId ||
        !sessionId ||
        sessionId === sessionMeta?.id ||
        switching
      ) {
        return;
      }
      setSwitching(true);
      setBootError(null);
      try {
        const { session } = await getSession(workspaceId, sessionId, rootPath);
        setSessionMeta(session);
        setSessionList((prev) =>
          upsertSessionSummary(prev, summaryFromSession(session)),
        );
        setPanelEpoch((n) => n + 1);
        syncSessionIdInUrl(session.id);
      } catch (err) {
        setBootError(err);
      } finally {
        setSwitching(false);
      }
    },
    [workspaceId, rootPath, sessionMeta?.id, switching, syncSessionIdInUrl],
  );

  const handleNewSession = useCallback(async () => {
    if (!workspaceId || creating) {
      return;
    }
    setCreating(true);
    setBootError(null);
    try {
      const { session } = await createSession(workspaceId, undefined, rootPath);
      setSessionMeta(session);
      setSessionList((prev) =>
        upsertSessionSummary(prev, summaryFromSession(session)),
      );
      setPanelEpoch((n) => n + 1);
      syncSessionIdInUrl(session.id);
    } catch (err) {
      setBootError(err);
    } finally {
      setCreating(false);
    }
  }, [workspaceId, creating, rootPath, syncSessionIdInUrl]);

  const requestDeleteSession = useCallback(() => {
    if (!workspaceId || !sessionMeta || deleting) {
      return;
    }
    setDeleteDialogOpen(true);
  }, [workspaceId, sessionMeta, deleting]);

  const handleDeleteSession = useCallback(async () => {
    if (!workspaceId || !sessionMeta || deleting) {
      return;
    }
    setDeleting(true);
    setBootError(null);
    try {
      const deletedId = sessionMeta.id;
      await deleteSession(workspaceId, deletedId, rootPath);
      const remaining = sessionList.filter((s) => s.id !== deletedId);
      setSessionList(remaining);
      let next: OperatorSessionDto;
      if (remaining[0]) {
        const res = await getSession(workspaceId, remaining[0].id, rootPath);
        next = res.session;
      } else {
        const res = await createSession(workspaceId, undefined, rootPath);
        next = res.session;
        setSessionList([summaryFromSession(next)]);
      }
      setSessionMeta(next);
      setPanelEpoch((n) => n + 1);
      syncSessionIdInUrl(next.id);
    } catch (err) {
      setBootError(err);
    } finally {
      setDeleting(false);
    }
  }, [
    workspaceId,
    sessionMeta,
    deleting,
    rootPath,
    sessionList,
    syncSessionIdInUrl,
  ]);

  const handleResetSession = useCallback(async () => {
    if (!workspaceId || !sessionMeta) {
      return;
    }
    setBootError(null);
    try {
      const { session } = await resetSession(
        workspaceId,
        sessionMeta.id,
        rootPath,
      );
      setSessionMeta(session);
      setSessionList((prev) =>
        upsertSessionSummary(prev, summaryFromSession(session)),
      );
      setPanelEpoch((n) => n + 1);
    } catch (err) {
      setBootError(err);
    }
  }, [workspaceId, sessionMeta, rootPath]);

  const sessionSelectItems = useMemo(
    () =>
      sessionList.map((s) => ({
        value: s.id,
        label: formatSessionLabel(s),
      })),
    [sessionList],
  );

  return {
    workspace,
    sessionMeta,
    sessionList,
    sessionSelectItems,
    bootError,
    setBootError,
    loading,
    switching,
    creating,
    deleting,
    deleteDialogOpen,
    setDeleteDialogOpen,
    panelEpoch,
    handleSessionMetaChange,
    handleSwitchSession,
    handleNewSession,
    requestDeleteSession,
    handleDeleteSession,
    handleResetSession,
  };
}
