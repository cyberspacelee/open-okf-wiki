import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  ClockIcon,
  GitCompareArrowsIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import {
  fetchReplay,
  REPLAY_ENTITY_TYPES,
  REPLAY_STAGES,
  type ImpactNode,
  type ReplayError,
  type ReplayEntityType,
  type ReplayEvent,
  type ReplaySnapshot,
  type ReplayStage,
} from "@/lib/replay"
import { formatDate, titleCase } from "@/lib/runs"
import { cn } from "@/lib/utils"

type LoadState =
  | { requestKey: string; status: "ready"; replay: ReplaySnapshot }
  | { requestKey: string; status: "error"; error: ReplayError }

const stageLabels: Record<ReplayStage, string> = {
  proposed: "Proposed",
  verified: "Verified",
  accepted: "Accepted",
  rejected: "Rejected",
  stale: "Stale",
  published: "Published",
}

const impactTypeLabels: Record<ImpactNode["type"], string> = {
  source_unit: "Source Unit",
  evidence: "Evidence Reference",
  claim: "Claim",
  concept: "Concept",
  page: "Bundle page",
}

const impactStageTypes = [
  "source_unit",
  "evidence",
  "claim",
  "concept",
  "page",
] as const

const paginationButtonClassName = "w-full min-w-0 sm:w-auto"

function entityLocator(entity: Pick<ReplayEvent, "entity_type" | "entity_id">) {
  return JSON.stringify([entity.entity_type, entity.entity_id])
}

export function ReplayPage({
  token,
  selectedRunId,
  onBack,
}: {
  token: string
  selectedRunId: string | null
  onBack: () => void
}) {
  const [eventOffset, setEventOffset] = useState(0)
  const [impactOffset, setImpactOffset] = useState(0)
  const [pathOffset, setPathOffset] = useState(0)
  const locateNonce = useRef(0)
  const [focusRequest, setFocusRequest] = useState<number | null>(null)
  const [location, setLocation] = useState<{
    eventSequence?: number
    entityType?: ReplayEntityType
    entityId?: string
  }>({})
  const requestKey = [
    token,
    selectedRunId,
    eventOffset,
    impactOffset,
    pathOffset,
    location.eventSequence,
    location.entityType,
    location.entityId,
    focusRequest,
  ].join("\0")
  const [state, setState] = useState<LoadState | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchReplay(
      token,
      {
        runId: selectedRunId ?? undefined,
        eventOffset,
        impactOffset,
        pathOffset,
        ...location,
      },
      controller.signal
    ).then(
      (replay) => {
        if (!controller.signal.aborted)
          setState({ requestKey, status: "ready", replay })
      },
      (error: ReplayError) => {
        if (!controller.signal.aborted)
          setState({ requestKey, status: "error", error })
      }
    )
    return () => controller.abort()
  }, [
    eventOffset,
    impactOffset,
    location,
    pathOffset,
    requestKey,
    selectedRunId,
    token,
  ])

  if (state === null || state.requestKey !== requestKey)
    return <ReplayLoading />
  if (state.status === "error") return <ReplayFailure error={state.error} />
  if (state.replay.run_id === null)
    return (
      <main className="mx-auto w-full max-w-[90rem] px-5 py-7 lg:px-8 lg:py-9">
        <Empty className="border bg-background">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClockIcon />
            </EmptyMedia>
            <EmptyTitle>No replay is recorded</EmptyTitle>
            <EmptyDescription>
              Start a Production Run to record Concept formation and impact
              history.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    )

  return (
    <ReplayContent
      key={`${state.replay.run_id}:${state.replay.event_bounds.offset}:${state.replay.located_event_sequence ?? "page"}`}
      replay={state.replay}
      focusRequest={focusRequest}
      onBack={onBack}
      onEventOffsetChange={(offset) => {
        setFocusRequest(null)
        setLocation({})
        setEventOffset(offset)
      }}
      onImpactOffsetChange={setImpactOffset}
      onPathOffsetChange={setPathOffset}
      onLocateEvent={(eventSequence) => {
        locateNonce.current += 1
        setFocusRequest(locateNonce.current)
        setEventOffset(0)
        setLocation({ eventSequence })
      }}
      onLocateEntity={(entityType, entityId) => {
        locateNonce.current += 1
        setFocusRequest(locateNonce.current)
        setEventOffset(0)
        setLocation({ entityType, entityId })
      }}
    />
  )
}

