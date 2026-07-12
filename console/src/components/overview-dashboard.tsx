import {
  BookOpenIcon,
  BoxesIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  GitBranchIcon,
  LayoutDashboardIcon,
  LinkIcon,
  NetworkIcon,
  PlayIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
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
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { Overview } from "@/lib/overview"
import { cn } from "@/lib/utils"

const navItems = [
  { label: "Overview", icon: LayoutDashboardIcon },
  { label: "Sources", icon: GitBranchIcon },
  { label: "Runs", icon: PlayIcon },
  { label: "Review", icon: ShieldCheckIcon },
  { label: "Knowledge", icon: BookOpenIcon },
  { label: "Concepts", icon: NetworkIcon },
  { label: "Settings", icon: SettingsIcon },
  { label: "Connections", icon: LinkIcon },
] as const

const phases = [
  "Preparing",
  "Exploring",
  "Verifying",
  "Rendering",
  "Review",
] as const

const actionLabels: Record<string, string> = {
  configure_sources: "Configure sources",
  start_run: "Start a production run",
  review_run: "Review the pending run",
  view_run: "View the active run",
}

export function OverviewDashboard({ overview }: { overview: Overview }) {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 hidden w-56 border-r bg-sidebar lg:flex lg:flex-col">
        <div className="flex h-16 items-center gap-3 px-5">
          <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <BoxesIcon className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">OKF Wiki</p>
            <p className="truncate text-xs text-muted-foreground">
              Workspace Console
            </p>
          </div>
        </div>
        <Separator />
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-1 p-3">
          {navItems.map(({ label, icon: Icon }, index) => (
            <Button
              key={label}
              aria-current={index === 0 ? "page" : undefined}
              disabled={index !== 0}
              variant={index === 0 ? "secondary" : "ghost"}
              className="w-full justify-start"
            >
              <Icon data-icon="inline-start" />
              {label}
            </Button>
          ))}
        </nav>
        <div className="p-4 text-xs text-muted-foreground">
          <p className="flex items-center gap-2">
            <CircleDotIcon className="size-3" aria-hidden="true" />
            Local control plane
          </p>
        </div>
      </aside>

      <div className="lg:pl-56">
        <header className="border-b bg-background">
          <div className="flex min-h-16 items-center justify-between gap-4 px-5 lg:px-8">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {overview.project.name}
              </p>
              <p className="text-xs text-muted-foreground">
                Workspace overview
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">
                <CircleCheckIcon data-icon="inline-start" />
                Local only
              </Badge>
              <Button disabled>
                <PlayIcon data-icon="inline-start" />
                Start run
              </Button>
            </div>
          </div>
          <nav
            aria-label="Mobile primary"
            className="flex scroll-fade-x overflow-x-auto px-3 pb-3 lg:hidden"
          >
            {navItems.map(({ label }, index) => (
              <Button
                key={label}
                disabled={index !== 0}
                size="sm"
                variant={index === 0 ? "secondary" : "ghost"}
              >
                {label}
              </Button>
            ))}
          </nav>
        </header>

        <main className="mx-auto flex max-w-[90rem] flex-col gap-8 px-5 py-7 lg:px-8 lg:py-9">
          <section
            aria-labelledby="overview-title"
            className="grid gap-6 border-b pb-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end"
          >
            <div className="min-w-0">
              <p className="mb-2 text-sm text-muted-foreground">
                Producer Project
              </p>
              <h1
                id="overview-title"
                className="truncate text-3xl font-semibold tracking-tight lg:text-4xl"
              >
                {overview.project.name}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                One local view of source readiness, production progress, and the
                current knowledge bundle.
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
              <SummaryMetric
                label="Sources"
                value={String(overview.source_count)}
              />
              <SummaryMetric
                label="Bundle"
                value={
                  overview.latest_bundle
                    ? titleCase(overview.latest_bundle.state)
                    : "Not built"
                }
              />
              <SummaryMetric
                label="Run"
                value={
                  overview.active_run
                    ? titleCase(overview.active_run.state)
                    : "Idle"
                }
              />
            </dl>
          </section>

          <PhaseRail state={overview.active_run?.state ?? null} />

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.75fr)]">
            <SourceHealth sourceCount={overview.source_count} />
            <div className="flex flex-col gap-4">
              <BundleCard overview={overview} />
              <RunCard overview={overview} />
              <BlockersCard blockers={overview.blockers} />
            </div>
          </div>

          <NextActions actions={overview.next_actions} />
        </main>
      </div>
    </div>
  )
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-semibold">{value}</dd>
    </div>
  )
}

