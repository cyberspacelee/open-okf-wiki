import { useEffect, useState } from "react"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  Clock3Icon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  XCircleIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ACTIVE_RUN_STATES,
  RUN_PHASES,
  cancelRun,
  fetchRun,
  fetchRuns,
  formatDate,
  runStateLabel,
  recoverRun,
  titleCase,
  type RunDetail,
  type RunsError,
  type RunState,
  type RunSummary,
} from "@/lib/runs"
import { cn } from "@/lib/utils"

export function RunsPage({
  token,
  selectedRunId,
  onSelectRun,
}: {
  token: string
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [error, setError] = useState<RunsError | null>(null)
  const [operationError, setOperationError] = useState<RunsError | null>(null)
  const [working, setWorking] = useState<"cancel" | "recover" | null>(null)
  const [reload, setReload] = useState(0)

  async function operate(action: "cancel" | "recover") {
    if (!detail) return
    setWorking(action)
    setOperationError(null)
    try {
      const next = await (action === "cancel"
        ? cancelRun(token, detail.run_id)
        : recoverRun(token, detail.run_id))
      setDetail(next)
      setRuns(
        (current) =>
          current?.map((run) =>
            run.run_id === next.run_id
              ? {
                  ...run,
                  state: next.state,
                  phase: next.phase,
                  outcome: next.outcome,
                  updated_at: next.updated_at,
                }
              : run
          ) ?? null
      )
    } catch (reason) {
      setOperationError(reason as RunsError)
    } finally {
      setWorking(null)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    fetchRuns(token, controller.signal).then(
      (snapshot) => {
        setRuns(snapshot.runs)
        setError(null)
        if (!selectedRunId && snapshot.runs[0])
          onSelectRun(snapshot.runs[0].run_id)
      },
      (reason: RunsError) => {
        if (!controller.signal.aborted) setError(reason)
      }
    )
    return () => controller.abort()
  }, [onSelectRun, reload, selectedRunId, token])

  useEffect(() => {
    if (!selectedRunId) return
    const controller = new AbortController()
    let timer: number | undefined
    let attempts = 0

    async function load() {
      try {
        const [nextDetail, snapshot] = await Promise.all([
          fetchRun(token, selectedRunId!, controller.signal),
          fetchRuns(token, controller.signal),
        ])
        if (controller.signal.aborted) return
        setDetail(nextDetail)
        setRuns(snapshot.runs)
        setError(null)
        attempts += 1
        if (ACTIVE_RUN_STATES.has(nextDetail.state)) {
          if (attempts < 40) timer = window.setTimeout(load, 500)
          else
            setError({
              kind: "server",
              message:
                "Automatic refresh paused after 20 seconds. Retry to continue.",
            })
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason as RunsError)
      }
    }

    load()
    return () => {
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [reload, selectedRunId, token])

  return (
    <main className="mx-auto flex w-full max-w-[90rem] flex-col gap-6 px-5 py-7 lg:px-8 lg:py-9">
      <section
        className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"
        aria-labelledby="runs-title"
      >
        <div>
          <p className="mb-2 text-sm text-muted-foreground">
            Deterministic ledger
          </p>
          <h1 id="runs-title" className="text-3xl font-semibold tracking-tight">
            Production Runs
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Recorded phases, typed task outcomes, and immutable Source Set
            identity from the Python control plane.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Reload Runs
        </Button>
      </section>

      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Run status could not be refreshed</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>
              {error.message} The last recorded state remains visible.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReload((value) => value + 1)}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {operationError && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Run operation failed</AlertTitle>
          <AlertDescription>{operationError.message}</AlertDescription>
        </Alert>
      )}

      <RunHistory
        runs={runs}
        selectedRunId={selectedRunId}
        onSelectRun={onSelectRun}
      />
      <RunDetails
        detail={detail}
        selectedRunId={selectedRunId}
        working={working}
        onAction={operate}
      />
    </main>
  )
}

function RunHistory({
  runs,
  selectedRunId,
  onSelectRun,
}: {
  runs: RunSummary[] | null
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Run history</CardTitle>
        <CardDescription>
          Active and historical attempts, newest first.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">{runs?.length ?? 0} Runs</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {!runs ? (
          <div className="flex flex-col gap-3 px-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : runs.length === 0 ? (
          <Empty className="min-h-48">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlayIcon />
              </EmptyMedia>
              <EmptyTitle>No Production Runs yet</EmptyTitle>
              <EmptyDescription>
                Resolve the Next Run Source Set on Sources, then start a
                deterministic fixture.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Source Set</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow
                  key={run.run_id}
                  data-state={
                    run.run_id === selectedRunId ? "selected" : undefined
                  }
                >
                  <TableCell>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => onSelectRun(run.run_id)}
                    >
                      <span className="max-w-36 truncate font-mono">
                        {run.run_id}
                      </span>
                    </Button>
                  </TableCell>
                  <TableCell>
                    <StateBadge state={run.state} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(run.created_at)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(run.updated_at)}
                  </TableCell>
                  <TableCell className="max-w-48 truncate">
                    <code className="text-xs">{run.source_set_digest}</code>
                  </TableCell>
                  <TableCell>
                    {run.outcome ? runStateLabel(run.outcome) : "In progress"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function RunDetails({
  detail,
  selectedRunId,
  working,
  onAction,
}: {
  detail: RunDetail | null
  selectedRunId: string | null
  working: "cancel" | "recover" | null
  onAction: (action: "cancel" | "recover") => Promise<void>
}) {
  if (!selectedRunId) return null
  if (!detail || detail.run_id !== selectedRunId)
    return <Skeleton className="h-96 w-full" />

  const recordedPhase = [...detail.events]
    .reverse()
    .find((event) => RUN_PHASES.some((phase) => phase.state === event.state))
    ?.state as RunState | undefined
  const currentPhase = RUN_PHASES.some((phase) => phase.state === detail.state)
    ? detail.state
    : recordedPhase
  const currentIndex = RUN_PHASES.findIndex(
    (phase) => phase.state === currentPhase
  )
  const timeline = [...detail.events, ...detail.entity_events].sort(
    (left, right) => left.sequence - right.sequence
  )

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>
              <code className="break-all">{detail.run_id}</code>
            </CardTitle>
            <CardDescription>
              {detail.execution.mode === "deterministic_fixture"
                ? `No live gateway · requested ${detail.execution.requested_outcome} fixture`
                : detail.execution.mode === "gateway_semantic"
                  ? "Semantic execution through the recorded Gateway Profile"
                  : "Legacy Production Run"}
            </CardDescription>
            <CardAction className="flex flex-wrap items-center justify-end gap-2">
              {detail.operations.can_recover && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={working !== null}
                  onClick={() => void onAction("recover")}
                >
                  {working === "recover" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RotateCcwIcon data-icon="inline-start" />
                  )}
                  Recover Run
                </Button>
              )}
              {detail.operations.can_cancel && (
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={working !== null}
                      />
                    }
                  >
                    <XCircleIcon data-icon="inline-start" />
                    Cancel Run
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Cancel this Production Run?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        The Run becomes terminal. Accepted state and diagnostics
                        remain available, but staging output will never publish.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep running</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() => void onAction("cancel")}
                      >
                        Cancel Run
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              <StateBadge state={detail.state} />
            </CardAction>
          </CardHeader>
          <CardContent>
            <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {RUN_PHASES.map((phase, index) => (
                <li
                  key={phase.state}
                  aria-current={index === currentIndex ? "step" : undefined}
                  className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 shrink-0 rounded-full bg-muted-foreground/30",
                      index < currentIndex && "bg-primary/50",
                      index === currentIndex &&
                        "bg-primary ring-4 ring-primary/10"
                    )}
                  />
                  <span
                    className={cn(
                      "text-xs text-muted-foreground",
                      index === currentIndex && "font-medium text-foreground"
                    )}
                  >
                    {phase.label}
                  </span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <OperationalDiagnostics detail={detail} />

        {detail.actionable_errors.length > 0 && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Actionable failure</AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-1">
                {detail.actionable_errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Event timeline</CardTitle>
            <CardDescription>
              Persisted transitions only; prompts and hidden reasoning are never
              shown.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-4">
              {timeline.map((event) => (
                <li
                  key={event.sequence}
                  className="grid grid-cols-[auto_minmax(0,1fr)] gap-3"
                >
                  <Clock3Icon
                    className="mt-0.5 size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {"entity_type" in event &&
                      typeof event.entity_type === "string"
                        ? `${titleCase(event.entity_type)} ${titleCase(event.state)}`
                        : runStateLabel(event.state)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(event.occurred_at)} · event {event.sequence}
                      {"entity_id" in event &&
                      typeof event.entity_id === "string"
                        ? ` · ${event.entity_id}`
                        : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <AuditCard audit={detail.audit} />

        <CoverageCard obligations={detail.coverage_obligations} />
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Exact Source Set</CardTitle>
            <CardDescription>
              <code className="break-all">{detail.source_set_digest}</code>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {detail.sources.map((source) => (
              <dl
                key={source.id}
                className="grid min-w-0 gap-1 rounded-lg border p-3 text-xs"
              >
                <dt className="font-medium break-all">
                  {source.id} · {titleCase(source.role)}
                </dt>
                <dd className="font-mono break-all text-muted-foreground">
                  Commit {source.revision}
                </dd>
                <dd className="font-mono break-all text-muted-foreground">
                  Tree {source.tree_digest ?? "legacy unavailable"}
                </dd>
              </dl>
            ))}
          </CardContent>
        </Card>

        {detail.models && <GatewaySnapshotCard models={detail.models} />}

        <TaskCard title="Active Analysis Tasks" tasks={detail.tasks.active} />
        <TaskCard
          title="Completed Analysis Tasks"
          tasks={detail.tasks.completed}
        />
        <TaskCard title="Failed Analysis Tasks" tasks={detail.tasks.failed} />
      </div>
    </div>
  )
}

function OperationalDiagnostics({ detail }: { detail: RunDetail }) {
  const diagnostics = detail.diagnostics
  return (
    <Card>
      <CardHeader>
        <CardTitle>Operational diagnostics</CardTitle>
        <CardDescription>
          Checkpoint-safe state and redacted operator data from the control
          plane.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">
            {titleCase(diagnostics.classification)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Active tasks</dt>
            <dd className="mt-1 font-semibold">{diagnostics.active_tasks}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Failed tasks</dt>
            <dd className="mt-1 font-semibold">{diagnostics.failed_tasks}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Staging</dt>
            <dd className="mt-1 font-semibold">
              {diagnostics.staging.exists ? "Preserved" : "Not created"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Outcome</dt>
            <dd className="mt-1 font-semibold">
              {diagnostics.terminal_outcome
                ? runStateLabel(diagnostics.terminal_outcome)
                : "Not terminal"}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          {Object.entries(diagnostics.budgets).map(([name, budget]) => (
            <Badge key={name} variant="secondary">
              {titleCase(name)} {formatNumber(budget.used)} used ·{" "}
              {formatNumber(budget.remaining)} remaining
            </Badge>
          ))}
        </div>
        {diagnostics.review_blockers.length > 0 && (
          <Alert>
            <CircleAlertIcon />
            <AlertTitle>Review blockers</AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-1">
                {diagnostics.review_blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {detail.operations.recover_reason &&
          diagnostics.classification !== "terminal" && (
            <p className="text-xs text-muted-foreground">
              {detail.operations.recover_reason}
            </p>
          )}
      </CardContent>
    </Card>
  )
}

function TaskCard({
  title,
  tasks,
}: {
  title: string
  tasks: RunDetail["tasks"]["active"]
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {tasks.length
            ? "Typed Scheduler outcomes."
            : "No tasks in this state."}
        </CardDescription>
        <CardAction>
          <Badge variant="outline">{tasks.length}</Badge>
        </CardAction>
      </CardHeader>
      {tasks.length > 0 && (
        <CardContent className="flex flex-col gap-3">
          {tasks.map((task) => (
            <article
              key={task.id}
              className="flex min-w-0 flex-col gap-3 rounded-lg border p-3"
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs break-all">{task.id}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {task.source_id} · {titleCase(task.agent_role)}
                  </p>
                </div>
                <Badge variant="outline">{titleCase(task.state)}</Badge>
              </div>

              <dl className="grid gap-3 text-xs">
                <div>
                  <dt className="font-medium">Path scope</dt>
                  <dd className="mt-1 flex flex-col gap-1 text-muted-foreground">
                    {task.path_scope.map((path) => (
                      <code key={path} className="break-all">
                        {path}
                      </code>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Obligation IDs</dt>
                  <dd className="mt-1 flex flex-col gap-1 font-mono text-muted-foreground">
                    {task.obligation_ids.map((id) => (
                      <span key={id} className="break-all">
                        {id}
                      </span>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">Budgets</dt>
                  <dd className="mt-1 flex flex-wrap gap-2">
                    {Object.entries(task.budgets).map(([name, value]) => (
                      <Badge key={name} variant="secondary">
                        {titleCase(name)} {formatNumber(value)}
                      </Badge>
                    ))}
                  </dd>
                </div>
              </dl>

              {task.receipt && (
                <div className="rounded-md bg-muted p-3 text-xs">
                  <p className="font-medium">Compact receipt</p>
                  <p className="mt-1 text-muted-foreground">
                    {task.receipt.accepted_ids.length} accepted ·{" "}
                    {task.receipt.unresolved_ids.length} unresolved ·{" "}
                    {task.receipt.warnings.length} warnings
                  </p>
                  {task.receipt.warnings.map((warning) => (
                    <p key={warning} className="mt-1 text-muted-foreground">
                      {warning}
                    </p>
                  ))}
                </div>
              )}
              {task.error && (
                <p className="text-xs text-destructive">{task.error}</p>
              )}
            </article>
          ))}
        </CardContent>
      )}
    </Card>
  )
}

function GatewaySnapshotCard({ models }: { models: RunDetail["models"] }) {
  if (!models) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Gateway snapshot</CardTitle>
        <CardDescription>
          {models.profile.name ?? models.profile.id} · revision{" "}
          {models.profile.revision ?? "unavailable"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 text-xs">
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-muted-foreground">Gateway</dt>
              <dd className="mt-1 font-medium break-all">
                {models.profile.gateway_id ?? models.profile.id}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Concurrency</dt>
              <dd className="mt-1 font-medium">{models.concurrency}</dd>
            </div>
          </dl>
          <div>
            <p className="font-medium">Model assignments</p>
            <dl className="mt-2 flex flex-col gap-2">
              {Object.entries(models.assignments).map(([role, model]) => (
                <div
                  key={role}
                  className="flex items-start justify-between gap-3"
                >
                  <dt className="text-muted-foreground">{titleCase(role)}</dt>
                  <dd className="text-right font-mono break-all">{model}</dd>
                </div>
              ))}
            </dl>
          </div>
          {Object.keys(models.budgets).length > 0 && (
            <div>
              <p className="font-medium">Run budgets</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(models.budgets).map(([name, value]) => (
                  <Badge key={name} variant="secondary">
                    {titleCase(name)} {formatNumber(value)}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function AuditCard({ audit }: { audit: RunDetail["audit"] }) {
  const totals = [
    ["Tokens", audit.tokens],
    ["Tool calls", audit.tool_calls],
    ["Retries", audit.retries],
    ["Latency", `${formatNumber(audit.latency_ms)} ms`],
    ["Failures", audit.failures],
  ] as const
  return (
    <Card>
      <CardHeader>
        <CardTitle>Operational audit</CardTitle>
        <CardDescription>
          Aggregated usage only; prompts and hidden reasoning are excluded.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {totals.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-semibold">
                {typeof value === "number" ? formatNumber(value) : value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Models</span>
          {audit.models.length ? (
            audit.models.map((model) => (
              <Badge key={model} variant="outline">
                {model}
              </Badge>
            ))
          ) : (
            <Badge variant="outline">No model calls</Badge>
          )}
        </div>
        {audit.by_role_model.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role / model</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>Tools</TableHead>
                <TableHead>Retries</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Failures</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audit.by_role_model.map((item) => (
                <TableRow key={`${item.role}:${item.model}`}>
                  <TableCell>
                    <p className="font-medium">{titleCase(item.role)}</p>
                    <p className="font-mono text-xs break-all text-muted-foreground">
                      {item.model}
                    </p>
                  </TableCell>
                  <TableCell>{formatNumber(item.calls)}</TableCell>
                  <TableCell>{formatNumber(item.tokens)}</TableCell>
                  <TableCell>{formatNumber(item.tool_calls)}</TableCell>
                  <TableCell>{formatNumber(item.retries)}</TableCell>
                  <TableCell>{formatNumber(item.latency_ms)} ms</TableCell>
                  <TableCell>{formatNumber(item.failures)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function CoverageCard({
  obligations,
}: {
  obligations: RunDetail["coverage_obligations"]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Coverage obligations</CardTitle>
        <CardDescription>
          Persisted source coverage and disposition changes.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">{obligations.length}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {obligations.length ? (
          obligations.map((obligation) => (
            <article
              key={obligation.id}
              className="flex min-w-0 flex-col gap-3 rounded-lg border p-3"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-xs break-all">{obligation.id}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {obligation.source} · {titleCase(obligation.role)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">
                    {titleCase(obligation.priority)}
                  </Badge>
                  <Badge variant="secondary">
                    {titleCase(obligation.disposition)}
                  </Badge>
                </div>
              </div>
              <ol className="flex flex-wrap gap-2 text-xs">
                {obligation.state_changes.map((change) => (
                  <li key={change.sequence}>
                    <Badge variant="outline">{titleCase(change.state)}</Badge>
                  </li>
                ))}
              </ol>
            </article>
          ))
        ) : (
          <Empty className="min-h-32">
            <EmptyHeader>
              <EmptyTitle>No Coverage Obligations</EmptyTitle>
              <EmptyDescription>
                Coverage will appear after the Planner records source work.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  )
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}

function StateBadge({ state }: { state: string }) {
  const terminal = state === "failed" || state === "cancelled"
  return (
    <Badge
      variant={
        terminal
          ? "destructive"
          : state === "published"
            ? "default"
            : "secondary"
      }
    >
      {state === "published" && <CircleCheckIcon data-icon="inline-start" />}
      {runStateLabel(state)}
    </Badge>
  )
}
