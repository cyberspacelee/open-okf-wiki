import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  approvePlan,
  approvePublication,
  cancelRun,
  createRun,
  denyPlan,
  denyPublication,
  getWorkspace,
  listRuns,
  retryRun,
  revisePlan,
  runEventsUrl,
  type RunSseEvent,
  type StoredRunRecord,
  type WorkspaceConfig,
} from "../api";
import { PlanConfirmCard } from "../components/session/PlanConfirmCard";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import { useI18n } from "../i18n";
import { workspaceHref } from "../lib/workspace-path";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function WorkspaceRunPage() {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [runs, setRuns] = useState<StoredRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Simple job event lines (not the conversational Session UI). */
  const [eventLog, setEventLog] = useState<string[]>([]);
  /** When true, fall back to poll only (SSE failed or unavailable). */
  const [usePollFallback, setUsePollFallback] = useState(false);
  const sseRef = useRef<EventSource | null>(null);
  /** One SSE replay per runId+terminal status (plan / publish gates). */
  const sseReplayKeysRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!id) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await getWorkspace(id, rootPathHint);
      setWorkspace(data.workspace);
      const runData = await listRuns(id, data.workspace.rootPath ?? rootPathHint);
      setRuns(runData.runs);
    } catch (err) {
      setError(err);
      setWorkspace(null);
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [id, rootPathHint]);

  useEffect(() => {
    void load();
  }, [load]);

  const latestStatus = runs[0]?.status;
  const latestRunId = runs[0]?.runId;

  const applyRunPatch = useCallback((runId: string, patch: Partial<StoredRunRecord>) => {
    setRuns((prev) =>
      prev.map((r) => (r.runId === runId ? { ...r, ...patch, updatedAt: new Date().toISOString() } : r)),
    );
  }, []);

  const appendEventLog = useCallback((event: RunSseEvent) => {
    const line =
      event.message ||
      event.text ||
      (event.toolName
        ? `${event.toolName}${event.toolState ? ` (${event.toolState})` : ""}`
        : event.type);
    if (!line) {
      return;
    }
    setEventLog((prev) => {
      const next = [...prev, `[${event.type}] ${line}`];
      return next.length > 80 ? next.slice(-80) : next;
    });
  }, []);

  // Prefer EventSource while running. For HITL gates, replay the ring buffer once
  // per runId+status so late clients still see text/tools after a fast fixture finish.
  useEffect(() => {
    if (!id || !workspace || !latestRunId || !latestStatus) {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      return;
    }
    const replayKey = `${latestRunId}:${latestStatus}`;
    const needsTerminalReplay =
      (latestStatus === "awaiting_plan" || latestStatus === "awaiting_publication") &&
      !sseReplayKeysRef.current.has(replayKey);
    const shouldAttach = latestStatus === "running" || needsTerminalReplay;
    if (!shouldAttach) {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      return;
    }
    if (needsTerminalReplay) {
      sseReplayKeysRef.current.add(replayKey);
      // Rebuild timeline from the full ring buffer for this gate (includes write-phase tools).
      setEventLog([]);
    }

    const root = workspace.rootPath ?? rootPathHint;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const startPoll = () => {
      if (pollTimer || cancelled) {
        return;
      }
      pollTimer = setInterval(() => {
        void (async () => {
          try {
            const runData = await listRuns(id, root);
            if (!cancelled) {
              setRuns(runData.runs);
            }
          } catch {
            // Keep last known state; full reload can surface errors.
          }
        })();
      }, 750);
    };

    // Poll only while still running; terminal HITL states rely on SSE replay.
    if (
      (usePollFallback || typeof EventSource === "undefined") &&
      latestStatus === "running"
    ) {
      startPoll();
      return () => {
        cancelled = true;
        if (pollTimer) {
          clearInterval(pollTimer);
        }
      };
    }
    if (usePollFallback && latestStatus !== "running") {
      return;
    }

    const url = runEventsUrl(id, latestRunId, root);
    const es = new EventSource(url);
    sseRef.current = es;

    es.onmessage = (msg) => {
      let event: RunSseEvent;
      try {
        event = JSON.parse(msg.data) as RunSseEvent;
      } catch {
        return;
      }

      if (cancelled && event.type !== "done") {
        // Ignore mid-stream events after teardown; still honor terminal refresh below.
        return;
      }

      appendEventLog(event);

      const terminal =
        event.type === "done" ||
        (event.status !== undefined && event.status !== "running");

      if (terminal) {
        // Full registry refresh so pages/summary are accurate. Do not gate on
        // `cancelled`: status change re-runs this effect and would otherwise
        // drop the refresh (race: patch status → cleanup → listRuns ignored).
        void listRuns(id, root)
          .then((runData) => {
            setRuns(runData.runs);
          })
          .catch(() => {
            // Best-effort partial status if list fails.
            if (event.status) {
              applyRunPatch(event.runId, {
                status: event.status,
                ...(event.type === "error" && event.message
                  ? { error: event.message }
                  : {}),
                ...(event.message && event.status !== "failed"
                  ? { summary: event.message }
                  : {}),
              });
            }
          });
        es.close();
        if (sseRef.current === es) {
          sseRef.current = null;
        }
        return;
      }

      if (event.status) {
        applyRunPatch(event.runId, {
          status: event.status,
          ...(event.type === "error" && event.message
            ? { error: event.message }
            : {}),
        });
      }
    };

    es.onerror = () => {
      // Fall back to polling; keep last known UI state.
      es.close();
      sseRef.current = null;
      if (!cancelled) {
        setUsePollFallback(true);
        appendEventLog({
          type: "log",
          runId: latestRunId,
          sequence: Date.now(),
          message: "SSE error — falling back to poll",
        });
        startPoll();
      }
    };

    return () => {
      cancelled = true;
      es.close();
      if (sseRef.current === es) {
        sseRef.current = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
      }
    };
  }, [
    id,
    workspace,
    rootPathHint,
    latestStatus,
    latestRunId,
    usePollFallback,
    appendEventLog,
    applyRunPatch,
  ]);

  const lastRun = runs[0];
  const canStart = Boolean(workspace && workspace.sources.length > 0);
  const awaitingPublication = lastRun?.status === "awaiting_publication";
  const awaitingPlan = lastRun?.status === "awaiting_plan";
  const canCancel =
    lastRun?.status === "running" ||
    lastRun?.status === "awaiting_plan" ||
    lastRun?.status === "awaiting_publication";
  // Retry starts a new run with frozen skill; only after the prior run has left
  // in-progress / HITL states (not while plan or publication gates are open).
  const canRetry =
    Boolean(lastRun) &&
    canStart &&
    lastRun!.status !== "running" &&
    lastRun!.status !== "awaiting_plan" &&
    lastRun!.status !== "awaiting_publication" &&
    lastRun!.status !== "needs_input";

  /** Session-first interactive generate (plan negotiation + HITL in chat). */
  function handleStartInSession() {
    if (!id) {
      return;
    }
    navigate(workspaceHref(id, "/session", rootPathHint, { kickoff: "1" }));
  }

  /** Headless job start (no Session chat UI). Kept for audit / e2e / auto paths. */
  async function handleStartHeadless() {
    if (!id) {
      return;
    }
    setStarting(true);
    setError(null);
    setEventLog([]);
    setUsePollFallback(false);
    sseReplayKeysRef.current = new Set();
    try {
      const result = await createRun(
        id,
        {},
        workspace?.rootPath ?? rootPathHint,
      );
      setRuns((prev) => [result.run, ...prev.filter((r) => r.runId !== result.run.runId)]);
      setEventLog([`[status] run created (${result.run.status})`]);
    } catch (err) {
      setError(err);
    } finally {
      setStarting(false);
    }
  }

  async function handleRetry() {
    if (!id || !lastRun) {
      return;
    }
    setRetrying(true);
    setError(null);
    setEventLog([]);
    setUsePollFallback(false);
    sseReplayKeysRef.current = new Set();
    try {
      const result = await retryRun(
        id,
        lastRun.runId,
        workspace?.rootPath ?? rootPathHint,
      );
      setRuns((prev) => [
        result.run,
        ...prev.filter((r) => r.runId !== result.run.runId),
      ]);
      setEventLog([
        `[status] manual retry from ${result.retriedFrom} (skill digest frozen)`,
      ]);
    } catch (err) {
      setError(err);
    } finally {
      setRetrying(false);
    }
  }

  async function handleCancel() {
    if (!id || !lastRun) {
      return;
    }
    setCancelling(true);
    setError(null);
    try {
      const result = await cancelRun(
        id,
        lastRun.runId,
        workspace?.rootPath ?? rootPathHint,
      );
      setRuns((prev) =>
        prev.map((r) => (r.runId === result.run.runId ? result.run : r)),
      );
      setEventLog((prev) => [...prev, "[status] cancel requested"]);
    } catch (err) {
      setError(err);
    } finally {
      setCancelling(false);
    }
  }

  async function handleApprovePlan() {
    if (!id || !lastRun) {
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const result = await approvePlan(
        id,
        lastRun.runId,
        {},
        workspace?.rootPath ?? rootPathHint,
      );
      setRuns((prev) =>
        prev.map((r) => (r.runId === result.run.runId ? result.run : r)),
      );
      setUsePollFallback(false);
      setEventLog((prev) => [
        ...prev,
        "[status] plan approved — write phase starting",
      ]);
    } catch (err) {
      setError(err);
    } finally {
      setPublishing(false);
    }
  }

  async function handleDenyPlan() {
    if (!id || !lastRun) {
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const result = await denyPlan(
        id,
        lastRun.runId,
        workspace?.rootPath ?? rootPathHint,
      );
      setRuns((prev) =>
        prev.map((r) => (r.runId === result.run.runId ? result.run : r)),
      );
    } catch (err) {
      setError(err);
    } finally {
      setPublishing(false);
    }
  }

  async function handleRevisePlan(feedback: string) {
    if (!id || !lastRun) {
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const result = await revisePlan(
        id,
        lastRun.runId,
        feedback,
        workspace?.rootPath ?? rootPathHint,
      );
      setRuns((prev) =>
        prev.map((r) => (r.runId === result.run.runId ? result.run : r)),
      );
      setUsePollFallback(false);
      setEventLog((prev) => [
        ...prev,
        "[status] plan revision requested — replan starting",
      ]);
    } catch (err) {
      setError(err);
    } finally {
      setPublishing(false);
    }
  }

  async function handleApprove() {
    if (!id || !lastRun) {
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const result = await approvePublication(
        id,
        lastRun.runId,
        workspace?.rootPath ?? rootPathHint,
      );
      setRuns((prev) =>
        prev.map((r) => (r.runId === result.run.runId ? result.run : r)),
      );
    } catch (err) {
      setError(err);
      // Refresh so a failed publish status (if persisted) is visible.
      try {
        const runData = await listRuns(id, workspace?.rootPath ?? rootPathHint);
        setRuns(runData.runs);
      } catch {
        // ignore secondary load errors
      }
    } finally {
      setPublishing(false);
    }
  }

  async function handleDeny() {
    if (!id || !lastRun) {
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const result = await denyPublication(
        id,
        lastRun.runId,
        workspace?.rootPath ?? rootPathHint,
      );
      setRuns((prev) =>
        prev.map((r) => (r.runId === result.run.runId ? result.run : r)),
      );
    } catch (err) {
      setError(err);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Layout>
      <div data-testid="run-page" className="flex flex-col gap-5">
        <header className="page-header">
          <p className="breadcrumb">
            <Link to="/workspaces">{t.runs.breadcrumbWorkspaces}</Link>
            <span aria-hidden="true"> / </span>
            <Link to={workspaceHref(id, "", rootPathHint)}>
              {workspace?.name ?? id}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>{t.runs.breadcrumb}</span>
          </p>
          <h1>{t.runs.title}</h1>
          <p>
            {t.runs.descriptionBefore}
            <Link to={workspaceHref(id, "/session", rootPathHint)}>
              {t.runs.descriptionLink}
            </Link>
            {t.runs.descriptionAfter}
          </p>
        </header>

        {id ? <WorkspaceSubnav workspaceId={id} /> : null}
        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <LoadingState label={t.runs.loading} />
        ) : workspace ? (
          <>
            <Card>
              <CardHeader className="row-between items-center">
                <CardTitle>{t.runs.generateTitle}</CardTitle>
                <div className="row-actions">
                  {canCancel ? (
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => void handleCancel()}
                      disabled={cancelling}
                      data-testid="run-cancel"
                    >
                      {cancelling ? t.runs.cancelling : t.runs.cancel}
                    </Button>
                  ) : null}
                  {canRetry ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void handleRetry()}
                      disabled={retrying || starting}
                      data-testid="run-retry"
                    >
                      {retrying ? t.runs.retrying : t.runs.retry}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleStartHeadless()}
                    disabled={starting || !canStart || canCancel}
                    data-testid="run-start"
                    title={t.runs.startHeadlessTitle}
                  >
                    {starting ? t.runs.starting : t.runs.startHeadless}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => handleStartInSession()}
                    disabled={!canStart || canCancel}
                    data-testid="run-start-session"
                  >
                    {t.runs.generateInSession}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {!canStart ? (
                  <p className="muted">
                    {t.runs.needSource}{" "}
                    <Link to={workspaceHref(id, "/sources", rootPathHint)}>
                      {t.runs.openSources}
                    </Link>
                  </p>
                ) : null}

                {lastRun ? (
                  <div className="run-last" data-testid="run-last">
                    <dl className="kv">
                      <div>
                        <dt>{t.runs.lastStatus}</dt>
                        <dd data-testid="run-last-status" data-status={lastRun.status}>
                          <RunStatusBadge status={lastRun.status} />
                        </dd>
                      </div>
                      {lastRun.error ? (
                        <div>
                          <dt>{t.runs.error}</dt>
                          <dd data-testid="run-last-error">{lastRun.error}</dd>
                        </div>
                      ) : null}
                      {lastRun.summary ? (
                        <div>
                          <dt>{t.runs.summary}</dt>
                          <dd data-testid="run-last-summary">{lastRun.summary}</dd>
                        </div>
                      ) : null}
                      {lastRun.pages && lastRun.pages.length > 0 ? (
                        <div>
                          <dt>{t.runs.pages}</dt>
                          <dd data-testid="run-last-pages" className="mono small">
                            <ul className="page-list" data-testid="run-pages-list">
                              {lastRun.pages.map((page) => (
                                <li key={page}>{page}</li>
                              ))}
                            </ul>
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>{t.runs.runId}</dt>
                        <dd className="mono muted">{lastRun.runId}</dd>
                      </div>
                      <div>
                        <dt>{t.runs.created}</dt>
                        <dd className="muted">{formatTime(lastRun.createdAt)}</dd>
                      </div>
                    </dl>

                    <div className="run-event-log mono small" data-testid="run-event-log">
                      <h3 className="panel-subtitle">{t.runs.jobEvents}</h3>
                      <p className="muted small mb-2">
                        {t.runs.jobEventsHintBefore}
                        <Link to={workspaceHref(id, "/session", rootPathHint)}>
                          {t.runs.jobEventsHintLink}
                        </Link>
                        {t.runs.jobEventsHintAfter}
                      </p>
                      {eventLog.length === 0 ? (
                        <p className="muted">{t.runs.noEvents}</p>
                      ) : (
                        <ul className="event-log" data-testid="run-event-list">
                          {eventLog.map((line, i) => (
                            <li key={`${i}-${line.slice(0, 24)}`}>{line}</li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {lastRun.skillDigest ? (
                      <p className="muted small mono" data-testid="run-skill-digest">
                        {t.runs.skillDigest}: {lastRun.skillDigest.slice(0, 16)}…
                      </p>
                    ) : null}

                    {awaitingPlan && lastRun.plan ? (
                      <PlanConfirmCard
                        plan={lastRun.plan}
                        busy={publishing}
                        onApprove={() => void handleApprovePlan()}
                        onDeny={() => void handleDenyPlan()}
                        onRevise={(feedback) => void handleRevisePlan(feedback)}
                      />
                    ) : null}

                    {awaitingPublication ? (
                      <div className="run-publish-actions" data-testid="run-publish-actions">
                        <p className="muted">
                          {t.runs.publishReadyBefore}
                          <code className="mono small">{workspace.publicationPath}</code>
                          {t.runs.publishReadyAfter}
                        </p>
                        <div className="row-actions">
                          <Button
                            type="button"
                            onClick={() => void handleApprove()}
                            disabled={publishing}
                            data-testid="run-approve"
                          >
                            {publishing ? t.runs.working : t.runs.approvePublish}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={() => void handleDeny()}
                            disabled={publishing}
                            data-testid="run-deny"
                          >
                            {t.runs.decline}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="muted">{t.runs.noRuns}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t.runs.recentTitle}</CardTitle>
              </CardHeader>
              <CardContent>
                {runs.length === 0 ? (
                  <div className="empty-inline">
                    <p className="muted">{t.runs.recentEmpty}</p>
                  </div>
                ) : (
                  <Table data-testid="run-list">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.runs.colRunId}</TableHead>
                        <TableHead>{t.runs.colStatus}</TableHead>
                        <TableHead>{t.runs.colError}</TableHead>
                        <TableHead>{t.runs.colCreated}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((run) => (
                        <TableRow key={run.runId} data-run-id={run.runId}>
                          <TableCell className="mono small">{run.runId}</TableCell>
                          <TableCell>
                            <RunStatusBadge status={run.status} />
                          </TableCell>
                          <TableCell className="muted small whitespace-normal">
                            {run.error ?? "—"}
                          </TableCell>
                          <TableCell className="muted small">
                            {formatTime(run.createdAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </Layout>
  );
}
