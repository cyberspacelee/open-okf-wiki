import { useEffect, useState } from "react"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  Clock3Icon,
  PlayIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  fetchRun,
  fetchRuns,
  type RunDetail,
  type RunsError,
  type RunState,
  type RunSummary,
} from "@/lib/runs"
import { cn } from "@/lib/utils"

const phases: Array<{ state: RunState; label: string }> = [
  { state: "preparing", label: "Preparing" },
  { state: "exploring", label: "Exploring" },
  { state: "verifying", label: "Verifying" },
  { state: "rendering", label: "Rendering" },
  { state: "checking", label: "Checking" },
  { state: "review_required", label: "Review Required" },
  { state: "publishing", label: "Publishing" },
  { state: "published", label: "Published" },
]
const activeStates = new Set<RunState>([
  "preparing",
  "exploring",
  "verifying",
  "rendering",
  "checking",
  "publishing",
])

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
  const [reload, setReload] = useState(0)

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
        if (activeStates.has(nextDetail.state)) {
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

      <RunHistory
        runs={runs}
        selectedRunId={selectedRunId}
        onSelectRun={onSelectRun}
      />
      <RunDetails detail={detail} selectedRunId={selectedRunId} />
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
                  <TableCell className="max-w-48 truncate font-mono text-xs">
                    {run.source_set_digest}
                  </TableCell>
                  <TableCell>
                    {run.outcome ? stateLabel(run.outcome) : "In progress"}
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
}: {
  detail: RunDetail | null
  selectedRunId: string | null
}) {
  if (!selectedRunId) return null
  if (!detail || detail.run_id !== selectedRunId)
    return <Skeleton className="h-96 w-full" />

  const recordedPhase = [...detail.events]
    .reverse()
    .find((event) => phases.some((phase) => phase.state === event.state))
    ?.state as RunState | undefined
  const currentPhase = phases.some((phase) => phase.state === detail.state)
    ? detail.state
    : recordedPhase
  const currentIndex = phases.findIndex((phase) => phase.state === currentPhase)
  const timeline = [...detail.events, ...detail.entity_events].sort(
    (left, right) => left.sequence - right.sequence
  )

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="font-mono text-base break-all">
              {detail.run_id}
            </CardTitle>
            <CardDescription>
              {detail.execution.mode === "deterministic_fixture"
                ? `No live gateway · requested ${detail.execution.requested_outcome} fixture`
                : "Legacy Production Run"}
            </CardDescription>
            <CardAction>
              <StateBadge state={detail.state} />
            </CardAction>
          </CardHeader>
          <CardContent>
            <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {phases.map((phase, index) => (
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

        {detail.actionable_errors.length > 0 && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Production Run failed</AlertTitle>
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
                        ? `${titleCase(event.entity_type)} ${stateLabel(event.state)}`
                        : stateLabel(event.state)}
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
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Exact Source Set</CardTitle>
            <CardDescription className="font-mono break-all">
              {detail.source_set_digest}
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

        <TaskCard title="Active tasks" tasks={detail.tasks.active} />
        <TaskCard title="Completed tasks" tasks={detail.tasks.completed} />
        <TaskCard title="Failed tasks" tasks={detail.tasks.failed} />
      </div>
    </div>
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
            <div key={task.id} className="rounded-lg border p-3">
              <p className="truncate font-mono text-xs">{task.id}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {stateLabel(task.state)} · {task.obligation_ids.length}{" "}
                obligations
              </p>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  )
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
      {stateLabel(state)}
    </Badge>
  )
}

function stateLabel(value: string) {
  return value === "review_required" ? "Review Required" : titleCase(value)
}

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
}
