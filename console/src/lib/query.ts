import type { BundleKind } from "@/lib/knowledge"

export type QueryScope = "concept" | "bundle"

type KnowledgeQueryBase = {
  question: string
  bundle: BundleKind
  run_id: string
  source_set_digest: string
}

export type KnowledgeQueryRequest = KnowledgeQueryBase &
  (
    | {
        scope: "concept"
        page: string
        concept_id: string | null
      }
    | {
        scope: "bundle"
        page?: never
        concept_id?: never
      }
  )

export type EvidenceCitation = {
  id: string
  source_id: string
  revision: string
  path: string
  start_line: number
  end_line: number
}

export type ClaimCitation = {
  claim_id: string
  evidence: EvidenceCitation[]
}

export type QuerySegment = {
  kind: "fact" | "insufficient_support"
  text: string
  claim_ids: string[]
  evidence_ids: string[]
  citations: ClaimCitation[]
}

export type KnowledgeQueryAnswer = {
  ok: true
  query_id: string
  outcome: "answered" | "partially_answered" | "insufficient_support" | "error"
  run_id: string
  source_set_digest: string
  model: string
  scope: QueryScope
  page: string | null
  concept_id: string | null
  segments: QuerySegment[]
  usage: {
    requests: number
    tool_calls: number
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  latency_ms: number
  error: string | null
  data_egress: string
}

export type QueryError = { message: string }

const QUERY_ID = /^[0-9a-f]{32}$/
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SOURCE_SET_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const CONCEPT_ID = /^concept:[0-9a-f]{64}$/
const CLAIM_ID = /^claim:[0-9a-f]{64}$/
const EVIDENCE_ID = /^evidence:[0-9a-f]{64}$/
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const REVISION = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/
const MAX_SEGMENTS = 8
const MAX_CLAIMS = 8
const MAX_EVIDENCE = 16
const MAX_TEXT = 16_000
const MAX_USAGE = 1_000_000_000
const MAX_LATENCY_MS = 3_600_000

export async function askAcceptedKnowledge(
  token: string,
  request: KnowledgeQueryRequest,
  signal?: AbortSignal
) {
  let response: Response
  try {
    response = await fetch("/api/v1/knowledge/query", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal,
    })
  } catch {
    throw {
      message: "The local Query Agent service did not respond.",
    } satisfies QueryError
  }
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      isRecord(payload) &&
      Array.isArray(payload.errors) &&
      typeof payload.errors[0] === "string"
        ? payload.errors[0]
        : "The Knowledge Query could not be completed."
    throw { message } satisfies QueryError
  }
  if (!isAnswer(payload, request))
    throw {
      message:
        "The local service returned an invalid Knowledge Query response.",
    } satisfies QueryError
  return payload
}

function isAnswer(
  value: unknown,
  request: KnowledgeQueryRequest
): value is KnowledgeQueryAnswer {
  if (!isRecord(value)) return false
  const identityMatches =
    request.scope === "bundle"
      ? value.page === null && value.concept_id === null
      : value.page === request.page &&
        canonicalRelativePath(value.page) &&
        value.concept_id === request.concept_id
  return (
    value.ok === true &&
    strings(value, [
      "query_id",
      "run_id",
      "source_set_digest",
      "model",
      "scope",
      "data_egress",
    ]) &&
    [
      "answered",
      "partially_answered",
      "insufficient_support",
      "error",
    ].includes(String(value.outcome)) &&
    typeof value.query_id === "string" &&
    QUERY_ID.test(value.query_id) &&
    typeof value.run_id === "string" &&
    RUN_ID.test(value.run_id) &&
    typeof value.source_set_digest === "string" &&
    SOURCE_SET_DIGEST.test(value.source_set_digest) &&
    boundedText(value.model, 256) &&
    boundedText(value.data_egress, 2_000) &&
    value.run_id === request.run_id &&
    value.source_set_digest === request.source_set_digest &&
    value.scope === request.scope &&
    (value.page === null || canonicalRelativePath(value.page)) &&
    (value.concept_id === null ||
      (typeof value.concept_id === "string" &&
        CONCEPT_ID.test(value.concept_id))) &&
    identityMatches &&
    Array.isArray(value.segments) &&
    value.segments.length <= MAX_SEGMENTS &&
    value.segments.every(isSegment) &&
    isUsage(value.usage) &&
    boundedInteger(value.latency_ms, MAX_LATENCY_MS) &&
    (value.error === null || boundedText(value.error, 2_000)) &&
    (value.outcome === "error"
      ? value.segments.length === 0 && typeof value.error === "string"
      : value.error === null &&
        value.segments.length > 0 &&
        validOutcome(value.outcome, value.segments as QuerySegment[]))
  )
}

