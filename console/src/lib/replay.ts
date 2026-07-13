export const REPLAY_STAGES = [
  "proposed",
  "verified",
  "accepted",
  "rejected",
  "stale",
  "published",
] as const

const EVENT_ENTITY_TYPES = [
  "verification_candidate",
  "claim",
  "concept",
  "production_run",
] as const
const IMPACT_TYPES = [
  "source_unit",
  "evidence",
  "claim",
  "concept",
  "page",
] as const
const IMPACT_STATUSES = [
  "added",
  "changed",
  "moved",
  "removed",
  "affected",
  "stable",
] as const
const IMPACT_RELATIONS = ["contains", "grounds", "forms", "renders"] as const
const SHA256 = /^sha256:[0-9a-f]{64}$/
const EVIDENCE_ID = /^evidence:[0-9a-f]{64}$/
const CLAIM_ID = /^claim:[0-9a-f]{64}$/
const CONCEPT_ID = /^concept:[0-9a-f]{64}$/
const MAX_EVENTS = 100
const MAX_IMPACT_NODES = 200
const MAX_IMPACT_EDGES = 200
const MAX_TEXT = 2_000

export type ReplayStage = (typeof REPLAY_STAGES)[number]
export type ReplayEvent = {
  run_id: string
  sequence: number
  occurred_at: string
  stage: ReplayStage
  entity_type: (typeof EVENT_ENTITY_TYPES)[number]
  entity_id: string
  entity_label: string
  previous_state: string | null
  state: string
  candidate_id: string | null
}

export type ReplayBounds = {
  limit: number
  offset: number
  previous_offset: number | null
  next_offset: number | null
  total: number
  truncated: boolean
}

export type ImpactUnit = {
  id: string
  source_id: string
  revision: string
  path: string
  kind: string
  digest: string | null
  label: string | null
}

export type ImpactNode = {
  id: string
  entity_id: string
  type: (typeof IMPACT_TYPES)[number]
  label: string
  status: (typeof IMPACT_STATUSES)[number]
  before: ImpactUnit | null
  after: ImpactUnit | null
}

export type ImpactEdge = {
  id: string
  source: string
  target: string
  relation: (typeof IMPACT_RELATIONS)[number]
}

type ImpactPathItem = Pick<ImpactNode, "id" | "entity_id" | "type" | "label">

export type ImpactPath = {
  id: string
  source: ImpactPathItem & { type: "source_unit" }
  evidence: ImpactPathItem & { type: "evidence" }
  claim: ImpactPathItem & { type: "claim" }
  concept: ImpactPathItem & { type: "concept" }
  page: ImpactPathItem & { type: "page" }
}

type ImpactCounts = {
  evidence: number
  claims: number
  concepts: number
  pages: number
}

export type ImpactSnapshot = {
  mode: "incremental" | "full"
  fallback_reason: string | null
  summary: {
    changes: { added: number; changed: number; moved: number; removed: number }
    affected: ImpactCounts
    stable: ImpactCounts
  }
  nodes: ImpactNode[]
  edges: ImpactEdge[]
  paths: ImpactPath[]
  path_bounds: ReplayBounds
  bounds: {
    limit: number
    offset: number
    previous_offset: number | null
    next_offset: number | null
    total_nodes: number
    total_edges: number
    truncated: boolean
  }
}

export type ReplaySnapshot = {
  ok: true
  run_id: string | null
  run_state: string | null
  lineage_run_ids: string[]
  events: ReplayEvent[]
  located_event_sequence: number | null
  event_bounds: ReplayBounds
  impact: ImpactSnapshot
}

export type ReplayError = { kind: "invalid" | "server"; message: string }

