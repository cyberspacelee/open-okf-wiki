import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  cancelRun,
  createRun,
  getWorkspace,
  listRuns,
  retryRun,
  type StoredRunRecord,
  type WorkspaceConfig,
} from "../api";
import { LoadingState } from "../components/LoadingState";
import { RunStatusBadge } from "../components/RunStatusBadge";
import { WorkspaceShell } from "../components/WorkspaceShell";
import { useI18n } from "../i18n";
import { agentWorkspaceHref, workspaceHref } from "../lib/workspace-path";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function isActiveJobStatus(status: StoredRunRecord["status"]): boolean {
  return status === "running" || status === "awaiting_plan" || status === "awaiting_publication";
}

export function WorkspaceRunPage() {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [runs, setRuns] = useState<StoredRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<unknown>(null);

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

  const lastRun = runs[0];
  const root = workspace?.rootPath ?? rootPathHint;
  const latestStatus = lastRun?.status;

  // Poll while the latest job is still in progress (no agent stream on this page).
  useEffect(() => {
    if (!id || !workspace || latestStatus !== "running") {
      return;
    }
    const timer = setInterval(() => {
      void (async () => {
        try {
          const runData = await listRuns(id, root);
          setRuns(runData.runs);
        } catch {
          // Keep last known state; full reload can surface errors.
        }
      })();
    }, 1500);
    return () => clearInterval(timer);
  }, [id, workspace, root, latestStatus]);

  const canStart = Boolean(workspace && workspace.sources.length > 0);
  const awaitingPublication = lastRun?.status === "awaiting_publication";
  const awaitingPlan = lastRun?.status === "awaiting_plan";
  const canCancel = lastRun ? isActiveJobStatus(lastRun.status) : false;
  // Retry starts a new run with frozen skill; only after the prior run has left
  // in-progress / HITL states (not while plan or publication gates are open).
  const canRetry =
    Boolean(lastRun) &&
    canStart &&
    lastRun!.status !== "running" &&
    lastRun!.status !== "awaiting_plan" &&
    lastRun!.status !== "awaiting_publication" &&
    lastRun!.status !== "needs_input";

  const showWikiLink =
    Boolean(lastRun) &&
    (lastRun!.status === "published" ||
      lastRun!.status === "awaiting_publication" ||
      lastRun!.status === "publication_declined" ||
      (lastRun!.pages && lastRun!.pages.length > 0));

  const agentHref = agentWorkspaceHref(id, rootPathHint, {
    ...(lastRun?.sessionId ? { sessionId: lastRun.sessionId } : {}),
  });

  /** Headless job start (no Agent chat UI). Kept for audit / e2e / auto paths. */
  async function handleStartHeadless() {
    if (!id) {
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const result = await createRun(id, {}, root);
      setRuns((prev) => [result.run, ...prev.filter((r) => r.runId !== result.run.runId)]);
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
    try {
      const result = await retryRun(id, lastRun.runId, root);
      setRuns((prev) => [result.run, ...prev.filter((r) => r.runId !== result.run.runId)]);
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
      const result = await cancelRun(id, lastRun.runId, root);
      setRuns((prev) => prev.map((r) => (r.runId === result.run.runId ? result.run : r)));
    } catch (err) {
      setError(err);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <WorkspaceShell
      workspaceId={id}
      workspaceName={workspace?.name}
      breadcrumbLabel={t.runs.breadcrumb}
      title={t.runs.title}
      description={
        <>
          {t.runs.descriptionBefore}
          <Link to={agentWorkspaceHref(id, rootPathHint)}>{t.runs.descriptionLink}</Link>
          {t.runs.descriptionAfter}
        </>
      }
      error={error}
      onDismissError={() => setError(null)}
      testId="run-page"
    >
      {loading ? (
        <LoadingState label={t.runs.loading} />
      ) : workspace ? (
        <>
          <Card>
            <CardHeader className="row-between items-center">
              <CardTitle>{t.runs.auditTitle}</CardTitle>
              <div className="row-actions flex flex-wrap gap-2">
                <Link to={agentHref} className={cn(buttonVariants())} data-testid="run-open-agent">
                  {t.runs.openAgent}
                </Link>
                {showWikiLink ? (
                  <Link
                    to={workspaceHref(id, "/wiki", rootPathHint)}
                    className={cn(buttonVariants({ variant: "outline" }))}
                    data-testid="run-open-wiki"
                  >
                    {t.subnav.wiki}
                  </Link>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {!canStart ? (
                <p className="muted">
                  {t.runs.needSource}{" "}
                  <Link to={workspaceHref(id, "/sources", rootPathHint)}>{t.runs.openSources}</Link>
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

                  {lastRun.skillDigest ? (
                    <p className="muted small mono" data-testid="run-skill-digest">
                      {t.runs.skillDigest}: {lastRun.skillDigest.slice(0, 16)}…
                    </p>
                  ) : null}

                  {awaitingPlan || awaitingPublication ? (
                    <div
                      className="rounded-lg border border-dashed bg-muted/30 px-3 py-3"
                      data-testid="run-session-gate-hint"
                    >
                      <p className="text-sm text-muted-foreground">
                        {awaitingPlan ? t.runs.gateOnSessionPlan : t.runs.gateOnSessionPublish}
                      </p>
                      <div className="mt-2">
                        <Link
                          to={agentHref}
                          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                          data-testid="run-open-session-gate"
                        >
                          {t.runs.openSessionToDecide}
                        </Link>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="muted">{t.runs.noRuns}</p>
              )}

              <div className="row-actions flex flex-wrap gap-2">
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
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t.runs.recentTitle}</CardTitle>
            </CardHeader>
            <CardContent>
              {runs.length === 0 ? (
                <div className="py-1">
                  <p className="muted">{t.runs.recentEmpty}</p>
                </div>
              ) : (
                <Table data-testid="run-list">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.runs.colRunId}</TableHead>
                      <TableHead>{t.runs.colStatus}</TableHead>
                      <TableHead>{t.runs.summary}</TableHead>
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
                          {run.summary ?? "—"}
                        </TableCell>
                        <TableCell className="muted small whitespace-normal">
                          {run.error ?? "—"}
                        </TableCell>
                        <TableCell className="muted small">{formatTime(run.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </WorkspaceShell>
  );
}
