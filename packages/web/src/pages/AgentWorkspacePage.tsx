/**
 * Agent Workspace page — default home for a workspace (`/w/:id`).
 * Loads workspace + Pi agent sessions; wires the 3-pane shell.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  createAgentSession,
  getProvider,
  getWorkspace,
  listAgentSessions,
  listRuns,
  type ModelProfilePublic,
  type PiSessionSummary,
  type StoredRunRecord,
  type WorkspaceConfig,
} from "../api";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { ErrorBanner } from "../components/ErrorBanner";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import { AgentWorkspaceShell } from "../agent-workspace/AgentWorkspaceShell";
import { useSessionAgent } from "../agent-workspace/hooks/useSessionAgent";
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
  const [models, setModels] = useState<ModelProfilePublic[]>([]);
  const [defaultModelProfileId, setDefaultModelProfileId] = useState<
    string | undefined
  >();
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
        ws.model?.profileId ||
        providerRes?.provider.defaultModelProfileId ||
        catalog[0]?.id ||
        "";
      setWikiModelProfileId(initialProfile);

      let list = sessRes.sessions ?? [];
      let sessionId =
        searchParams.get("sessionId") ??
        list[0]?.id ??
        null;

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

  return (
    <Layout>
      <div
        data-testid="agent-workspace-page"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden"
      >
        <div className="flex shrink-0 flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            <Link to="/workspaces" className="hover:underline">
              {t.nav.workspaces}
            </Link>
            <span className="mx-1.5">/</span>
            <span>{workspace?.name ?? t.agentWorkspace.title}</span>
          </p>
          {id ? <WorkspaceSubnav workspaceId={id} /> : null}
        </div>

        {bootError ? (
          <ErrorBanner error={bootError} onDismiss={() => setBootError(null)} />
        ) : null}

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
            creatingSession={creating}
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
            defaultModelProfileId={
              workspace.model?.profileId ?? defaultModelProfileId
            }
          />
        )}
      </div>
    </Layout>
  );
}
