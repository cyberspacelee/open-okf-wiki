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

export type ProvenanceNodeType = (typeof PROVENANCE_NODE_TYPES)[number]
export type ProvenanceFilterState = (typeof PROVENANCE_FILTER_STATES)[number]

export type ProvenanceEvent = {
  sequence: number
  previous_state: string | null
  state: string
  occurred_at: string
  candidate_id: string | null
}

export type ProvenanceNode = {
  id: string
  stable_id: string
  type: ProvenanceNodeType
  label: string
  states: string[]
  events: ProvenanceEvent[]
  revision: string | null
  path: string | null
  span: { start_line: number; end_line: number } | null
  digest: string | null
  decision: string | null
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
  relation:
    | "contains"
    | "grounds"
    | "verified_by"
    | "forms"
    | "renders"
    | "conflicts_with"
    | "supersedes"
    | "assesses"
    | "blocked_by"
}

export type ProvenanceSnapshot = {
  ok: true
  run_id: string | null
  run_state: string | null
  selected_concept_id: string | null
  concepts: Array<{
    id: string
    name: string
    status: string
    page: string | null
  }>
  nodes: ProvenanceNode[]
  edges: ProvenanceEdge[]
  bounds: {
    limit: number
    total_nodes: number
    total_edges: number
    truncated: boolean
  }
}

type VerificationFinding = {
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

export type ProvenanceError = {
  kind: "invalid" | "server"
  message: string
}

export async function fetchProvenance(
  token: string,
  options: { runId?: string; conceptId?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<ProvenanceSnapshot> {
  const query = new URLSearchParams()
  if (options.runId) query.set("run_id", options.runId)
  if (options.conceptId) query.set("concept_id", options.conceptId)
  query.set("limit", String(options.limit ?? 100))
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
  const valid =
    isRecord(value) &&
    value.ok === true &&
    optionalStringOrNull(value.run_id) &&
    optionalStringOrNull(value.run_state) &&
    optionalStringOrNull(value.selected_concept_id) &&
    Array.isArray(value.concepts) &&
    value.concepts.every(isConcept) &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isNode) &&
    Array.isArray(value.edges) &&
    value.edges.every(isEdge) &&
    isBounds(value.bounds)
  if (!valid) return false
  const ids = new Set((value.nodes as ProvenanceNode[]).map((node) => node.id))
  return (value.edges as ProvenanceEdge[]).every(
    (edge) => ids.has(edge.source) && ids.has(edge.target)
  )
}

function isConcept(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    optionalStringOrNull(value.page)
  )
}

function isNode(value: unknown): value is ProvenanceNode {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.stable_id === "string" &&
    PROVENANCE_NODE_TYPES.includes(value.type as ProvenanceNodeType) &&
    typeof value.label === "string" &&
    isStringArray(value.states) &&
    Array.isArray(value.events) &&
    value.events.every(isEvent) &&
    optionalStringOrNull(value.revision) &&
    optionalStringOrNull(value.path) &&
    (value.span === null || isSpan(value.span)) &&
    optionalStringOrNull(value.digest) &&
    optionalStringOrNull(value.decision) &&
    (value.role === undefined ||
      ["defining", "supporting"].includes(String(value.role))) &&
    (value.candidate_id === undefined ||
      typeof value.candidate_id === "string") &&
    (value.metadata === undefined || isMetadata(value.metadata))
  )
}

function isEvent(value: unknown) {
  return (
    isRecord(value) &&
    Number.isInteger(value.sequence) &&
    (value.previous_state === null ||
      typeof value.previous_state === "string") &&
    typeof value.state === "string" &&
    typeof value.occurred_at === "string" &&
    (value.candidate_id === null || typeof value.candidate_id === "string")
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

function isMetadata(value: unknown) {
  if (!isRecord(value)) return false
  if ("findings" in value || "reasons" in value)
    return (
      Array.isArray(value.findings) &&
      value.findings.every(isFinding) &&
      isStringArray(value.reasons)
    )
  return value.reason === null || typeof value.reason === "string"
}

function isFinding(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.target_id === "string" &&
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
    isStringArray(value.evidence) &&
    typeof value.rationale === "string"
  )
}

function isEdge(value: unknown): value is ProvenanceEdge {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.target === "string" &&
    [
      "contains",
      "grounds",
      "verified_by",
      "forms",
      "renders",
      "conflicts_with",
      "supersedes",
      "assesses",
      "blocked_by",
    ].includes(String(value.relation))
  )
}

function isBounds(value: unknown) {
  return (
    isRecord(value) &&
    Number.isInteger(value.limit) &&
    Number(value.limit) >= 1 &&
    Number(value.limit) <= 200 &&
    Number.isInteger(value.total_nodes) &&
    Number(value.total_nodes) >= 0 &&
    Number.isInteger(value.total_edges) &&
    Number(value.total_edges) >= 0 &&
    typeof value.truncated === "boolean"
  )
}

function optionalStringOrNull(value: unknown) {
  return value === null || typeof value === "string"
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