export async function fetchReplay(
  token: string,
  options: {
    runId?: string
    eventLimit?: number
    eventOffset?: number
    impactLimit?: number
    impactOffset?: number
    pathLimit?: number
    pathOffset?: number
    eventSequence?: number
    entityId?: string
  } = {},
  signal?: AbortSignal
): Promise<ReplaySnapshot> {
  const query = new URLSearchParams({
    event_limit: String(options.eventLimit ?? 50),
    event_offset: String(options.eventOffset ?? 0),
    impact_limit: String(options.impactLimit ?? 100),
    impact_offset: String(options.impactOffset ?? 0),
    path_limit: String(options.pathLimit ?? 50),
    path_offset: String(options.pathOffset ?? 0),
  })
  if (options.runId) query.set("run_id", options.runId)
  if (options.eventSequence !== undefined)
    query.set("event_sequence", String(options.eventSequence))
  if (options.entityId) query.set("entity_id", options.entityId)
  let response: Response
  try {
    response = await fetch(`/api/v1/replay?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })
  } catch {
    throw {
      kind: "server",
      message:
        "The local service did not respond. Restart the Console and try again.",
    } satisfies ReplayError
  }
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw {
      kind: response.status < 500 ? "invalid" : "server",
      message:
        isRecord(payload) &&
        Array.isArray(payload.errors) &&
        typeof payload.errors[0] === "string"
          ? payload.errors[0]
          : "Replay could not be loaded.",
    } satisfies ReplayError
  }
  if (!isReplay(payload)) {
    throw {
      kind: "server",
      message: "The local service returned an invalid replay response.",
    } satisfies ReplayError
  }
  return payload
}

function isReplay(value: unknown): value is ReplaySnapshot {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !nullableString(value.run_id) ||
    !nullableString(value.run_state) ||
    !isBoundedStrings(value.lineage_run_ids, 10_000, 128) ||
    hasDuplicates(value.lineage_run_ids) ||
    !Array.isArray(value.events) ||
    !value.events.every(isReplayEvent) ||
    !nullablePositiveInteger(value.located_event_sequence) ||
    !isEventBounds(value.event_bounds) ||
    !isImpact(value.impact)
  )
    return false

  const events = value.events as ReplayEvent[]
  const bounds = value.event_bounds as ReplayBounds
  const lineage = new Set(value.lineage_run_ids as string[])
  if (
    value.run_id === null
      ? value.run_state !== null || lineage.size !== 0 || events.length !== 0
      : !lineage.has(value.run_id) ||
        events.some((event) => !lineage.has(event.run_id))
  )
    return false
  if (
    events.some(
      (event, index) =>
        index > 0 && event.sequence <= events[index - 1].sequence
    ) ||
    hasDuplicates(events.map((event) => event.sequence))
  )
    return false
  if (
    value.located_event_sequence !== null &&
    !events.some((event) => event.sequence === value.located_event_sequence)
  )
    return false
  const expectedLength = Math.min(
    bounds.limit,
    Math.max(0, bounds.total - bounds.offset)
  )
  const previous =
    bounds.offset > 0 ? Math.max(0, bounds.offset - bounds.limit) : null
  const next =
    bounds.offset + bounds.limit < bounds.total
      ? bounds.offset + bounds.limit
      : null
  return (
    events.length === expectedLength &&
    bounds.previous_offset === previous &&
    bounds.next_offset === next &&
    bounds.truncated === (bounds.offset > 0 || next !== null)
  )
}

function isReplayEvent(value: unknown): value is ReplayEvent {
  if (
    !isRecord(value) ||
    !nonEmptyBoundedString(value.run_id, 128) ||
    !positiveInteger(value.sequence) ||
    typeof value.occurred_at !== "string" ||
    Number.isNaN(Date.parse(value.occurred_at)) ||
    !includes(REPLAY_STAGES, value.stage) ||
    !includes(EVENT_ENTITY_TYPES, value.entity_type) ||
    !nonEmptyBoundedString(value.entity_id, MAX_TEXT) ||
    !nonEmptyBoundedString(value.entity_label, MAX_TEXT) ||
    !nullableString(value.previous_state) ||
    !nonEmptyBoundedString(value.state, 64) ||
    !nullableString(value.candidate_id)
  )
    return false
  switch (value.stage) {
    case "proposed":
      return (
        value.entity_type === "verification_candidate" &&
        value.state === "staged" &&
        value.previous_state === null &&
        value.candidate_id === value.entity_id
      )
    case "verified":
      return (
        value.entity_type === "verification_candidate" &&
        ["accepted", "review_required", "revision_required"].includes(
          value.state
        ) &&
        value.previous_state === "staged" &&
        value.candidate_id === value.entity_id
      )
    case "rejected":
      return (
        value.entity_type === "verification_candidate" &&
        value.state === "rejected" &&
        value.previous_state === "staged" &&
        value.candidate_id === value.entity_id
      )
    case "accepted":
      return (
        nonEmptyBoundedString(value.candidate_id, 128) &&
        ((value.entity_type === "claim" &&
          CLAIM_ID.test(value.entity_id) &&
          ["supported", "disputed"].includes(value.state)) ||
          (value.entity_type === "concept" &&
            CONCEPT_ID.test(value.entity_id) &&
            ["active", "disputed"].includes(value.state)))
      )
    case "stale":
      return (
        value.candidate_id === null &&
        value.state === "stale" &&
        ((value.entity_type === "claim" && CLAIM_ID.test(value.entity_id)) ||
          (value.entity_type === "concept" && CONCEPT_ID.test(value.entity_id)))
      )
    case "published":
      return (
        value.entity_type === "production_run" &&
        value.entity_id === value.run_id &&
        value.state === "published" &&
        value.candidate_id === null
      )
  }
}

function isImpact(value: unknown): value is ImpactSnapshot {
  if (
    !isRecord(value) ||
    !["incremental", "full"].includes(String(value.mode)) ||
    !(
      value.fallback_reason === null ||
      nonEmptyBoundedString(value.fallback_reason, MAX_TEXT)
    ) ||
    (value.mode === "incremental" && value.fallback_reason !== null) ||
    !isImpactSummary(value.summary) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isImpactNode) ||
    !Array.isArray(value.edges) ||
    !value.edges.every(isImpactEdge) ||
    !Array.isArray(value.paths) ||
    !value.paths.every(isImpactPath) ||
    !isPageBounds(value.path_bounds, MAX_EVENTS) ||
    !isImpactBounds(value.bounds)
  )
    return false
  const nodes = value.nodes as ImpactNode[]
  const edges = value.edges as ImpactEdge[]
  const paths = value.paths as ImpactPath[]
  const pathBounds = value.path_bounds as ReplayBounds
  const bounds = value.bounds as ImpactSnapshot["bounds"]
  const summary = value.summary as ImpactSnapshot["summary"]
  if (
    hasDuplicates(nodes.map((node) => node.id)) ||
    hasDuplicates(edges.map((edge) => edge.id)) ||
    hasDuplicates(paths.map((path) => path.id)) ||
    (value.mode === "full" &&
      (Object.values(summary.stable).some((count) => count !== 0) ||
        nodes.some(
          (node) => node.type !== "source_unit" && node.status !== "affected"
        )))
  )
    return false
  const ids = new Set(nodes.map((node) => node.id))
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  if (
    edges.some(
      (edge) =>
        !ids.has(edge.source) ||
        !ids.has(edge.target) ||
        edge.id !== `${edge.source}|${edge.relation}|${edge.target}` ||
        !isSemanticImpactEdge(
          edge,
          nodesById.get(edge.source),
          nodesById.get(edge.target)
        )
    )
  )
    return false
  const expectedLength = Math.min(
    bounds.limit,
    Math.max(0, bounds.total_nodes - bounds.offset)
  )
  const previous =
    bounds.offset > 0 ? Math.max(0, bounds.offset - bounds.limit) : null
  const next =
    bounds.offset + bounds.limit < bounds.total_nodes
      ? bounds.offset + bounds.limit
      : null
  const expectedPaths = Math.min(
    pathBounds.limit,
    Math.max(0, pathBounds.total - pathBounds.offset)
  )
  const previousPath =
    pathBounds.offset > 0
      ? Math.max(0, pathBounds.offset - pathBounds.limit)
      : null
  const nextPath =
    pathBounds.offset + pathBounds.limit < pathBounds.total
      ? pathBounds.offset + pathBounds.limit
      : null
  return (
    nodes.length === expectedLength &&
    edges.length <= MAX_IMPACT_EDGES &&
    edges.length <= bounds.total_edges &&
    bounds.previous_offset === previous &&
    bounds.next_offset === next &&
    bounds.truncated ===
      (bounds.offset > 0 ||
        next !== null ||
        edges.length < bounds.total_edges) &&
    paths.length === expectedPaths &&
    pathBounds.previous_offset === previousPath &&
    pathBounds.next_offset === nextPath &&
    pathBounds.truncated === (pathBounds.offset > 0 || nextPath !== null)
  )
}

function isImpactPath(value: unknown): value is ImpactPath {
  if (!isRecord(value)) return false
  const stages = ["source", "evidence", "claim", "concept", "page"] as const
  const types = ["source_unit", "evidence", "claim", "concept", "page"] as const
  if (
    !stages.every((stage, index) =>
      isImpactPathItem(value[stage], types[index])
    )
  )
    return false
  const items = stages.map((stage) => value[stage] as ImpactPathItem)
  return (
    value.id === items.map((item) => item.id).join("|") &&
    /^source-unit:(changed|removed):/.test(items[0].id) &&
    items[0].id.endsWith(`:${items[0].entity_id}`) &&
    EVIDENCE_ID.test(items[1].id) &&
    items[1].id === items[1].entity_id &&
    CLAIM_ID.test(items[2].id) &&
    items[2].id === items[2].entity_id &&
    CONCEPT_ID.test(items[3].id) &&
    items[3].id === items[3].entity_id &&
    items[4].id === `page:${items[4].entity_id}`
  )
}

function isImpactPathItem(value: unknown, type: ImpactNode["type"]): boolean {
  return (
    isRecord(value) &&
    value.type === type &&
    nonEmptyBoundedString(value.id, MAX_TEXT) &&
    nonEmptyBoundedString(value.entity_id, MAX_TEXT) &&
    nonEmptyBoundedString(value.label, MAX_TEXT) &&
    Object.keys(value).length === 4
  )
}

function isSemanticImpactEdge(
  edge: ImpactEdge,
  source: ImpactNode | undefined,
  target: ImpactNode | undefined
) {
  if (!source || !target) return false
  return edge.relation === "contains"
    ? source.type === "source_unit" &&
        ["changed", "removed"].includes(source.status) &&
        target.type === "evidence" &&
        target.status === "affected"
    : edge.relation === "grounds"
      ? source.type === "evidence" && target.type === "claim"
      : edge.relation === "forms"
        ? source.type === "claim" && target.type === "concept"
        : source.type === "concept" && target.type === "page"
}

function isImpactNode(value: unknown): value is ImpactNode {
  if (
    !isRecord(value) ||
    !nonEmptyBoundedString(value.id, MAX_TEXT) ||
    !nonEmptyBoundedString(value.entity_id, MAX_TEXT) ||
    !includes(IMPACT_TYPES, value.type) ||
    !nonEmptyBoundedString(value.label, MAX_TEXT) ||
    !includes(IMPACT_STATUSES, value.status) ||
    !(value.before === null || isImpactUnit(value.before)) ||
    !(value.after === null || isImpactUnit(value.after))
  )
    return false
  if (value.type === "source_unit") {
    const unit = value.after ?? value.before
    if (
      !unit ||
      value.entity_id !== unit.id ||
      value.id !== `source-unit:${value.status}:${unit.id}`
    )
      return false
    return value.status === "added"
      ? value.before === null && value.after !== null
      : value.status === "removed"
        ? value.before !== null && value.after === null
        : ["changed", "moved"].includes(value.status) &&
          value.before !== null &&
          value.after !== null
  }
  if (
    !["affected", "stable"].includes(value.status) ||
    value.before !== null ||
    value.after !== null
  )
    return false
  return value.type === "evidence"
    ? value.id === value.entity_id && EVIDENCE_ID.test(value.id)
    : value.type === "claim"
      ? value.id === value.entity_id && CLAIM_ID.test(value.id)
      : value.type === "concept"
        ? value.id === value.entity_id && CONCEPT_ID.test(value.id)
        : value.id === `page:${value.entity_id}`
}

function isImpactUnit(value: unknown): value is ImpactUnit {
  return (
    isRecord(value) &&
    ["id", "source_id", "revision", "path", "kind"].every((key) =>
      nonEmptyBoundedString(value[key], MAX_TEXT)
    ) &&
    (value.digest === null ||
      (typeof value.digest === "string" && SHA256.test(value.digest))) &&
    (value.label === null || nonEmptyBoundedString(value.label, MAX_TEXT))
  )
}

function isImpactEdge(value: unknown): value is ImpactEdge {
  return (
    isRecord(value) &&
    nonEmptyBoundedString(value.id, MAX_TEXT) &&
    nonEmptyBoundedString(value.source, MAX_TEXT) &&
    nonEmptyBoundedString(value.target, MAX_TEXT) &&
    includes(IMPACT_RELATIONS, value.relation)
  )
}

function isImpactSummary(value: unknown) {
  return (
    isRecord(value) &&
    isCounts(value.changes, ["added", "changed", "moved", "removed"]) &&
    isCounts(value.affected, ["evidence", "claims", "concepts", "pages"]) &&
    isCounts(value.stable, ["evidence", "claims", "concepts", "pages"])
  )
}

function isCounts(value: unknown, keys: string[]) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => nonNegativeInteger(value[key]))
  )
}

function isEventBounds(value: unknown): value is ReplayBounds {
  return isPageBounds(value, MAX_EVENTS)
}

function isPageBounds(value: unknown, maximum: number): value is ReplayBounds {
  return (
    isRecord(value) &&
    integerBetween(value.limit, 1, maximum) &&
    nonNegativeInteger(value.offset) &&
    nullableNonNegativeInteger(value.previous_offset) &&
    nullableNonNegativeInteger(value.next_offset) &&
    nonNegativeInteger(value.total) &&
    typeof value.truncated === "boolean"
  )
}

function isImpactBounds(value: unknown): value is ImpactSnapshot["bounds"] {
  return (
    isRecord(value) &&
    integerBetween(value.limit, 1, MAX_IMPACT_NODES) &&
    nonNegativeInteger(value.offset) &&
    nullableNonNegativeInteger(value.previous_offset) &&
    nullableNonNegativeInteger(value.next_offset) &&
    nonNegativeInteger(value.total_nodes) &&
    nonNegativeInteger(value.total_edges) &&
    typeof value.truncated === "boolean"
  )
}

function includes<const T extends readonly string[]>(
  values: T,
  value: unknown
): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number])
}

function isBoundedStrings(
  value: unknown,
  maximumItems: number,
  maximumLength: number
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => nonEmptyBoundedString(item, maximumLength))
  )
}

function nonEmptyBoundedString(
  value: unknown,
  maximum: number
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Array.from(value).length <= maximum
  )
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function positiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0
}

function nullablePositiveInteger(value: unknown) {
  return value === null || positiveInteger(value)
}

function nonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0
}

function nullableNonNegativeInteger(value: unknown) {
  return value === null || nonNegativeInteger(value)
}

function integerBetween(value: unknown, minimum: number, maximum: number) {
  return (
    Number.isInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  )
}

function hasDuplicates(values: unknown[]) {
  return new Set(values).size !== values.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
