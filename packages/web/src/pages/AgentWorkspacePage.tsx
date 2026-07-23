/**
 * Agent Workspace page — default home for a workspace (`/w/:id`).
 * Loads workspace + Pi agent sessions; wires the 3-pane shell.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { AgentWorkspaceShell } from "../agent-workspace/AgentWorkspaceShell";
import { useSessionAgent } from "../agent-workspace/hooks/useSessionAgent";
import {
  createAgentSession,
  deleteAgentSession,
  getProvider,
  getWorkspace,
  listAgentSessions,
  listRuns,
  type ModelProfilePublic,
  type PiSessionSummary,
  type StoredRunRecord,
  type WorkspaceConfig,
} from "../api";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceShell } from "../components/WorkspaceShell";
import { useI18n } from "../i18n";

export function AgentWorkspacePage() {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;

  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [sessions, setSessions] = useState<PiSessionSummary[]>([]);
  // Only set after boot validates the id exists (or creates one). Starting
  // from the URL would race getAgentSession and 404 on stale sessionIds.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<StoredRunRecord[]>([]);
  const [bootError, setBootError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelProfilePublic[]>([]);
  const [defaultModelProfileId, setDefaultModelProfileId] = useState<string | undefined>();
  const [wikiModelProfileId, setWikiModelProfileId] = useState("");

  const rootPath = workspace?.rootPath ?? rootPathHint;

  const agent = useSessionAgent({
    workspaceId: id,
    sessionId: activeSessionId,
    rootPath,
  });

  const syncSessionIdInUrl = useCallback(
    (sessionId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("sessionId", sessionId);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Deep-link expand: ?unit=planner | leaf-… (timeline expand, not a drawer).
  const unitFromUrl = searchParams.get("unit");
  useEffect(() => {
    if (!activeSessionId) return;
    if (unitFromUrl && unitFromUrl !== agent.expandedUnitId) {
      agent.setExpandedUnitId(unitFromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-way seed
  }, [activeSessionId, unitFromUrl]);

  const handleExpandedUnitIdChange = useCallback(
    (unitId: string | null) => {
      agent.setExpandedUnitId(unitId);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          // Drop legacy focusAgent if present
          next.delete("focusAgent");
          if (unitId) next.set("unit", unitId);
          else next.delete("unit");
          return next;
        },
        { replace: true },
      );
    },
    [agent, setSearchParams],
  );

  const boot = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setBootError(null);
    try {
      const wsRes = await getWorkspace(id, rootPathHint);
      const ws = wsRes.workspace;
      setWorkspace(ws);
      const root = ws.rootPath ?? rootPathHint;

      const [sessRes, runsRes, providerRes] = await Promise.all([
        listAgentSessions(id, root),
        listRuns(id, root).catch(() => ({ runs: [] as StoredRunRecord[] })),
        getProvider().catch(() => null),
      ]);

      const catalog = providerRes?.provider.models ?? [];
      setModels(catalog);
      setDefaultModelProfileId(providerRes?.provider.defaultModelProfileId);
      // Prefer workspace selection, then catalog default, then first model.
      const initialProfile =
        ws.model?.profileId || providerRes?.provider.defaultModelProfileId || catalog[0]?.id || "";
      setWikiModelProfileId(initialProfile);

      let list = sessRes.sessions ?? [];
      let sessionId = searchParams.get("sessionId") ?? list[0]?.id ?? null;

      if (sessionId && !list.some((s) => s.id === sessionId)) {
        // URL id missing on disk — fall through to create/latest.
        sessionId = list[0]?.id ?? null;
      }

      if (!sessionId) {
        const created = await createAgentSession(id, {}, root);
        list = [
          {
            id: created.session.id,
            name: `${created.session.id}.json`,
            title: created.session.title,
            updatedAt: created.session.createdAt,
            placeholder: true,
          },
          ...list,
        ];
        sessionId = created.session.id;
      }

      setSessions(list);
      setActiveSessionId(sessionId);
      setRecentRuns(runsRes.runs ?? []);
      if (sessionId) {
        syncSessionIdInUrl(sessionId);
      }
    } catch (err) {
      setBootError(err);
    } finally {
      setLoading(false);
    }
  }, [id, rootPathHint, searchParams, syncSessionIdInUrl]);

  useEffect(() => {
    void boot();
    // Boot once per workspace id / rootPath hint (not on every sessionId write).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot boot
  }, [id, rootPathHint]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
      syncSessionIdInUrl(sessionId);
    },
    [syncSessionIdInUrl],
  );

  const handleCreateSession = useCallback(async () => {
    if (!id || creating) return;
    setCreating(true);
    setBootError(null);
    try {
      const created = await createAgentSession(
        id,
        { title: `Wiki Agent · ${workspace?.name ?? id}` },
        rootPath,
      );
      const summary: PiSessionSummary = {
        id: created.session.id,
        name: `${created.session.id}.json`,
        title: created.session.title,
        updatedAt: created.session.createdAt,
        placeholder: true,
      };
      setSessions((prev) => [summary, ...prev]);
      setActiveSessionId(created.session.id);
      syncSessionIdInUrl(created.session.id);
    } catch (err) {
      setBootError(err);
    } finally {
      setCreating(false);
    }
  }, [id, creating, workspace?.name, rootPath, syncSessionIdInUrl]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!id || deletingId) return;
      setDeletingId(sessionId);
      setBootError(null);
      try {
        await deleteAgentSession(id, sessionId, rootPath);
        let nextList = sessions.filter((s) => s.id !== sessionId);
        let nextActive = activeSessionId === sessionId ? null : activeSessionId;

        if (nextList.length === 0) {
          const created = await createAgentSession(id, {}, rootPath);
          nextList = [
            {
              id: created.session.id,
              name: `${created.session.id}.json`,
              title: created.session.title,
              updatedAt: created.session.createdAt,
              placeholder: true,
            },
          ];
          nextActive = created.session.id;
        } else if (!nextActive || !nextList.some((s) => s.id === nextActive)) {
          nextActive = nextList[0]!.id;
        }

        setSessions(nextList);
        setActiveSessionId(nextActive);
        if (nextActive) syncSessionIdInUrl(nextActive);
      } catch (err) {
        setBootError(err);
      } finally {
        setDeletingId(null);
      }
    },
    [id, deletingId, rootPath, sessions, activeSessionId, syncSessionIdInUrl],
  );

  // Refresh session list titles after first prompt auto-titles the active session.
  const activeListTitle = sessions.find((s) => s.id === activeSessionId)?.title ?? "";
  const activeTitleLooksDefault =
    !activeListTitle ||
    activeListTitle.startsWith("Wiki Agent · ") ||
    activeListTitle === "New session";
  const userMessageCount = agent.messages.filter((m) => m.role === "user").length;
  useEffect(() => {
    if (!id || !activeSessionId || !rootPath) return;
    if (userMessageCount < 1 || !activeTitleLooksDefault) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void listAgentSessions(id, rootPath)
        .then((res) => {
          if (cancelled) return;
          setSessions(res.sessions ?? []);
        })
        .catch(() => {
          // best-effort title refresh
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id, activeSessionId, rootPath, userMessageCount, activeTitleLooksDefault]);

  return (
    <WorkspaceShell
      workspaceId={id}
      workspaceName={workspace?.name}
      title={t.agentWorkspace.title}
      error={bootError}
      onDismissError={() => setBootError(null)}
      immersive
      testId="agent-workspace-page"
    >
      {loading || !workspace ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <LoadingState label={t.agentWorkspace.loading} />
        </div>
      ) : (
        <AgentWorkspaceShell
          workspaceId={id}
          workspace={workspace}
          rootPath={rootPath}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onCreateSession={() => void handleCreateSession()}
          onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
          creatingSession={creating}
          deletingSessionId={deletingId}
          messages={agent.messages}
          input={agent.input}
          onInputChange={agent.setInput}
          onSend={() => void agent.send()}
          onStartWikiRun={() =>
            void agent.startWikiRun({
              modelProfileId: wikiModelProfileId || undefined,
            })
          }
          onAbort={() => void agent.abort()}
          agentStatus={agent.status}
          agentError={agent.error}
          onDismissAgentError={agent.clearError}
          plan={agent.plan}
          linkedRunId={agent.linkedRunId}
          phase={agent.phase}
          pendingGate={agent.pendingGate}
          gateBusy={agent.gateBusy}
          onResumeGate={(input) => void agent.resumeGate(input)}
          recentRuns={recentRuns}
          models={models}
          wikiModelProfileId={wikiModelProfileId}
          onWikiModelProfileIdChange={setWikiModelProfileId}
          defaultModelProfileId={workspace.model?.profileId ?? defaultModelProfileId}
          units={agent.units}
          expandedUnitId={agent.expandedUnitId}
          onExpandedUnitIdChange={handleExpandedUnitIdChange}
        />
      )}
    </WorkspaceShell>
  );
}
