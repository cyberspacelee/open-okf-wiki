import { useEffect, useState } from "react"
import {
  ArchiveIcon,
  BanIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  ClockIcon,
  GitCompareArrowsIcon,
  NetworkIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
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
import { Field, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  PROVENANCE_FILTER_STATES,
  PROVENANCE_NODE_TYPES,
  fetchProvenance,
  type ProvenanceFilterState,
  type ProvenanceNode,
  type ProvenanceNodeType,
  type ProvenanceSnapshot,
} from "@/lib/provenance"
import { formatDate, titleCase } from "@/lib/runs"
import { cn } from "@/lib/utils"

const stageLabels: Record<ProvenanceNodeType, string> = {
  source_unit: "Source Unit",
  evidence: "Evidence Reference",
  claim: "Claim",
  verification: "Verification",
  concept: "Concept",
  page: "Bundle page",
}

const filterStateLabels: Record<ProvenanceFilterState, string> = {
  supported: "Supported",
  disputed: "Disputed",
  stale: "Stale",
  conflicting: "Conflicting",
  superseded: "Superseded",
  rejected: "Rejected",
  blocked: "Blocked",
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; snapshot: ProvenanceSnapshot }
  | { status: "error"; message: string }

export function ConceptsPage({ token }: { token: string }) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" })
  const [conceptId, setConceptId] = useState<string>()
  const [limit, setLimit] = useState(100)
  const [offset, setOffset] = useState(0)
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [types, setTypes] = useState<ProvenanceNodeType[]>([])
  const [states, setStates] = useState<ProvenanceFilterState[]>([])

  useEffect(() => {
    const controller = new AbortController()
    fetchProvenance(
      token,
      { conceptId, limit, offset, types, states },
      controller.signal
    ).then(
      (snapshot) => {
        if (!controller.signal.aborted) setLoad({ status: "ready", snapshot })
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setLoad({
            status: "error",
            message:
              typeof error === "object" &&
              error !== null &&
              "message" in error &&
              typeof error.message === "string"
                ? error.message
                : "Concept provenance could not be loaded.",
          })
      }
    )
    return () => controller.abort()
  }, [conceptId, limit, offset, states, token, types])

  if (load.status === "loading") return <ConceptsLoading />
  if (load.status === "error")
    return (
      <main className="mx-auto w-full max-w-[90rem] px-5 py-7 lg:px-8 lg:py-9">
        <Alert variant="destructive">
          <CircleXIcon />
          <AlertTitle>Concept provenance unavailable</AlertTitle>
          <AlertDescription>{load.message}</AlertDescription>
        </Alert>
      </main>
    )

  const { snapshot } = load
  if (snapshot.concepts.length === 0)
    return (
      <main className="mx-auto w-full max-w-[90rem] px-5 py-7 lg:px-8 lg:py-9">
        <Empty className="min-h-96 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <NetworkIcon />
            </EmptyMedia>
            <EmptyTitle>No Concepts yet</EmptyTitle>
            <EmptyDescription>
              Run semantic analysis and accept grounded knowledge before
              inspecting provenance.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    )

  return (
    <ConceptsReady
      snapshot={snapshot}
      conceptId={conceptId ?? snapshot.selected_concept_id ?? ""}
      selectedNodeId={selectedNodeId}
      types={types}
      states={states}
      onConceptChange={(next) => {
        setConceptId(next)
        setLimit(100)
        setOffset(0)
        setSelectedNodeId(undefined)
      }}
      onNodeSelect={setSelectedNodeId}
      onTypesChange={(next) => {
        setTypes(next)
        setOffset(0)
        setSelectedNodeId(undefined)
      }}
      onStatesChange={(next) => {
        setStates(next)
        setOffset(0)
        setSelectedNodeId(undefined)
      }}
      onShowMore={() => {
        setLimit(200)
        setOffset(0)
      }}
      onOffsetChange={setOffset}
    />
  )
}

