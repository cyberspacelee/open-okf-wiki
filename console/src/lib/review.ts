export type EvidenceReference = {
  id: string
  source_id: string
  revision: string
  path: string
  start_line: number
  end_line: number
  digest: string
  evidence_kind: string
  authority: string
}

export type ClaimChange = {
  id: string
  statement: string
  epistemic_status: string
  evidence: EvidenceReference[]
}

export type ConceptChange = {
  id: string
  canonical_name: string
  description: string
  status: string
  page: string
}

type ChangeGroups<T> = Record<
  | "added"
  | "changed"
  | "removed"
  | "stale"
  | "disputed"
  | "merged"
  | "split"
  | "excluded",
  T[]
>

export type ReviewSnapshot = {
  run_id: string
  project_id: string
  state: "review_required"
  source_set_digest: string
  authoritative_digest: string
  coverage: {
    total: number
    major: number
    supporting: number
    covered: number
    deferred: number
    excluded: number
    by_source: Record<string, CoverageGroup>
    by_role: Record<string, CoverageGroup>
    by_priority: Record<string, CoverageGroup>
  }
  coverage_obligations: Array<{
    id: string
    source: string
    role: string
    path: string
    kind: string
    priority: string
    disposition: string
    reason: string | null
    span: { start_line: number; end_line: number }
  }>
  knowledge_changes: {
    claims: ChangeGroups<ClaimChange>
    concepts: ChangeGroups<ConceptChange>
  }
  verification_findings: Array<{
    candidate_id: string
    perspective: string
    severity: string
    verdict: string
    blocking: boolean
    rationale: string
    evidence: string[]
    evidence_reference_ids: string[]
  }>
  evidence_references: EvidenceReference[]
  bundle_diff: Record<"added" | "changed" | "removed", string[]>
}

type CoverageGroup = {
  total: number
  dispositions: Record<string, number>
}

export type EvidenceExcerpt = EvidenceReference & {
  requested_end_line: number
  text: string
  truncated: boolean
}

export type BundleFileDetail = {
  path: string
  status: "added" | "changed" | "removed"
  staged: string | null
  published: string | null
}

export type ReviewError = { kind: "invalid" | "server"; message: string }

export async function fetchReview(
  token: string,
  runId: string,
  signal?: AbortSignal
) {
  const payload = await request(
    `/api/v1/reviews/${encodeURIComponent(runId)}`,
    "GET",
    token,
    undefined,
    signal
  )
  if (!isReviewSnapshot(payload)) throw invalid("review snapshot")
  return payload
}

export async function fetchEvidence(
  token: string,
  runId: string,
  evidenceId: string,
  signal?: AbortSignal
) {
  const payload = await request(
    `/api/v1/reviews/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidenceId)}`,
    "GET",
    token,
    undefined,
    signal
  )
  if (
    !isRecord(payload) ||
    payload.ok !== true ||
    typeof payload.text !== "string" ||
    typeof payload.truncated !== "boolean" ||
    !Number.isInteger(payload.requested_end_line) ||
    !isEvidence(payload)
  )
    throw invalid("Evidence excerpt")
  return payload as EvidenceExcerpt & { ok: true }
}

export async function fetchBundleFile(
  token: string,
  runId: string,
  path: string,
  signal?: AbortSignal
) {
  const payload = await request(
    `/api/v1/reviews/${encodeURIComponent(runId)}/bundle/${encodeURIComponent(path)}`,
    "GET",
    token,
    undefined,
    signal
  )
  if (
    !isRecord(payload) ||
    payload.ok !== true ||
    typeof payload.path !== "string" ||
    !["added", "changed", "removed"].includes(String(payload.status)) ||
    !optionalStringOrNull(payload.staged) ||
    !optionalStringOrNull(payload.published)
  )
    throw invalid("Bundle diff detail")
  return payload as BundleFileDetail & { ok: true }
}

export async function decideReview(
  token: string,
  runId: string,
  decision: "approve" | "reject",
  expectedDigest: string
) {
  try {
    const payload = await request(
      `/api/v1/reviews/${encodeURIComponent(runId)}/decision`,
      "POST",
      token,
      { decision, expected_digest: expectedDigest }
    )
    if (
      !isRecord(payload) ||
      payload.ok !== true ||
      typeof payload.run_id !== "string" ||
      typeof payload.state !== "string"
    )
      throw invalid("review decision")
    return { status: "complete" as const, result: payload }
  } catch (error) {
    if (
      isRecord(error) &&
      error.kind === "stale" &&
      isReviewSnapshot(error.review)
    )
      return {
        status: "stale" as const,
        message: String(error.message),
        review: error.review,
      }
    throw error
  }
}

