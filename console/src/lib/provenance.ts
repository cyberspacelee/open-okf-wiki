export const PROVENANCE_NODE_TYPES = [
  "source_unit",
  "evidence",
  "claim",
  "verification",
  "concept",
  "page",
] as const

export const PROVENANCE_FILTER_STATES = [
  "supported",
  "disputed",
  "stale",
  "conflicting",
  "superseded",
  "rejected",
  "blocked",
] as const

const CONCEPT_STATUSES = ["active", "disputed", "stale"] as const
const CLAIM_STATES = [
  "supported",
  "disputed",
  "stale",
  "conflicting",
  "superseded",
] as const
const VERIFICATION_DECISIONS = [
  "accepted",
  "rejected",
  "revision_required",
  "review_required",
] as const
const VERIFICATION_STATES = [
  ...VERIFICATION_DECISIONS,
  "disputed",
  "blocked",
] as const
const OBLIGATION_EVENT_STATES = [
  "open",
  "assigned",
  "covered",
  "deferred",
  "excluded",
  "blocked",
  "failed",
] as const
const EDGE_RELATIONS = [
  "contains",
  "grounds",
  "verified_by",
  "forms",
  "proposes",
  "renders",
  "conflicts_with",
  "supersedes",
  "assesses",
  "blocked_by",
] as const
const SHA256 = /^sha256:[0-9a-f]{64}$/
const MAX_GRAPH_ITEMS = 200
const MAX_FINDINGS = 5
const MAX_FINDING_EVIDENCE = 20
const MAX_DECISION_REASONS = 20
const MAX_DETAIL_TEXT = 2_000

export type ProvenanceNodeType = (typeof PROVENANCE_NODE_TYPES)[number]
export type ProvenanceFilterState = (typeof PROVENANCE_FILTER_STATES)[number]
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number]
export type ProvenanceNodeState =
  | (typeof CLAIM_STATES)[number]
  | (typeof VERIFICATION_STATES)[number]
  | ConceptStatus
export type ProvenanceDecision =
  | (typeof VERIFICATION_DECISIONS)[number]
  | "blocked"
  | ConceptStatus
  | "supported"

type ProvenanceEntityType =
  "claim" | "concept" | "verification_candidate" | "coverage_obligation"

type ProvenanceEventState =
  | (typeof CLAIM_STATES)[number]
  | (typeof VERIFICATION_DECISIONS)[number]
  | (typeof OBLIGATION_EVENT_STATES)[number]
  | "active"
  | "staged"

export type ProvenanceEvent = {
  run_id: string
  entity_type: ProvenanceEntityType
  sequence: number
  previous_state: ProvenanceEventState | null
  state: ProvenanceEventState
  occurred_at: string
  candidate_id: string | null
}

export type VerificationFinding = {
  target_id: string
  target_type: "candidate" | "claim" | "concept" | "obligation"
  perspective:
    | "evidence_entailment"
    | "coverage"
    | "contradiction"
    | "concept_boundary"
    | "risk"
  verdict: "pass" | "fail" | "disputed"
  severity: "info" | "warning" | "error" | "critical"
  evidence: string[]
  rationale: string
}

export type ProvenanceNode = {
  id: string
  stable_id: string
  run_id: string
  type: ProvenanceNodeType
  label: string
  states: ProvenanceNodeState[]
  events: ProvenanceEvent[]
  revision: string | null
  path: string | null
  span: { start_line: number; end_line: number } | null
  digest: string | null
  decision: ProvenanceDecision | null
  role?: "defining" | "supporting"
  candidate_id?: string
  metadata?:
    | { findings: VerificationFinding[]; reasons: string[] }
    | { reason: string | null }
}

export type ProvenanceEdge = {
  id: string
  source: string
  target: string
  relation: (typeof EDGE_RELATIONS)[number]
}

export type ProvenanceBounds = {
  limit: number
  offset: number
  previous_offset: number | null
  next_offset: number | null
  total_nodes: number
  total_edges: number
  filtered_total_nodes: number
  filtered_total_edges: number
  truncated: boolean
}