function ReplayContent({
  replay,
  focusRequest,
  onBack,
  onEventOffsetChange,
  onImpactOffsetChange,
  onPathOffsetChange,
  onLocateEvent,
  onLocateEntity,
}: {
  replay: ReplaySnapshot
  focusRequest: number | null
  onBack: () => void
  onEventOffsetChange: (offset: number) => void
  onImpactOffsetChange: (offset: number) => void
  onPathOffsetChange: (offset: number) => void
  onLocateEvent: (sequence: number) => void
  onLocateEntity: (entityType: ReplayEntityType, entityId: string) => void
}) {
  const [playing, setPlaying] = useState(false)
  const focusedEvent = useRef<HTMLElement>(null)
  const staticEvent = useRef<HTMLLIElement>(null)
  const focusAfterJump = useRef(false)
  const [sequenceQuery, setSequenceQuery] = useState("")
  const [entityTypeQuery, setEntityTypeQuery] =
    useState<ReplayEntityType>("claim")
  const [entityQuery, setEntityQuery] = useState("")
  const events = replay.events
  const [currentIndex, setCurrentIndex] = useState(() => {
    const locatedIndex =
      replay.located_event_sequence === null
        ? -1
        : events.findIndex(
            (event) => event.sequence === replay.located_event_sequence
          )
    return locatedIndex < 0 ? 0 : locatedIndex
  })
  const current = events[currentIndex]

  useEffect(() => {
    if (!playing) return
    if (currentIndex >= events.length - 1) return
    const nextIndex = currentIndex + 1
    const timeout = window.setTimeout(() => {
      setCurrentIndex(nextIndex)
      if (nextIndex >= events.length - 1) setPlaying(false)
    }, 900)
    return () => window.clearTimeout(timeout)
  }, [currentIndex, events.length, playing])

  useEffect(() => {
    if (focusRequest === null) return
    const target = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? staticEvent
      : focusedEvent
    target.current?.focus()
  }, [focusRequest])

  useEffect(() => {
    if (!focusAfterJump.current) return
    focusAfterJump.current = false
    focusedEvent.current?.focus()
  }, [currentIndex])

  const entities = useMemo(
    () => [
      ...new Map(events.map((event) => [entityLocator(event), event])).values(),
    ],
    [events]
  )
  const selectIndex = useCallback(
    (index: number, focus = false) => {
      if (index < 0 || index >= events.length) return
      focusAfterJump.current = focus
      setPlaying(false)
      setCurrentIndex(index)
    },
    [events.length]
  )
  const togglePlaying = useCallback(() => {
    if (playing) {
      setPlaying(false)
      return
    }
    if (events.length < 2) return
    if (currentIndex >= events.length - 1) setCurrentIndex(0)
    setPlaying(true)
  }, [currentIndex, events.length, playing])
  const handleKeyboard = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget || events.length === 0) return
      if (event.key === "ArrowLeft") selectIndex(Math.max(0, currentIndex - 1))
      else if (event.key === "ArrowRight")
        selectIndex(Math.min(events.length - 1, currentIndex + 1))
      else if (event.key === "Home") selectIndex(0)
      else if (event.key === "End") selectIndex(events.length - 1)
      else if (event.key === " ") togglePlaying()
      else return
      event.preventDefault()
    },
    [currentIndex, events.length, selectIndex, togglePlaying]
  )

  return (
    <main className="mx-auto flex w-full max-w-[90rem] flex-col gap-6 px-5 py-7 lg:px-8 lg:py-9">
      <section
        className="flex flex-col gap-3 border-b pb-6"
        aria-labelledby="replay-title"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            Back to Concepts
          </Button>
          <Badge variant="outline">Run {replay.run_id}</Badge>
          <Badge variant="secondary">
            {titleCase(replay.run_state ?? "unknown")}
          </Badge>
          <Badge variant="outline">
            {replay.lineage_run_ids.length} lineage runs
          </Badge>
        </div>
        <div>
          <h1
            id="replay-title"
            className="text-3xl font-semibold tracking-tight"
          >
            Concept and impact replay
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Recorded state transitions in persisted sequence. Motion
            communicates progress only; it never supplies ordering, rationale,
            or hidden model reasoning.
          </p>
        </div>
      </section>

      <StageLegend />

      <Card>
        <CardHeader>
          <CardTitle>Jump across recorded history</CardTitle>
          <CardDescription>
            The Python control plane locates the bounded server page containing
            an exact persisted sequence or entity identity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-4 md:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="global-event-sequence">
                Event sequence
              </FieldLabel>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  const sequence = Number(sequenceQuery)
                  if (Number.isInteger(sequence) && sequence > 0)
                    onLocateEvent(sequence)
                }}
              >
                <InputGroup>
                  <InputGroupInput
                    id="global-event-sequence"
                    type="number"
                    min={1}
                    value={sequenceQuery}
                    onChange={(event) => setSequenceQuery(event.target.value)}
                    placeholder="Persisted sequence"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton type="submit">Jump</InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </form>
            </Field>
            <Field>
              <FieldLabel htmlFor="global-entity-type">Entity type</FieldLabel>
              <NativeSelect
                id="global-entity-type"
                value={entityTypeQuery}
                onChange={(event) =>
                  setEntityTypeQuery(event.target.value as ReplayEntityType)
                }
                className="w-full"
              >
                {REPLAY_ENTITY_TYPES.map((entityType) => (
                  <NativeSelectOption key={entityType} value={entityType}>
                    {titleCase(entityType)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="global-entity-id">
                Entity identity
              </FieldLabel>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (entityQuery.trim())
                    onLocateEntity(entityTypeQuery, entityQuery.trim())
                }}
              >
                <InputGroup>
                  <InputGroupInput
                    id="global-entity-id"
                    value={entityQuery}
                    onChange={(event) => setEntityQuery(event.target.value)}
                    placeholder="Claim, Concept, candidate, or Run ID"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton type="submit">Jump</InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </form>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      {events.length === 0 ? (
        <Empty className="border bg-background">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClockIcon />
            </EmptyMedia>
            <EmptyTitle>No replay events on this page</EmptyTitle>
            <EmptyDescription>
              Recorded impact remains available below.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <section
            role="region"
            aria-label="Replay keyboard controls"
            tabIndex={0}
            onKeyDown={handleKeyboard}
            className="focus-visible:rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:hidden"
          >
            <Card>
              <CardHeader>
                <CardTitle>
                  Recorded event {replay.event_bounds.offset + currentIndex + 1}
                </CardTitle>
                <CardDescription>
                  Space plays or pauses. Arrow keys step. Home and End jump to
                  page bounds.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Previous event"
                    disabled={currentIndex === 0}
                    onClick={() => selectIndex(currentIndex - 1)}
                  >
                    <ArrowLeftIcon />
                  </Button>
                  <Button
                    aria-label={playing ? "Pause replay" : "Play replay"}
                    onClick={togglePlaying}
                  >
                    {playing ? (
                      <PauseIcon data-icon="inline-start" />
                    ) : (
                      <PlayIcon data-icon="inline-start" />
                    )}
                    {playing ? "Pause" : "Play"}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Next event"
                    disabled={currentIndex === events.length - 1}
                    onClick={() => selectIndex(currentIndex + 1)}
                  >
                    <ArrowRightIcon />
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {currentIndex + 1} / {events.length} on this page
                  </p>
                </div>
                <Slider
                  aria-label="Replay position"
                  value={currentIndex}
                  min={0}
                  max={Math.max(0, events.length - 1)}
                  step={1}
                  onValueChange={(value) =>
                    selectIndex(Array.isArray(value) ? value[0] : value)
                  }
                />
                <CurrentEvent event={current} eventRef={focusedEvent} />
                <FieldGroup className="grid gap-4 md:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="replay-event-jump">
                      Jump within page to event
                    </FieldLabel>
                    <NativeSelect
                      id="replay-event-jump"
                      value={String(currentIndex)}
                      onChange={(event) =>
                        selectIndex(Number(event.target.value), true)
                      }
                      className="w-full"
                    >
                      {events.map((event, index) => (
                        <NativeSelectOption
                          key={event.sequence}
                          value={String(index)}
                        >
                          #{event.sequence} · {stageLabels[event.stage]} ·{" "}
                          {event.entity_label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="replay-entity-jump">
                      Jump within page to entity
                    </FieldLabel>
                    <NativeSelect
                      id="replay-entity-jump"
                      value={entityLocator(current)}
                      onChange={(event) =>
                        selectIndex(
                          events.findIndex(
                            (item) => entityLocator(item) === event.target.value
                          ),
                          true
                        )
                      }
                      className="w-full"
                    >
                      {entities.map((event) => (
                        <NativeSelectOption
                          key={entityLocator(event)}
                          value={entityLocator(event)}
                        >
                          {titleCase(event.entity_type)} · {event.entity_label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                </FieldGroup>
              </CardContent>
              <CardFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                <Button
                  className={paginationButtonClassName}
                  variant="outline"
                  disabled={replay.event_bounds.previous_offset === null}
                  onClick={() =>
                    replay.event_bounds.previous_offset !== null &&
                    onEventOffsetChange(replay.event_bounds.previous_offset)
                  }
                >
                  Previous history page
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  {replay.event_bounds.total} recorded replay events
                </p>
                <Button
                  className={paginationButtonClassName}
                  variant="outline"
                  disabled={replay.event_bounds.next_offset === null}
                  onClick={() =>
                    replay.event_bounds.next_offset !== null &&
                    onEventOffsetChange(replay.event_bounds.next_offset)
                  }
                >
                  Next history page
                </Button>
              </CardFooter>
            </Card>
          </section>

          <Card className="hidden motion-reduce:flex">
            <CardHeader>
              <CardTitle>
                <h2>Ordered replay (reduced motion)</h2>
              </CardTitle>
              <CardDescription>
                The same persisted sequence is presented without playback
                transitions.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-3">
                {events.map((event, index) => (
                  <li
                    key={event.sequence}
                    ref={index === currentIndex ? staticEvent : undefined}
                    tabIndex={index === currentIndex ? -1 : undefined}
                    aria-current={index === currentIndex ? "step" : undefined}
                    aria-label={
                      index === currentIndex
                        ? `Current reduced-motion replay event: ${titleCase(event.entity_type)} ${event.entity_id}`
                        : undefined
                    }
                    data-testid="reduced-replay-event"
                    className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">#{event.sequence}</Badge>
                      <StageBadge stage={event.stage} />
                      <Badge variant="outline">
                        {titleCase(event.entity_type)}
                      </Badge>
                    </div>
                    <p className="text-sm font-medium break-words">
                      {event.entity_label}
                    </p>
                    <p className="font-mono text-xs break-all text-muted-foreground">
                      {event.entity_id}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {event.previous_state
                        ? `${titleCase(event.previous_state)} → `
                        : ""}
                      {titleCase(event.state)} · {formatDate(event.occurred_at)}
                    </p>
                  </li>
                ))}
              </ol>
            </CardContent>
            <CardFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Button
                className={paginationButtonClassName}
                variant="outline"
                disabled={replay.event_bounds.previous_offset === null}
                onClick={() =>
                  replay.event_bounds.previous_offset !== null &&
                  onEventOffsetChange(replay.event_bounds.previous_offset)
                }
              >
                Previous history page
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                {replay.event_bounds.total} recorded replay events
              </p>
              <Button
                className={paginationButtonClassName}
                variant="outline"
                disabled={replay.event_bounds.next_offset === null}
                onClick={() =>
                  replay.event_bounds.next_offset !== null &&
                  onEventOffsetChange(replay.event_bounds.next_offset)
                }
              >
                Next history page
              </Button>
            </CardFooter>
          </Card>
        </>
      )}

      <ImpactPanel
        replay={replay}
        onOffsetChange={onImpactOffsetChange}
        onPathOffsetChange={onPathOffsetChange}
      />

      <ol className="sr-only" aria-label="Persisted replay order">
        {events.map((event) => (
          <li key={event.sequence}>
            {event.sequence} {stageLabels[event.stage]} {event.entity_label}
          </li>
        ))}
      </ol>
    </main>
  )
}

function CurrentEvent({
  event,
  eventRef,
}: {
  event: ReplayEvent
  eventRef: RefObject<HTMLElement | null>
}) {
  return (
    <article
      ref={eventRef}
      tabIndex={-1}
      aria-label="Current replay event"
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-muted/20 p-4 transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StageBadge stage={event.stage} />
        <Badge variant="outline">#{event.sequence}</Badge>
        <Badge variant="outline">{titleCase(event.entity_type)}</Badge>
      </div>
      <div className="min-w-0">
        <p className="text-base font-medium break-words">
          {event.entity_label}
        </p>
        <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
          {event.entity_id}
        </p>
      </div>
      <p
        role="status"
        aria-label="Current replay event status"
        aria-live="polite"
        aria-atomic="true"
        className="text-sm"
      >
        {stageLabels[event.stage]} · {event.entity_label} ·{" "}
        {titleCase(event.state)}
      </p>
      <p className="text-xs text-muted-foreground">
        {formatDate(event.occurred_at)} · persisted sequence {event.sequence}
      </p>
    </article>
  )
}

function StageLegend() {
  return (
    <section
      aria-labelledby="stage-legend-title"
      className="flex flex-col gap-3"
    >
      <div>
        <h2 id="stage-legend-title" className="text-base font-semibold">
          Recorded stages
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Stage labels classify persisted candidate, entity, and Run Events.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {REPLAY_STAGES.map((stage) => (
          <StageBadge key={stage} stage={stage} />
        ))}
      </div>
    </section>
  )
}

function StageBadge({ stage }: { stage: ReplayStage }) {
  const Icon =
    stage === "accepted" || stage === "published"
      ? CircleCheckIcon
      : stage === "rejected"
        ? CircleAlertIcon
        : stage === "stale"
          ? ClockIcon
          : stage === "verified"
            ? GitCompareArrowsIcon
            : CircleDotIcon
  return (
    <Badge
      variant={
        stage === "rejected"
          ? "destructive"
          : stage === "accepted" || stage === "published"
            ? "secondary"
            : "outline"
      }
    >
      <Icon data-icon="inline-start" />
      {stageLabels[stage]}
    </Badge>
  )
}

function ImpactPanel({
  replay,
  onOffsetChange,
  onPathOffsetChange,
}: {
  replay: ReplaySnapshot
  onOffsetChange: (offset: number) => void
  onPathOffsetChange: (offset: number) => void
}) {
  const { impact } = replay
  const [currentStageIndex, setCurrentStageIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const changes = impact.nodes.filter((node) => node.type === "source_unit")
  const affected = impact.nodes.filter((node) => node.status === "affected")
  const stable = impact.nodes.filter((node) => node.status === "stable")
  const nodes = new Map(impact.nodes.map((node) => [node.id, node]))

  useEffect(() => {
    if (!playing || currentStageIndex >= impactStageTypes.length - 1) return
    const nextIndex = currentStageIndex + 1
    const timeout = window.setTimeout(() => {
      setCurrentStageIndex(nextIndex)
      if (nextIndex >= impactStageTypes.length - 1) setPlaying(false)
    }, 900)
    return () => window.clearTimeout(timeout)
  }, [currentStageIndex, playing])

  const selectStage = (index: number) => {
    if (index < 0 || index >= impactStageTypes.length) return
    setPlaying(false)
    setCurrentStageIndex(index)
  }

  const togglePlaying = () => {
    if (playing) {
      setPlaying(false)
      return
    }
    if (currentStageIndex >= impactStageTypes.length - 1)
      setCurrentStageIndex(0)
    setPlaying(true)
  }

  return (
    <section aria-labelledby="impact-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="impact-title" className="text-xl font-semibold">
            Source impact
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {impact.mode === "incremental"
              ? "Source Set refresh diff plus persisted Source → Evidence → Claim → Concept → Bundle relations. Unaffected knowledge remains stable."
              : impact.fallback_reason
                ? "Full analysis marks downstream knowledge affected because the recorded refresh could not preserve a safe stable boundary."
                : "Full analysis marks accepted downstream knowledge affected; no incremental stable boundary is claimed."}
          </p>
        </div>
        <Badge
          variant={impact.mode === "incremental" ? "secondary" : "outline"}
        >
          {impact.mode === "incremental"
            ? "Incremental analysis"
            : "Full analysis"}
        </Badge>
      </div>
      {impact.fallback_reason && (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>Full analysis fallback recorded</AlertTitle>
          <AlertDescription>{impact.fallback_reason}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Source Unit changes</CardTitle>
          <CardDescription>
            Persisted refresh classifications, not visual guesses.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(["changed", "moved", "added", "removed"] as const).map(
              (status) => (
                <div key={status} className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">
                    {titleCase(status)}
                  </dt>
                  <dd className="mt-1 text-lg font-semibold">
                    {impact.summary.changes[status]}
                  </dd>
                </div>
              )
            )}
          </dl>
          {changes.length > 0 && (
            <ul className="grid gap-3 lg:grid-cols-2">
              {changes.map((node) => (
                <li key={node.id} className="min-w-0 rounded-lg border p-3">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{titleCase(node.status)}</Badge>
                    <Badge variant="outline">
                      {node.before?.source_id ?? node.after?.source_id}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm font-medium break-words">
                    {node.label}
                  </p>
                  {node.before &&
                    node.after &&
                    node.before.path !== node.after.path && (
                      <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                        {node.before.path} → {node.after.path}
                      </p>
                    )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <ImpactGroup
          title="Affected knowledge"
          nodes={affected}
          variant="affected"
        />
        <ImpactGroup
          title={
            impact.mode === "full"
              ? "Stable boundary unavailable"
              : "Stable knowledge"
          }
          nodes={stable}
          variant="stable"
          fullAnalysis={impact.mode === "full"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Downstream propagation paths</CardTitle>
          <CardDescription>
            Every bounded row preserves one complete persisted Source Unit →
            Evidence Reference → Claim → Concept → Bundle page path, including
            stable relocation paths.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {impact.paths.length > 0 && (
            <>
              <div className="flex flex-col gap-4 motion-reduce:hidden">
                <p className="text-sm text-muted-foreground">
                  This control reveals persisted Knowledge Impact Graph
                  topology. It does not replay model reasoning or Run Event
                  time.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Previous impact stage"
                    disabled={currentStageIndex === 0}
                    onClick={() => selectStage(currentStageIndex - 1)}
                  >
                    <ArrowLeftIcon />
                  </Button>
                  <Button
                    aria-label={
                      playing
                        ? "Pause impact propagation"
                        : "Play impact propagation"
                    }
                    onClick={togglePlaying}
                  >
                    {playing ? (
                      <PauseIcon data-icon="inline-start" />
                    ) : (
                      <PlayIcon data-icon="inline-start" />
                    )}
                    {playing ? "Pause" : "Play"}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Next impact stage"
                    disabled={currentStageIndex === impactStageTypes.length - 1}
                    onClick={() => selectStage(currentStageIndex + 1)}
                  >
                    <ArrowRightIcon />
                  </Button>
                </div>
                <Slider
                  aria-label="Impact propagation position"
                  value={currentStageIndex}
                  min={0}
                  max={impactStageTypes.length - 1}
                  step={1}
                  onValueChange={(value) =>
                    selectStage(Array.isArray(value) ? value[0] : value)
                  }
                />
                <p
                  role="status"
                  aria-label="Current impact propagation stage"
                  aria-live="polite"
                  aria-atomic="true"
                  className="text-sm"
                >
                  Current impact stage {currentStageIndex + 1} of{" "}
                  {impactStageTypes.length}:{" "}
                  {impactTypeLabels[impactStageTypes[currentStageIndex]]}
                </p>
                <ol
                  aria-label="Impact propagation stages"
                  className="grid gap-2 sm:grid-cols-5"
                >
                  {impactStageTypes.map((stage, index) => (
                    <li
                      key={stage}
                      aria-label={`${impactTypeLabels[stage]} impact stage`}
                      aria-current={
                        index === currentStageIndex ? "step" : undefined
                      }
                    >
                      <Badge
                        className="w-full justify-center"
                        variant={
                          index === currentStageIndex ? "secondary" : "outline"
                        }
                      >
                        {impactTypeLabels[stage]}
                      </Badge>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="hidden flex-col gap-3 motion-reduce:flex">
                <p className="text-sm text-muted-foreground">
                  All five persisted Knowledge Impact Graph stages are shown at
                  once without playback. This is topology, not model reasoning
                  or event time.
                </p>
                <ol
                  aria-label="Impact propagation stages (reduced motion)"
                  className="grid gap-2 sm:grid-cols-5"
                >
                  {impactStageTypes.map((stage) => (
                    <li key={stage}>
                      <Badge
                        className="w-full justify-center"
                        variant="outline"
                      >
                        {impactTypeLabels[stage]}
                      </Badge>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}
          {impact.paths.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No safely explainable downstream path is recorded on this page.
            </p>
          ) : (
            <ol className="flex flex-col gap-3">
              {impact.paths.map((path) => (
                <li key={path.id} className="rounded-lg border p-3">
                  <ol className="grid min-w-0 gap-2 sm:grid-cols-5">
                    {(
                      [
                        path.source,
                        path.evidence,
                        path.claim,
                        path.concept,
                        path.page,
                      ] as const
                    ).map((item) => {
                      const stageIndex = impactStageTypes.indexOf(item.type)
                      const state =
                        stageIndex < currentStageIndex
                          ? "revealed"
                          : stageIndex === currentStageIndex
                            ? "current"
                            : "pending"
                      return (
                        <li
                          key={item.id}
                          data-testid={`impact-path-stage-${item.type}`}
                          data-state={state}
                          className={cn(
                            "min-w-0 rounded-lg bg-muted/30 p-2 transition-[opacity,visibility]",
                            state === "pending" && "invisible opacity-0",
                            state === "current" && "ring-2 ring-ring/50",
                            "motion-reduce:visible motion-reduce:opacity-100 motion-reduce:ring-0 motion-reduce:transition-none"
                          )}
                        >
                          <Badge variant="outline">
                            {impactTypeLabels[item.type]}
                          </Badge>
                          <Badge
                            className="ml-1"
                            variant={
                              item.status === "stable" ? "secondary" : "outline"
                            }
                          >
                            {titleCase(item.status)}
                          </Badge>
                          <p className="mt-2 text-xs font-medium break-words">
                            {item.label}
                          </p>
                          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                            {item.entity_id}
                          </p>
                        </li>
                      )
                    })}
                  </ol>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button
            className={paginationButtonClassName}
            variant="outline"
            disabled={impact.path_bounds.previous_offset === null}
            onClick={() =>
              impact.path_bounds.previous_offset !== null &&
              onPathOffsetChange(impact.path_bounds.previous_offset)
            }
          >
            Previous path page
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {impact.path_bounds.total} complete paths
          </p>
          <Button
            className={paginationButtonClassName}
            variant="outline"
            disabled={impact.path_bounds.next_offset === null}
            onClick={() =>
              impact.path_bounds.next_offset !== null &&
              onPathOffsetChange(impact.path_bounds.next_offset)
            }
          >
            Next path page
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Persisted propagation relations</CardTitle>
          <CardDescription>
            Only relations whose endpoints are present on this bounded impact
            page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {impact.edges.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No visible relations on this page.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {impact.edges.map((edge) => (
                <li
                  key={edge.id}
                  className="min-w-0 rounded-lg border p-3 text-sm"
                >
                  <span className="break-words">
                    {nodes.get(edge.source)?.label}
                  </span>{" "}
                  <Badge variant="outline">{titleCase(edge.relation)}</Badge>{" "}
                  <span className="break-words">
                    {nodes.get(edge.target)?.label}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button
            className={paginationButtonClassName}
            variant="outline"
            disabled={impact.bounds.previous_offset === null}
            onClick={() =>
              impact.bounds.previous_offset !== null &&
              onOffsetChange(impact.bounds.previous_offset)
            }
          >
            Previous impact page
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {impact.bounds.total_nodes} nodes · {impact.bounds.total_edges}{" "}
            relations
          </p>
          <Button
            className={paginationButtonClassName}
            variant="outline"
            disabled={impact.bounds.next_offset === null}
            onClick={() =>
              impact.bounds.next_offset !== null &&
              onOffsetChange(impact.bounds.next_offset)
            }
          >
            Next impact page
          </Button>
        </CardFooter>
      </Card>
    </section>
  )
}

function ImpactGroup({
  title,
  nodes,
  variant,
  fullAnalysis = false,
}: {
  title: string
  nodes: ImpactNode[]
  variant: "affected" | "stable"
  fullAnalysis?: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {variant === "affected"
            ? "Requires reverification or rerendering in the recorded refresh plan."
            : fullAnalysis
              ? "Full analysis does not claim that downstream knowledge remained stable."
              : "Explicitly preserved by the recorded impact plan."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {nodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {fullAnalysis
              ? "No stable boundary is claimed for this full analysis."
              : `No ${variant} nodes on this page.`}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {nodes.map((node) => (
              <li
                key={node.id}
                className={cn(
                  "flex min-w-0 items-start justify-between gap-3 rounded-lg border p-3",
                  variant === "stable" && "bg-muted/20"
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium break-words">
                    {node.label}
                  </p>
                  <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                    {node.entity_id}
                  </p>
                </div>
                <Badge variant={variant === "stable" ? "secondary" : "outline"}>
                  {impactTypeLabels[node.type]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function ReplayLoading() {
  return (
    <main
      className="mx-auto flex w-full max-w-[90rem] flex-col gap-6 px-5 py-7 lg:px-8 lg:py-9"
      aria-busy="true"
    >
      <span className="sr-only" role="status">
        Loading replay
      </span>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-80 w-full" />
      <Skeleton className="h-96 w-full" />
    </main>
  )
}

function ReplayFailure({ error }: { error: ReplayError }) {
  return (
    <main className="mx-auto w-full max-w-[90rem] px-5 py-7 lg:px-8 lg:py-9">
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Replay unavailable</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    </main>
  )
}