async function request(
  path: string,
  method: "GET" | "POST",
  token: string,
  body?: object,
  signal?: AbortSignal
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch {
    throw {
      kind: "server",
      message:
        "The local service did not respond. Restart the Console and try again.",
    } satisfies ReviewError
  }
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      isRecord(payload) &&
      Array.isArray(payload.errors) &&
      typeof payload.errors[0] === "string"
        ? payload.errors[0]
        : "The review operation failed."
    if (response.status === 409 && isRecord(payload) && payload.review)
      throw { kind: "stale", message, review: payload.review }
    throw {
      kind: response.status < 500 ? "invalid" : "server",
      message,
    } satisfies ReviewError
  }
  return payload
}

function isReviewSnapshot(
  value: unknown
): value is ReviewSnapshot & { ok: true } {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.run_id === "string" &&
    typeof value.project_id === "string" &&
    value.state === "review_required" &&
    typeof value.source_set_digest === "string" &&
    typeof value.authoritative_digest === "string" &&
    value.authoritative_digest.length === 64 &&
    isCoverage(value.coverage) &&
    Array.isArray(value.coverage_obligations) &&
    value.coverage_obligations.every(isObligation) &&
    isChanges(value.knowledge_changes) &&
    Array.isArray(value.verification_findings) &&
    value.verification_findings.every(isFinding) &&
    Array.isArray(value.evidence_references) &&
    value.evidence_references.every(isEvidence) &&
    isBundleDiff(value.bundle_diff)
  )
}

function isCoverage(value: unknown) {
  return (
    isRecord(value) &&
    [
      value.total,
      value.major,
      value.supporting,
      value.covered,
      value.deferred,
      value.excluded,
    ].every(isNonnegativeInteger) &&
    isCoverageGroups(value.by_source) &&
    isCoverageGroups(value.by_role) &&
    isCoverageGroups(value.by_priority)
  )
}

function isCoverageGroups(value: unknown) {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (group) =>
        isRecord(group) &&
        isNonnegativeInteger(group.total) &&
        isRecord(group.dispositions) &&
        Object.values(group.dispositions).every(isNonnegativeInteger)
    )
  )
}

function isObligation(value: unknown) {
  return (
    isRecord(value) &&
    [
      value.id,
      value.source,
      value.role,
      value.path,
      value.kind,
      value.priority,
      value.disposition,
    ].every((item) => typeof item === "string") &&
    (value.reason === null || typeof value.reason === "string") &&
    isRecord(value.span) &&
    Number.isInteger(value.span.start_line) &&
    Number.isInteger(value.span.end_line)
  )
}

function isChanges(value: unknown) {
  return (
    isRecord(value) &&
    isChangeGroups(value.claims, isClaim) &&
    isChangeGroups(value.concepts, isConcept)
  )
}

function isChangeGroups(value: unknown, itemGuard: (item: unknown) => boolean) {
  return (
    isRecord(value) &&
    [
      "added",
      "changed",
      "removed",
      "stale",
      "disputed",
      "merged",
      "split",
      "excluded",
    ].every((key) => Array.isArray(value[key]) && value[key].every(itemGuard))
  )
}

function isClaim(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.statement === "string" &&
    typeof value.epistemic_status === "string" &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidence)
  )
}

function isConcept(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.canonical_name === "string" &&
    typeof value.description === "string" &&
    typeof value.status === "string" &&
    typeof value.page === "string"
  )
}

function isFinding(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.candidate_id === "string" &&
    typeof value.perspective === "string" &&
    typeof value.severity === "string" &&
    typeof value.verdict === "string" &&
    typeof value.blocking === "boolean" &&
    typeof value.rationale === "string" &&
    isStringArray(value.evidence) &&
    isStringArray(value.evidence_reference_ids)
  )
}

function isBundleDiff(value: unknown) {
  return (
    isRecord(value) &&
    isStringArray(value.added) &&
    isStringArray(value.changed) &&
    isStringArray(value.removed)
  )
}

function isEvidence(value: unknown): value is EvidenceReference {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source_id === "string" &&
    typeof value.revision === "string" &&
    typeof value.path === "string" &&
    Number.isInteger(value.start_line) &&
    Number.isInteger(value.end_line) &&
    typeof value.digest === "string" &&
    typeof value.evidence_kind === "string" &&
    typeof value.authority === "string"
  )
}

function optionalStringOrNull(value: unknown) {
  return value === null || typeof value === "string"
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isNonnegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0
}

function invalid(label: string): ReviewError {
  return {
    kind: "server",
    message: `The local service returned an invalid ${label}.`,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