function PhaseRail({ state }: { state: string | null }) {
  const current = state ? phaseIndex(state) : -1

  return (
    <section aria-labelledby="production-flow-title">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 id="production-flow-title" className="text-base font-semibold">
            Production flow
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Recorded deterministic phases for the active run.
          </p>
        </div>
        <Badge variant={state ? "secondary" : "outline"}>
          {state ? titleCase(state) : "No active run"}
        </Badge>
      </div>
      <ol className="grid gap-2 sm:grid-cols-5">
        {phases.map((phase, index) => (
          <li
            key={phase}
            className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-full bg-muted-foreground/30",
                index < current && "bg-primary/50",
                index === current && "bg-primary ring-4 ring-primary/10"
              )}
            />
            <span
              className={cn(
                "truncate text-xs text-muted-foreground",
                index === current && "font-medium text-foreground"
              )}
            >
              {phase}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function SourceHealth({ sourceCount }: { sourceCount: number }) {
  return (
    <section
      aria-labelledby="source-health-title"
      className="min-w-0 self-start rounded-lg border"
    >
      <div className="flex items-start justify-between gap-4 p-5">
        <div>
          <h2 id="source-health-title" className="text-base font-semibold">
            Source health
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Source details are resolved by the local control plane.
          </p>
        </div>
        <Badge variant="outline">{sourceCount} configured</Badge>
      </div>
      <Separator />
      {sourceCount === 0 ? (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitBranchIcon />
            </EmptyMedia>
            <EmptyTitle>No sources configured</EmptyTitle>
            <EmptyDescription>
              Add a code, documentation, requirements, or contract repository to
              begin.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Scope</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Count</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium">Workspace sources</TableCell>
              <TableCell>
                <Badge variant="secondary">Configured</Badge>
              </TableCell>
              <TableCell className="text-right font-mono">
                {sourceCount}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </section>
  )
}

function BundleCard({ overview }: { overview: Overview }) {
  const bundle = overview.latest_bundle
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Latest bundle</CardTitle>
        <CardDescription>
          {bundle
            ? formatDate(bundle.updated_at)
            : "No knowledge bundle has been produced."}
        </CardDescription>
        <CardAction>
          <Badge variant={bundle ? "secondary" : "outline"}>
            {bundle ? titleCase(bundle.state) : "Empty"}
          </Badge>
        </CardAction>
      </CardHeader>
      {bundle && (
        <CardContent className="flex flex-col gap-2">
          <Detail label="Run" value={bundle.run_id} mono />
          <Detail label="Path" value={bundle.path} mono />
        </CardContent>
      )}
    </Card>
  )
}

function RunCard({ overview }: { overview: Overview }) {
  const run = overview.active_run
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Production run</CardTitle>
        <CardDescription>
          {run
            ? `Updated ${formatDate(run.updated_at)}`
            : "No production run is active."}
        </CardDescription>
        <CardAction>
          <Badge variant={run ? "secondary" : "outline"}>
            {run ? titleCase(run.state) : "Idle"}
          </Badge>
        </CardAction>
      </CardHeader>
      {run && (
        <CardContent>
          <Detail label="Run" value={run.run_id} mono />
        </CardContent>
      )}
    </Card>
  )
}

function BlockersCard({ blockers }: { blockers: string[] }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Blockers</CardTitle>
        <CardDescription>
          {blockers.length
            ? "Resolve these before the next production action."
            : "No blockers reported by the control plane."}
        </CardDescription>
        <CardAction>
          <Badge variant={blockers.length ? "destructive" : "outline"}>
            {blockers.length}
          </Badge>
        </CardAction>
      </CardHeader>
      {blockers.length > 0 && (
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm">
            {blockers.map((blocker) => (
              <li key={blocker} className="flex gap-2">
                <CircleAlertIcon
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <span>{blocker}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  )
}

function NextActions({ actions }: { actions: string[] }) {
  if (actions.length === 0) return null

  return (
    <Alert>
      <SparklesIcon />
      <AlertTitle>Next actions</AlertTitle>
      <AlertDescription>
        <ul className="mt-2 flex flex-col gap-1">
          {actions.map((action) => (
            <li key={action}>{actionLabels[action] ?? titleCase(action)}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <dl className="grid min-w-0 grid-cols-[4rem_minmax(0,1fr)] gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono")}>{value}</dd>
    </dl>
  )
}

function phaseIndex(state: string) {
  const normalized = state.toLowerCase().replaceAll("-", "_")
  if (normalized.includes("prepar")) return 0
  if (normalized.includes("explor") || normalized.includes("analy")) return 1
  if (normalized.includes("verif")) return 2
  if (normalized.includes("render") || normalized.includes("check")) return 3
  if (normalized.includes("review") || normalized.includes("publish")) return 4
  return -1
}

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
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
