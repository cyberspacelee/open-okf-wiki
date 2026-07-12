import { useCallback, useEffect, useState, type CSSProperties } from "react"
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

import { GatewayConnections } from "@/components/gateway-connections"
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
import { SettingsPage } from "@/components/settings-page"
import { SourcesPage } from "@/components/sources-page"
import { RunsPage } from "@/components/runs-page"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { Overview } from "@/lib/overview"
import {
  RUN_PHASES,
  RUN_STATE_META,
  formatDate,
  runStateLabel,
  titleCase,
  type RunState,
} from "@/lib/runs"
import { fetchSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

const navItems = [
  { label: "Overview", icon: LayoutDashboardIcon, href: "/" },
  { label: "Sources", icon: GitBranchIcon },
  { label: "Runs", icon: PlayIcon },
  { label: "Review", icon: ShieldCheckIcon },
  { label: "Knowledge", icon: BookOpenIcon },
  { label: "Concepts", icon: NetworkIcon },
  { label: "Settings", icon: SettingsIcon },
  { label: "Connections", icon: LinkIcon, href: "/?view=connections" },
] as const

const actionLabels: Record<string, string> = {
  configure_sources: "Configure sources",
  start_run: "Start a production run",
  review_run: "Review the pending run",
  view_run: "View the active run",
}

type Page = "overview" | "sources" | "runs" | "settings" | "connections"

export function OverviewDashboard({
  overview,
  token,
}: {
  overview: Overview
  token: string
}) {
  const query = new URLSearchParams(window.location.search)
  const [page, setPage] = useState<Page>(() => {
    const view = query.get("view")
    return ["sources", "runs", "settings", "connections"].includes(String(view))
      ? (view as Page)
      : "overview"
  })
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() =>
    query.get("run")
  )
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const applyCompactNavigation = useCallback(
    (compact: boolean) => setSidebarOpen(!compact),
    []
  )

  useEffect(() => {
    const controller = new AbortController()
    fetchSettings(token, controller.signal).then(
      (settings) =>
        applyCompactNavigation(settings.local_settings.ui.compact_navigation),
      () => undefined
    )
    return () => controller.abort()
  }, [applyCompactNavigation, token])

  const navigate = useCallback((nextPage: Page, runId?: string) => {
    const parameters = new URLSearchParams()
    if (nextPage !== "overview") parameters.set("view", nextPage)
    if (nextPage === "runs" && runId) parameters.set("run", runId)
    const url = parameters.size ? `/?${parameters}` : "/"
    window.history.replaceState(null, "", url)
    setPage(nextPage)
    if (nextPage === "runs") setSelectedRunId(runId ?? null)
  }, [])
  const selectRun = useCallback(
    (runId: string) => navigate("runs", runId),
    [navigate]
  )

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
      style={{ "--sidebar-width": "14rem" } as CSSProperties}
    >
      <Sidebar collapsible="icon">
        <SidebarHeader className="h-16 justify-center px-5 group-data-[collapsible=icon]:px-2">
          <div className="flex items-center gap-3">
            <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <BoxesIcon className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate text-sm font-semibold">OKF Wiki</p>
              <p className="truncate text-xs text-muted-foreground">
                Workspace Console
              </p>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <PrimaryNavigation page={page} onNavigate={navigate} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="px-4 py-3 text-xs text-muted-foreground group-data-[collapsible=icon]:px-2">
          <p className="flex items-center gap-2">
            <CircleDotIcon className="size-3" aria-hidden="true" />
            <span className="group-data-[collapsible=icon]:sr-only">
              Local control plane
            </span>
          </p>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="border-b bg-background">
          <div className="flex min-h-16 items-center justify-between gap-4 px-5 lg:px-8">
            <div className="flex min-w-0 items-center gap-2">
              <SidebarTrigger className="md:hidden" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {overview.project.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {page === "overview"
                    ? "Workspace overview"
                    : page === "settings"
                      ? "Workspace settings"
                      : page === "sources"
                        ? "Source Checkouts"
                        : page === "runs"
                          ? "Production Runs"
                          : "Gateway connections"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">
                <CircleCheckIcon data-icon="inline-start" />
                Local only
              </Badge>
              {page === "overview" && (
                <Button disabled>
                  <PlayIcon data-icon="inline-start" />
                  Start run
                </Button>
              )}
            </div>
          </div>
        </header>

        {page === "settings" ? (
          <SettingsPage
            token={token}
            onCompactNavigationChange={applyCompactNavigation}
          />
        ) : page === "sources" ? (
          <SourcesPage token={token} onRunStarted={selectRun} />
        ) : page === "runs" ? (
          <RunsPage
            token={token}
            selectedRunId={selectedRunId}
            onSelectRun={selectRun}
          />
        ) : (
          <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-8 px-5 py-7 lg:px-8 lg:py-9">
            {page === "connections" ? (
              <GatewayConnections token={token} />
            ) : (
              <>
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
                      One local view of source readiness, production progress,
                      and the current knowledge bundle.
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
                          ? runStateLabel(overview.active_run.state)
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
              </>
            )}
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}

function PrimaryNavigation({
  page,
  onNavigate,
}: {
  page: Page
  onNavigate: (page: Page) => void
}) {
  const { setOpenMobile } = useSidebar()

  function navigate(nextPage: Page) {
    setOpenMobile(false)
    onNavigate(nextPage)
  }

  return (
    <nav aria-label="Primary">
      <SidebarMenu>
        {navItems.map(({ label, icon: Icon, ...item }) => {
          const target: Page =
            label === "Connections"
              ? "connections"
              : label === "Sources"
                ? "sources"
                : label === "Runs"
                  ? "runs"
                  : label === "Settings"
                    ? "settings"
                    : "overview"
          return (
            <SidebarMenuItem key={label}>
              {"href" in item ? (
                <SidebarMenuButton
                  isActive={page === target}
                  render={
                    <a
                      href={item.href}
                      aria-current={page === target ? "page" : undefined}
                      onClick={(event) => {
                        event.preventDefault()
                        navigate(target)
                      }}
                    />
                  }
                >
                  <Icon />
                  <span>{label}</span>
                </SidebarMenuButton>
              ) : label === "Sources" ||
                label === "Runs" ||
                label === "Settings" ? (
                <SidebarMenuButton
                  isActive={page === target}
                  type="button"
                  aria-current={page === target ? "page" : undefined}
                  onClick={() => navigate(target)}
                >
                  <Icon />
                  <span>{label}</span>
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton disabled type="button">
                  <Icon />
                  <span>{label}</span>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </nav>
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
  const current = state ? (RUN_STATE_META[state as RunState]?.phase ?? -1) : -1

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
          {state ? runStateLabel(state) : "No active run"}
        </Badge>
      </div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        {RUN_PHASES.map((phase, index) => (
          <li
            key={phase.state}
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
              {phase.label}
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
            {bundle ? runStateLabel(bundle.state) : "Empty"}
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
            {run ? runStateLabel(run.state) : "Idle"}
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
