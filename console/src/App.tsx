import { useEffect, useState } from "react"
import { CircleAlertIcon, LockKeyholeIcon } from "lucide-react"

import { OverviewDashboard } from "@/components/overview-dashboard"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  consumeSessionToken,
  fetchOverview,
  type Overview,
  type OverviewError,
} from "@/lib/overview"

type LoadState =
  | { status: "loading" }
  | { status: "ready"; overview: Overview }
  | { status: "error"; error: OverviewError }

export function App() {
  const [token] = useState(consumeSessionToken)
  const [state, setState] = useState<LoadState>(() =>
    token
      ? { status: "loading" }
      : {
          status: "error",
          error: {
            kind: "session",
            message:
              "Open the Console from the local launch command to start a secure session.",
          },
        }
  )

  useEffect(() => {
    const controller = new AbortController()

    if (!token) return () => controller.abort()

    fetchOverview(token, controller.signal).then(
      (overview) => setState({ status: "ready", overview }),
      (error: OverviewError) => {
        if (!controller.signal.aborted) setState({ status: "error", error })
      }
    )

    return () => controller.abort()
  }, [token])

  if (state.status === "loading") return <LoadingOverview />
  if (state.status === "error") return <ErrorOverview error={state.error} />

  return <OverviewDashboard overview={state.overview} token={token!} />
}

function LoadingOverview() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading workspace overview"
      className="min-h-svh bg-background p-6 lg:p-10"
    >
      <p className="sr-only" role="status">
        Loading workspace
      </p>
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-9 w-64" />
          </div>
          <Skeleton className="h-8 w-24" />
        </div>
        <Skeleton className="h-32 w-full" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.8fr)]">
          <Skeleton className="h-80 w-full" />
          <div className="flex flex-col gap-4">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        </div>
      </div>
    </main>
  )
}

function ErrorOverview({ error }: { error: OverviewError }) {
  const invalid = error.kind === "invalid-workspace"

  return (
    <main className="grid min-h-svh place-items-center bg-muted/30 p-6">
      <div className="w-full max-w-lg">
        {error.kind === "session" ? (
          <Empty className="border bg-background">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LockKeyholeIcon />
              </EmptyMedia>
              <EmptyTitle>Secure session required</EmptyTitle>
              <EmptyDescription>{error.message}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Alert variant={invalid ? "default" : "destructive"}>
            <CircleAlertIcon />
            <AlertTitle>
              {invalid
                ? "Workspace configuration needs attention"
                : "Workspace Console unavailable"}
            </AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
      </div>
    </main>
  )
}

export default App