function isSegment(value: unknown): value is QuerySegment {
  if (
    !isRecord(value) ||
    (value.kind !== "fact" && value.kind !== "insufficient_support") ||
    !boundedText(value.text, MAX_TEXT) ||
    !idArray(value.claim_ids, CLAIM_ID, MAX_CLAIMS) ||
    !idArray(value.evidence_ids, EVIDENCE_ID, MAX_EVIDENCE) ||
    !Array.isArray(value.citations) ||
    value.citations.length > MAX_CLAIMS ||
    !value.citations.every(isCitation)
  )
    return false
  if (value.kind === "insufficient_support")
    return (
      value.claim_ids.length === 0 &&
      value.evidence_ids.length === 0 &&
      value.citations.length === 0
    )
  const claimIds = value.citations.map((citation) => citation.claim_id)
  const evidenceIds = value.citations.flatMap((citation) =>
    citation.evidence.map((evidence) => evidence.id)
  )
  return (
    value.claim_ids.length > 0 &&
    value.evidence_ids.length > 0 &&
    sameUniqueIds(value.claim_ids, claimIds) &&
    sameUniqueIds(value.evidence_ids, evidenceIds) &&
    new Set(claimIds).size === claimIds.length &&
    value.citations.every((citation) => citation.evidence.length > 0)
  )
}

function isCitation(value: unknown): value is ClaimCitation {
  if (
    !isRecord(value) ||
    typeof value.claim_id !== "string" ||
    !CLAIM_ID.test(value.claim_id) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    value.evidence.length > MAX_EVIDENCE ||
    !value.evidence.every(isEvidenceCitation)
  )
    return false
  return (
    new Set(value.evidence.map((item) => item.id)).size ===
    value.evidence.length
  )
}

function isEvidenceCitation(value: unknown): value is EvidenceCitation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    EVIDENCE_ID.test(value.id) &&
    typeof value.source_id === "string" &&
    SOURCE_ID.test(value.source_id) &&
    typeof value.revision === "string" &&
    REVISION.test(value.revision) &&
    canonicalRelativePath(value.path) &&
    boundedInteger(value.start_line, 1_000_000_000) &&
    boundedInteger(value.end_line, 1_000_000_000) &&
    value.start_line >= 1 &&
    value.end_line >= value.start_line
  )
}

function isUsage(value: unknown): value is KnowledgeQueryAnswer["usage"] {
  if (!isRecord(value)) return false
  const fields = [
    value.requests,
    value.tool_calls,
    value.input_tokens,
    value.output_tokens,
    value.total_tokens,
  ]
  return (
    fields.every((item) => boundedInteger(item, MAX_USAGE)) &&
    typeof value.total_tokens === "number" &&
    typeof value.input_tokens === "number" &&
    typeof value.output_tokens === "number" &&
    value.total_tokens === value.input_tokens + value.output_tokens
  )
}

function sameUniqueIds(left: string[], right: string[]) {
  return (
    new Set(left).size === left.length &&
    left.length === new Set(right).size &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  )
}

function validOutcome(outcome: unknown, segments: QuerySegment[]) {
  const facts = segments.filter((segment) => segment.kind === "fact").length
  if (outcome === "answered") return facts === segments.length
  if (outcome === "partially_answered")
    return facts > 0 && facts < segments.length
  return outcome === "insufficient_support" && facts === 0
}

function idArray(
  value: unknown,
  pattern: RegExp,
  limit: number
): value is string[] {
  return (
    stringArray(value) &&
    value.length <= limit &&
    new Set(value).size === value.length &&
    value.every((item) => pattern.test(item))
  )
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit
}

function canonicalRelativePath(value: unknown): value is string {
  if (
    !boundedText(value, 1_000) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  )
    return false
  const parts = value.split("/")
  return parts.every((part) => part !== "" && part !== "." && part !== "..")
}

function boundedInteger(value: unknown, limit: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= limit
  )
}

function strings(value: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => typeof value[key] === "string")
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