export type ProvenanceSnapshot = {
  ok: true
  run_id: string | null
  run_state: string | null
  selected_concept_id: string | null
  concepts: Array<{
    id: string
    name: string
    status: ConceptStatus
    page: string | null
  }>
  nodes: ProvenanceNode[]
  edges: ProvenanceEdge[]
  bounds: ProvenanceBounds
}

export type ProvenanceError = {
  kind: "invalid" | "server"
  message: string
}

export async function fetchProvenance(
  token: string,
  options: {
    runId?: string
    conceptId?: string
    limit?: number
    offset?: number
    types?: ProvenanceNodeType[]
    states?: ProvenanceFilterState[]
  } = {},
  signal?: AbortSignal
): Promise<ProvenanceSnapshot> {
  const query = new URLSearchParams()
  if (options.runId) query.set("run_id", options.runId)
  if (options.conceptId) query.set("concept_id", options.conceptId)
  query.set("limit", String(options.limit ?? 100))
  query.set("offset", String(options.offset ?? 0))
  if (options.types?.length) query.set("types", options.types.join(","))
  if (options.states?.length) query.set("states", options.states.join(","))
  let response: Response
  try {
    response = await fetch(`/api/v1/concepts?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })
  } catch {
    throw {
      kind: "server",
      message:
        "The local service did not respond. Restart the Console and try again.",
    } satisfies ProvenanceError
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
          : "Concept provenance could not be loaded.",
    } satisfies ProvenanceError
  }
  if (!isSnapshot(payload)) {
    throw {
      kind: "server",
      message: "The local service returned an invalid provenance response.",
    } satisfies ProvenanceError
  }
  return payload
}

function isSnapshot(value: unknown): value is ProvenanceSnapshot {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !optionalStringOrNull(value.run_id) ||
    !optionalStringOrNull(value.run_state) ||
    !optionalStringOrNull(value.selected_concept_id) ||
    !Array.isArray(value.concepts) ||
    !value.concepts.every(isConcept) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isNode) ||
    !Array.isArray(value.edges) ||
    !value.edges.every(isEdge) ||
    !isBounds(value.bounds)
  )
    return false

  const concepts = value.concepts as ProvenanceSnapshot["concepts"]
  const nodes = value.nodes as ProvenanceNode[]
  const edges = value.edges as ProvenanceEdge[]
  const bounds = value.bounds as ProvenanceBounds
  const conceptIds = concepts.map((concept) => concept.id)
  const nodeIds = nodes.map((node) => node.id)
  const edgeIds = edges.map((edge) => edge.id)
  if (
    hasDuplicates(conceptIds) ||
    hasDuplicates(nodeIds) ||
    hasDuplicates(edgeIds)
  )
    return false
  if (
    concepts.length === 0
      ? value.selected_concept_id !== null
      : typeof value.selected_concept_id !== "string" ||
        !new Set(conceptIds).has(value.selected_concept_id)
  )
    return false
  if (nodes.length > 0 && typeof value.run_id !== "string") return false

  const nodeIdSet = new Set(nodeIds)
  if (
    edges.some(
      (edge) =>
        !nodeIdSet.has(edge.source) ||
        !nodeIdSet.has(edge.target) ||
        edge.id !== `${edge.source}|${edge.relation}|${edge.target}`
    )
  )
    return false

  const expectedNodes = Math.min(
    bounds.limit,
    Math.max(0, bounds.filtered_total_nodes - bounds.offset)
  )
  const expectedPrevious =
    bounds.offset > 0 ? Math.max(0, bounds.offset - bounds.limit) : null
  const expectedNext =
    bounds.offset + bounds.limit < bounds.filtered_total_nodes
      ? bounds.offset + bounds.limit
      : null
  const expectedTruncated =
    bounds.offset > 0 ||
    expectedNext !== null ||
    bounds.filtered_total_edges > edges.length
  return (
    nodes.length === expectedNodes &&
    edges.length <= MAX_GRAPH_ITEMS &&
    bounds.previous_offset === expectedPrevious &&
    bounds.next_offset === expectedNext &&
    bounds.filtered_total_nodes <= bounds.total_nodes &&
    bounds.filtered_total_edges <= bounds.total_edges &&
    bounds.truncated === expectedTruncated
  )
}

function isConcept(value: unknown) {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.name) &&
    includes(CONCEPT_STATUSES, value.status) &&
    optionalStringOrNull(value.page)
  )
}

function isNode(value: unknown): value is ProvenanceNode {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    value.stable_id !== value.id ||
    !nonEmptyString(value.run_id) ||
    !includes(PROVENANCE_NODE_TYPES, value.type) ||
    !nonEmptyString(value.label) ||
    !Array.isArray(value.states) ||
    hasDuplicates(value.states) ||
    !Array.isArray(value.events) ||
    !optionalStringOrNull(value.revision) ||
    !optionalStringOrNull(value.path) ||
    !(value.span === null || isSpan(value.span)) ||
    !optionalStringOrNull(value.digest) ||
    !optionalStringOrNull(value.decision)
  )
    return false

  const states = value.states
  switch (value.type) {
    case "source_unit":
      return (
        states.length === 0 &&
        value.events.length === 0 &&
        nonEmptyString(value.revision) &&
        nonEmptyString(value.path) &&
        (value.span === null || isSpan(value.span)) &&
        (value.digest === null || SHA256.test(value.digest)) &&
        value.decision === null &&
        noTypedDetails(value)
      )
    case "evidence":
      return (
        states.length === 0 &&
        value.events.length === 0 &&
        nonEmptyString(value.revision) &&
        nonEmptyString(value.path) &&
        isSpan(value.span) &&
        typeof value.digest === "string" &&
        SHA256.test(value.digest) &&
        value.decision === null &&
        noTypedDetails(value)
      )
    case "claim":
      return (
        states.every((state) => includes(CLAIM_STATES, state)) &&
        includes(["supported", "disputed", "stale"] as const, value.decision) &&
        states[0] === value.decision &&
        value.events.every((event) => isEntityEvent(event, "claim")) &&
        ["defining", "supporting"].includes(String(value.role)) &&
        nullLocation(value) &&
        value.candidate_id === undefined &&
        value.metadata === undefined
      )
    case "concept":
      return (
        states.length === 1 &&
        includes(CONCEPT_STATUSES, states[0]) &&
        states[0] === value.decision &&
        value.events.every((event) => isEntityEvent(event, "concept")) &&
        nullLocation(value) &&
        noTypedDetails(value)
      )
    case "page":
      return (
        states.length === 0 &&
        value.events.length === 0 &&
        nonEmptyString(value.revision) &&
        nonEmptyString(value.path) &&
        value.span === null &&
        typeof value.digest === "string" &&
        SHA256.test(value.digest) &&
        value.decision === null &&
        noTypedDetails(value)
      )
    case "verification": {
      if (!states.every((state) => includes(VERIFICATION_STATES, state)))
        return false
      if (value.decision === "blocked")
        return (
          states.length === 1 &&
          states[0] === "blocked" &&
          value.candidate_id === undefined &&
          value.events.every((event) =>
            isEntityEvent(event, "coverage_obligation")
          ) &&
          isReasonMetadata(value.metadata) &&
          nullLocation(value) &&
          value.role === undefined
        )
      return (
        includes(VERIFICATION_DECISIONS, value.decision) &&
        states[0] === value.decision &&
        states.slice(1).every((state) => state === "disputed") &&
        nonEmptyString(value.candidate_id) &&
        value.events.every((event) =>
          isEntityEvent(event, "verification_candidate")
        ) &&
        isFindingMetadata(value.metadata) &&
        nullLocation(value) &&
        value.role === undefined
      )
    }
  }
}

function isEntityEvent(value: unknown, entityType: ProvenanceEntityType) {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.run_id) ||
    value.entity_type !== entityType ||
    !Number.isInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.occurred_at !== "string" ||
    Number.isNaN(Date.parse(value.occurred_at)) ||
    !(value.candidate_id === null || typeof value.candidate_id === "string")
  )
    return false
  const states =
    entityType === "claim"
      ? (["supported", "disputed", "stale"] as const)
      : entityType === "concept"
        ? CONCEPT_STATUSES
        : entityType === "verification_candidate"
          ? (["staged", ...VERIFICATION_DECISIONS] as const)
          : OBLIGATION_EVENT_STATES
  return (
    includes(states, value.state) &&
    (value.previous_state === null || includes(states, value.previous_state))
  )
}

function isSpan(value: unknown) {
  return (
    isRecord(value) &&
    Number.isInteger(value.start_line) &&
    Number(value.start_line) >= 1 &&
    Number.isInteger(value.end_line) &&
    Number(value.end_line) >= Number(value.start_line)
  )
}

function isFindingMetadata(value: unknown) {
  return (
    isRecord(value) &&
    Array.isArray(value.findings) &&
    value.findings.length <= MAX_FINDINGS &&
    value.findings.every(isFinding) &&
    isBoundedStrings(value.reasons, MAX_DECISION_REASONS, MAX_DETAIL_TEXT)
  )
}

function isReasonMetadata(value: unknown) {
  return (
    isRecord(value) &&
    (value.reason === null ||
      (typeof value.reason === "string" &&
        value.reason.length <= MAX_DETAIL_TEXT))
  )
}

function isFinding(value: unknown) {
  return (
    isRecord(value) &&
    nonEmptyString(value.target_id) &&
    ["candidate", "claim", "concept", "obligation"].includes(
      String(value.target_type)
    ) &&
    [
      "evidence_entailment",
      "coverage",
      "contradiction",
      "concept_boundary",
      "risk",
    ].includes(String(value.perspective)) &&
    ["pass", "fail", "disputed"].includes(String(value.verdict)) &&
    ["info", "warning", "error", "critical"].includes(String(value.severity)) &&
    isBoundedStrings(
      value.evidence,
      MAX_FINDING_EVIDENCE,
      MAX_DETAIL_TEXT,
      1
    ) &&
    nonEmptyString(value.rationale) &&
    value.rationale.length <= MAX_DETAIL_TEXT
  )
}

function isEdge(value: unknown): value is ProvenanceEdge {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.source) &&
    nonEmptyString(value.target) &&
    includes(EDGE_RELATIONS, value.relation)
  )
}

function isBounds(value: unknown): value is ProvenanceBounds {
  return (
    isRecord(value) &&
    integerBetween(value.limit, 1, MAX_GRAPH_ITEMS) &&
    nonNegativeInteger(value.offset) &&
    nullableNonNegativeInteger(value.previous_offset) &&
    nullableNonNegativeInteger(value.next_offset) &&
    nonNegativeInteger(value.total_nodes) &&
    nonNegativeInteger(value.total_edges) &&
    nonNegativeInteger(value.filtered_total_nodes) &&
    nonNegativeInteger(value.filtered_total_edges) &&
    typeof value.truncated === "boolean"
  )
}

function nullLocation(value: Record<string, unknown>) {
  return (
    value.revision === null &&
    value.path === null &&
    value.span === null &&
    value.digest === null
  )
}

function noTypedDetails(value: Record<string, unknown>) {
  return (
    value.role === undefined &&
    value.candidate_id === undefined &&
    value.metadata === undefined
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
  maximumLength: number,
  minimumItems = 0
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimumItems &&
    value.length <= maximumItems &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= maximumLength
    )
  )
}

function optionalStringOrNull(value: unknown) {
  return value === null || typeof value === "string"
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function integerBetween(value: unknown, minimum: number, maximum: number) {
  return (
    Number.isInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  )
}

function nonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0
}

function nullableNonNegativeInteger(value: unknown) {
  return value === null || nonNegativeInteger(value)
}

function hasDuplicates(values: unknown[]) {
  return new Set(values).size !== values.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
