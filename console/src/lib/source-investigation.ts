export type SourceInvestigationRequest = {
  question: string
  run_id: string
  source_set_digest: string
}

export type InvestigationSource = {
  source_id: string
  revision: string
}

export type SourceCitation = InvestigationSource & {
  path: string
  start_line: number
  end_line: number
  digest: string
}

export type InvestigationSegment = {
  kind: "fact" | "insufficient_support"
  text: string
  citations: SourceCitation[]
}

export type SourceInvestigationAnswer = {
  ok: true
  investigation_id: string
  outcome: "answered" | "partially_answered" | "insufficient_support" | "error"
  provisional: true
  notice: "Provisional · not part of Knowledge Bundle"
  run_id: string
  source_set_digest: string
  model: string
  sources: InvestigationSource[]
  segments: InvestigationSegment[]
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

export type SourceInvestigationError = { message: string }

const INVESTIGATION_ID = /^[0-9a-f]{32}$/
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SOURCE_SET_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const REVISION = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const NOTICE = "Provisional · not part of Knowledge Bundle"
const MAX_SOURCES = 32
const MAX_SEGMENTS = 8
const MAX_CITATIONS = 16
const MAX_TEXT = 16_000
const MAX_USAGE = 1_000_000_000
const MAX_LATENCY_MS = 3_600_000

export async function investigateSource(
  token: string,
  request: SourceInvestigationRequest,
  signal?: AbortSignal
) {
  let response: Response
  try {
    response = await fetch("/api/v1/source-investigations", {
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
      message: "The local Source Investigation service did not respond.",
    } satisfies SourceInvestigationError
  }
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      isRecord(payload) &&
      Array.isArray(payload.errors) &&
      typeof payload.errors[0] === "string"
        ? payload.errors[0]
        : "The Source Investigation could not be completed."
    throw { message } satisfies SourceInvestigationError
  }
  if (!isAnswer(payload, request))
    throw {
      message:
        "The local service returned an invalid Source Investigation response.",
    } satisfies SourceInvestigationError
  return payload
}

function isAnswer(
  value: unknown,
  request: SourceInvestigationRequest
): value is SourceInvestigationAnswer {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ok",
      "investigation_id",
      "outcome",
      "provisional",
      "notice",
      "run_id",
      "source_set_digest",
      "model",
      "sources",
      "segments",
      "usage",
      "latency_ms",
      "error",
      "data_egress",
    ]) ||
    value.ok !== true ||
    value.provisional !== true ||
    value.notice !== NOTICE ||
    typeof value.investigation_id !== "string" ||
    !INVESTIGATION_ID.test(value.investigation_id) ||
    typeof value.run_id !== "string" ||
    !RUN_ID.test(value.run_id) ||
    value.run_id !== request.run_id ||
    typeof value.source_set_digest !== "string" ||
    !SOURCE_SET_DIGEST.test(value.source_set_digest) ||
    value.source_set_digest !== request.source_set_digest ||
    !boundedText(value.model, 256) ||
    !boundedText(value.data_egress, 2_000) ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0 ||
    value.sources.length > MAX_SOURCES ||
    !value.sources.every(isSource) ||
    new Set(value.sources.map(sourceKey)).size !== value.sources.length ||
    !Array.isArray(value.segments) ||
    value.segments.length > MAX_SEGMENTS ||
    !isUsage(value.usage) ||
    !boundedInteger(value.latency_ms, MAX_LATENCY_MS) ||
    (value.error !== null && !boundedText(value.error, 2_000)) ||
    ![
      "answered",
      "partially_answered",
      "insufficient_support",
      "error",
    ].includes(String(value.outcome))
  )
    return false

  const sources = new Set(
    (value.sources as InvestigationSource[]).map(sourceKey)
  )
  if (
    !value.segments.every((segment) => isSegment(segment, sources)) ||
    (value.outcome === "error"
      ? value.segments.length !== 0 || typeof value.error !== "string"
      : value.error !== null ||
        value.segments.length === 0 ||
        !validOutcome(value.outcome, value.segments as InvestigationSegment[]))
  )
    return false
  return true
}

function isSource(value: unknown): value is InvestigationSource {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["source_id", "revision"]) &&
    typeof value.source_id === "string" &&
    SOURCE_ID.test(value.source_id) &&
    typeof value.revision === "string" &&
    REVISION.test(value.revision)
  )
}

function isSegment(
  value: unknown,
  sources: Set<string>
): value is InvestigationSegment {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "text", "citations"]) ||
    (value.kind !== "fact" && value.kind !== "insufficient_support") ||
    !boundedText(value.text, MAX_TEXT) ||
    !Array.isArray(value.citations) ||
    value.citations.length > MAX_CITATIONS ||
    !value.citations.every(
      (citation) => isCitation(citation) && sources.has(sourceKey(citation))
    )
  )
    return false
  if (value.kind === "insufficient_support") return value.citations.length === 0
  const keys = value.citations.map(citationKey)
  return keys.length > 0 && new Set(keys).size === keys.length
}

function isCitation(value: unknown): value is SourceCitation {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "source_id",
      "revision",
      "path",
      "start_line",
      "end_line",
      "digest",
    ]) &&
    typeof value.source_id === "string" &&
    SOURCE_ID.test(value.source_id) &&
    typeof value.revision === "string" &&
    REVISION.test(value.revision) &&
    canonicalRelativePath(value.path) &&
    boundedInteger(value.start_line, 1_000_000_000) &&
    boundedInteger(value.end_line, 1_000_000_000) &&
    value.start_line >= 1 &&
    value.end_line >= value.start_line &&
    typeof value.digest === "string" &&
    DIGEST.test(value.digest)
  )
}

function isUsage(value: unknown): value is SourceInvestigationAnswer["usage"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "requests",
      "tool_calls",
      "input_tokens",
      "output_tokens",
      "total_tokens",
    ])
  )
    return false
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

function validOutcome(outcome: unknown, segments: InvestigationSegment[]) {
  const facts = segments.filter((segment) => segment.kind === "fact").length
  if (outcome === "answered") return facts === segments.length
  if (outcome === "partially_answered")
    return facts > 0 && facts < segments.length
  return outcome === "insufficient_support" && facts === 0
}

function sourceKey(source: InvestigationSource) {
  return `${source.source_id}\0${source.revision}`
}

function citationKey(citation: SourceCitation) {
  return `${sourceKey(citation)}\0${citation.path}\0${citation.start_line}\0${citation.end_line}\0${citation.digest}`
}

function canonicalRelativePath(value: unknown): value is string {
  if (
    !boundedText(value, 1_000) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  )
    return false
  return value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..")
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit
}

function boundedInteger(value: unknown, limit: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= limit
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => key in value)
}