function ConceptsReady({
  snapshot,
  conceptId,
  selectedNodeId,
  types,
  states,
  onConceptChange,
  onNodeSelect,
  onTypesChange,
  onStatesChange,
  onShowMore,
  onOffsetChange,
}: {
  snapshot: ProvenanceSnapshot
  conceptId: string
  selectedNodeId?: string
  types: ProvenanceNodeType[]
  states: ProvenanceFilterState[]
  onConceptChange: (value: string) => void
  onNodeSelect: (value: string) => void
  onTypesChange: (value: ProvenanceNodeType[]) => void
  onStatesChange: (value: ProvenanceFilterState[]) => void
  onShowMore: () => void
  onOffsetChange: (value: number) => void
}) {
  const visibleNodes = snapshot.nodes
  const visibleEdges = snapshot.edges
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const selectedNode = nodesById.get(selectedNodeId ?? conceptId)

  return (
    <main className="mx-auto flex w-full max-w-[90rem] min-w-0 flex-col gap-6 px-5 py-7 lg:px-8 lg:py-9">
      <header className="flex flex-col justify-between gap-4 border-b pb-6 lg:flex-row lg:items-end">
        <div className="min-w-0">
          <p className="mb-2 text-sm text-muted-foreground">
            Accepted Knowledge Model
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Concept provenance
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Persisted Source Units, Evidence References, Claims, verification
            decisions, Concepts, and Bundle pages. No model reasoning or
            inferred edges are shown.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">Run {snapshot.run_id}</Badge>
          <Badge variant="secondary">
            {titleCase(snapshot.run_state ?? "unknown")}
          </Badge>
        </div>
      </header>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Scope and filters</CardTitle>
              <CardDescription>
                No pressed filter means all values. Filters are applied before
                the server returns each bounded page.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Field orientation="horizontal">
                <FieldLabel htmlFor="concept-provenance-select">
                  Concept
                </FieldLabel>
                <NativeSelect
                  id="concept-provenance-select"
                  className="w-full sm:w-auto"
                  value={conceptId}
                  onChange={(event) => onConceptChange(event.target.value)}
                >
                  {snapshot.concepts.map((concept) => (
                    <NativeSelectOption key={concept.id} value={concept.id}>
                      {concept.name} · {titleCase(concept.status)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <FilterGroup
                label="Node types"
                values={types}
                options={PROVENANCE_NODE_TYPES}
                labelFor={(value) => stageLabels[value]}
                ariaPrefix="Filter"
                onChange={onTypesChange}
              />
              <FilterGroup
                label="Knowledge states"
                values={states}
                options={PROVENANCE_FILTER_STATES}
                labelFor={(value) => filterStateLabels[value]}
                ariaPrefix="Filter"
                onChange={onStatesChange}
              />
            </CardContent>
          </Card>

          <Card size="sm" className="min-w-0">
            <CardHeader>
              <CardTitle>Persisted provenance graph</CardTitle>
              <CardDescription>
                {visibleNodes.length} of {snapshot.bounds.filtered_total_nodes}{" "}
                filtered nodes · {visibleEdges.length} of{" "}
                {snapshot.bounds.filtered_total_edges} filtered edges loaded
              </CardDescription>
            </CardHeader>
            <CardContent className="min-w-0">
              <div
                className="max-w-full overflow-x-auto pb-2"
                tabIndex={0}
                aria-label="Provenance graph"
              >
                <ol className="grid min-w-max grid-cols-6 gap-3">
                  {PROVENANCE_NODE_TYPES.map((type) => (
                    <li key={type} className="w-52">
                      <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
                        {stageLabels[type]}
                      </h2>
                      <div className="flex flex-col gap-2">
                        {visibleNodes
                          .filter((node) => node.type === type)
                          .map((node) => (
                            <ProvenanceNodeButton
                              key={node.id}
                              node={node}
                              selected={selectedNode?.id === node.id}
                              onSelect={() => onNodeSelect(node.id)}
                            />
                          ))}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
              {visibleEdges.length > 0 && (
                <div
                  className="mt-5 flex flex-col gap-2"
                  aria-label="Persisted relationships"
                >
                  <h2 className="text-sm font-semibold">Relationships</h2>
                  <ul className="grid gap-2 text-xs sm:grid-cols-2">
                    {visibleEdges.map((edge) => (
                      <li
                        key={edge.id}
                        className="min-w-0 rounded-lg border px-3 py-2"
                      >
                        <span className="break-words">
                          {nodesById.get(edge.source)?.label}
                        </span>{" "}
                        <Badge variant="outline">
                          {titleCase(edge.relation)}
                        </Badge>{" "}
                        <span className="break-words">
                          {nodesById.get(edge.target)?.label}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {snapshot.bounds.truncated && snapshot.bounds.limit < 200 && (
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    Start with 100 authoritative nodes, then expand to the
                    maximum page size.
                  </p>
                  <Button variant="outline" size="sm" onClick={onShowMore}>
                    Show more
                  </Button>
                </div>
              )}
              {snapshot.bounds.limit === 200 &&
                (snapshot.bounds.previous_offset !== null ||
                  snapshot.bounds.next_offset !== null) && (
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      Showing {snapshot.bounds.offset + 1}–
                      {snapshot.bounds.offset + visibleNodes.length} of{" "}
                      {snapshot.bounds.filtered_total_nodes} filtered nodes
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={snapshot.bounds.previous_offset === null}
                        onClick={() =>
                          snapshot.bounds.previous_offset !== null &&
                          onOffsetChange(snapshot.bounds.previous_offset)
                        }
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={snapshot.bounds.next_offset === null}
                        onClick={() =>
                          snapshot.bounds.next_offset !== null &&
                          onOffsetChange(snapshot.bounds.next_offset)
                        }
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
            </CardContent>
          </Card>
        </div>

        <NodeDetails node={selectedNode} />
      </div>
    </main>
  )
}

function FilterGroup<T extends string>({
  label,
  values,
  options,
  labelFor,
  ariaPrefix,
  onChange,
}: {
  label: string
  values: T[]
  options: readonly T[]
  labelFor: (value: T) => string
  ariaPrefix: string
  onChange: (value: T[]) => void
}) {
  const id = `filter-${label.toLowerCase().replaceAll(" ", "-")}`
  return (
    <Field orientation="horizontal">
      <FieldLabel id={id}>{label}</FieldLabel>
      <ToggleGroup
        multiple
        aria-labelledby={id}
        value={values}
        onValueChange={(next) =>
          onChange(
            next.filter((value): value is T => options.includes(value as T))
          )
        }
        variant="outline"
        size="sm"
        className="max-w-full flex-wrap"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option}
            value={option}
            aria-label={`${ariaPrefix} ${labelFor(option).toLowerCase().replace(" reference", "").replace(" unit", "")}${option === "claim" ? "s" : ""}`}
          >
            {labelFor(option)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  )
}

function ProvenanceNodeButton({
  node,
  selected,
  onSelect,
}: {
  node: ProvenanceNode
  selected: boolean
  onSelect: () => void
}) {
  const descriptors = [...node.states, ...(node.role ? [node.role] : [])]
  return (
    <Button
      variant={selected ? "secondary" : "outline"}
      className="h-auto min-h-16 w-full min-w-0 flex-col items-start justify-start gap-2 px-3 py-2 text-left whitespace-normal"
      aria-label={`${node.label}${descriptors.length ? `, ${descriptors.join(", ")}` : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="line-clamp-3 break-all">{node.label}</span>
      <span className="flex flex-wrap gap-1">
        {node.role && <Badge variant="outline">{titleCase(node.role)}</Badge>}
        {node.states.map((state) => (
          <StateBadge key={state} state={state} />
        ))}
      </span>
    </Button>
  )
}

function StateBadge({ state }: { state: string }) {
  const Icon =
    state === "supported" || state === "accepted"
      ? CircleCheckIcon
      : state === "disputed"
        ? CircleHelpIcon
        : state === "stale"
          ? ClockIcon
          : state === "conflicting"
            ? GitCompareArrowsIcon
            : state === "superseded"
              ? ArchiveIcon
              : state === "blocked"
                ? BanIcon
                : CircleXIcon
  const variant =
    state === "conflicting" || state === "rejected"
      ? "destructive"
      : state === "supported" || state === "accepted"
        ? "secondary"
        : state === "superseded"
          ? "ghost"
          : "outline"
  return (
    <Badge variant={variant}>
      <Icon data-icon="inline-start" />
      {titleCase(state)}
    </Badge>
  )
}

function NodeDetails({ node }: { node?: ProvenanceNode }) {
  return (
    <Card
      size="sm"
      className="min-w-0 self-start xl:sticky xl:top-4"
      role="region"
      aria-label="Node details"
    >
      <CardHeader>
        <CardTitle>Node details</CardTitle>
        <CardDescription>
          Stable identity and persisted acceptance history for the selected
          node.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!node ? (
          <p className="text-sm text-muted-foreground">
            Select a visible node to inspect it.
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-5">
            <div className="flex flex-wrap gap-1">
              {node.states.map((state) => (
                <StateBadge key={state} state={state} />
              ))}
            </div>
            <dl className="flex min-w-0 flex-col gap-3 text-sm">
              <Detail label="Stable ID" value={node.stable_id} mono />
              <Detail label="Run" value={node.run_id} mono />
              <Detail label="Type" value={stageLabels[node.type]} />
              {node.role && (
                <Detail label="Claim role" value={titleCase(node.role)} />
              )}
              {node.candidate_id && (
                <Detail label="Candidate" value={node.candidate_id} mono />
              )}
              {node.revision && (
                <Detail label="Revision" value={node.revision} mono />
              )}
              {node.path && <Detail label="Path" value={node.path} mono />}
              {node.span && (
                <Detail
                  label="Span"
                  value={`L${node.span.start_line}–L${node.span.end_line}`}
                  mono
                />
              )}
              {node.digest && (
                <Detail label="Digest" value={node.digest} mono />
              )}
              {node.decision && (
                <Detail label="Decision" value={titleCase(node.decision)} />
              )}
            </dl>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Related events</h3>
              {node.events.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No entity events are linked.
                </p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {node.events.map((event) => (
                    <li
                      key={`${event.run_id}-${event.sequence}`}
                      className="rounded-lg border p-3 text-xs"
                    >
                      <p className="font-medium">
                        {event.previous_state
                          ? `${titleCase(event.previous_state)} → `
                          : ""}
                        {titleCase(event.state)}
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        {formatDate(event.occurred_at)}
                      </p>
                      <p className="mt-1 font-mono break-all text-muted-foreground">
                        {event.run_id} · {titleCase(event.entity_type)}
                      </p>
                      {event.candidate_id && (
                        <p className="mt-1 font-mono break-all text-muted-foreground">
                          {event.candidate_id}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            {node.metadata && "reason" in node.metadata && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Blocking reason</h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  {node.metadata.reason ?? "No reason recorded."}
                </p>
              </div>
            )}
            {node.metadata && "findings" in node.metadata && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">Decision reasons</h3>
                  {node.metadata.reasons.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No decision reasons recorded.
                    </p>
                  ) : (
                    <ul className="list-disc pl-5 text-xs leading-5 text-muted-foreground">
                      {node.metadata.reasons.map((reason, index) => (
                        <li key={`${index}-${reason}`}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">
                    Verification findings
                  </h3>
                  {node.metadata.findings.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No findings recorded.
                    </p>
                  ) : (
                    <ol className="flex flex-col gap-2">
                      {node.metadata.findings.map((finding, index) => (
                        <li
                          key={`${finding.perspective}-${index}`}
                          className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-xs"
                        >
                          <div className="flex flex-wrap gap-1">
                            <Badge variant="outline">
                              {titleCase(finding.perspective)}
                            </Badge>
                            <Badge
                              variant={
                                finding.severity === "critical" ||
                                finding.severity === "error"
                                  ? "destructive"
                                  : "secondary"
                              }
                            >
                              {titleCase(finding.verdict)} ·{" "}
                              {titleCase(finding.severity)}
                            </Badge>
                          </div>
                          <p className="font-mono break-all text-muted-foreground">
                            {titleCase(finding.target_type)} ·{" "}
                            {finding.target_id}
                          </p>
                          <p className="leading-5">{finding.rationale}</p>
                          <p className="font-mono break-all text-muted-foreground">
                            Evidence · {finding.evidence.join(", ")}
                          </p>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
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
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 break-all", mono && "font-mono text-xs")}>
        {value}
      </dd>
    </div>
  )
}

function ConceptsLoading() {
  return (
    <main
      className="mx-auto flex w-full max-w-[90rem] flex-col gap-6 px-5 py-7 lg:px-8 lg:py-9"
      aria-busy="true"
    >
      <span className="sr-only" role="status">
        Loading Concept provenance
      </span>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-96 w-full" />
    </main>
  )
}
