export type RunState =
  | "preparing"
  | "exploring"
  | "verifying"
  | "rendering"
  | "checking"
  | "review_required"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled"

export const RUN_PHASES: Array<{ state: RunState; label: string }> = [
  { state: "preparing", label: "Preparing" },
  { state: "exploring", label: "Exploring" },
  { state: "verifying", label: "Verifying" },
  { state: "rendering", label: "Rendering" },
  { state: "checking", label: "Checking" },
  { state: "review_required", label: "Review Required" },
  { state: "publishing", label: "Publishing" },
  { state: "published", label: "Published" },
]

export const RUN_STATE_META: Record<
  RunState,
  { label: string; phase: number }
> = {
  preparing: { label: "Preparing", phase: 0 },
  exploring: { label: "Exploring", phase: 1 },
  verifying: { label: "Verifying", phase: 2 },
  rendering: { label: "Rendering", phase: 3 },
  checking: { label: "Checking", phase: 4 },
  review_required: { label: "Review Required", phase: 5 },
  publishing: { label: "Publishing", phase: 6 },
  published: { label: "Published", phase: 7 },
  failed: { label: "Failed", phase: -1 },
  cancelled: { label: "Cancelled", phase: -1 },
}

export const ACTIVE_RUN_STATES = new Set<RunState>([
  "preparing",
  "exploring",
  "verifying",
  "rendering",
  "checking",
  "publishing",
])

export function runStateLabel(state: string) {
  return RUN_STATE_META[state as RunState]?.label ?? "Unknown state"
}

export function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
}

export type RunSummary = {
  run_id: string
  state: RunState
  phase: RunState
  created_at: string
  updated_at: string
  source_set_digest: string
  outcome: "review_required" | "published" | "failed" | "cancelled" | null
  execution:
    | {
        mode: "deterministic_fixture"
        requested_outcome: "success" | "failure"
      }
    | { mode: "gateway_semantic"; requested_outcome?: null }
    | { mode: "legacy"; requested_outcome?: null }
}

export type RunEvent = {
  sequence: number
  previous_state: string | null
  state: string
  occurred_at: string
}

export type EntityEvent = RunEvent & {
  entity_type: "analysis_task" | "coverage_obligation"
  entity_id: string
}

export type RunTask = {
  id: string
  state: string
  obligation_ids: string[]
  source_id: string
  path_scope: string[]
  agent_role: string
  budgets: Record<string, number>
  receipt: {
    accepted_ids: string[]
    unresolved_ids: string[]
    warnings: string[]
  } | null
  error?: string | null
}

export type RunModels = {
  profile: {
    id: string
    name?: string
    gateway_id?: string
    base_url?: string
    header_names?: string[]
    revision?: number
    registered: boolean
  }
  default_model: string
  assignments: Record<string, string>
  concurrency: number
  budgets: Record<string, number>
  runtime_limits: Record<string, number>
  capabilities: Record<string, Record<string, boolean>>
}

export type CoverageObligation = {
  id: string
  priority: string
  disposition: string
  source: string
  role: string
  state_changes: EntityEvent[]
}

export type RunAudit = {
  failures: number
  latency_ms: number
  models: string[]
  retries: number
  tokens: number
  tool_calls: number
  by_role_model: Array<{
    role: "planner" | "worker" | "verifier"
    model: string
    calls: number
    failures: number
    latency_ms: number
    retries: number
    tokens: number
    tool_calls: number
  }>
}

export type RunDetail = RunSummary & {
  project_id: string
  actionable_errors: string[]
  audit: RunAudit
  coverage_obligations: CoverageObligation[]
  events: RunEvent[]
  entity_events: EntityEvent[]
  models: RunModels | null
  diagnostics: {
    actionable_errors: string[]
    active_tasks: number
    audit: RunAudit
    budgets: Record<string, { remaining: number; used: number }>
    classification: "active" | "interrupted" | "review_blocked" | "terminal"
    failed_tasks: number
    review_blockers: string[]
    staging: { exists: boolean; path: string }
    terminal_outcome: "published" | "failed" | "cancelled" | null
  }
  operations: {
    can_cancel: boolean
    can_recover: boolean
    recover_reason: string | null
  }
  sources: Array<{
    id: string
    role: string
    revision: string
    tree_digest: string | null
  }>
  tasks: {
    active: RunTask[]
    completed: RunTask[]
    failed: RunTask[]
  }
}

export type RunsSnapshot = { ok: true; runs: RunSummary[] }
export type RunsError = { kind: "invalid" | "server"; message: string }

const states = new Set<RunState>(Object.keys(RUN_STATE_META) as RunState[])

export async function fetchRuns(token: string, signal?: AbortSignal) {
  const payload = await request("/api/v1/runs", "GET", token, undefined, signal)
  if (!isRecord(payload) || payload.ok !== true || !Array.isArray(payload.runs))
    throw invalidResponse("Run history")
  if (!payload.runs.every(isRunSummary)) throw invalidResponse("Run history")
  return payload as RunsSnapshot
}

export async function fetchRun(
  token: string,
  runId: string,
  signal?: AbortSignal
) {
  const payload = await request(
    `/api/v1/runs/${encodeURIComponent(runId)}`,
    "GET",
    token,
    undefined,
    signal
  )
  if (!isRunDetail(payload)) throw invalidResponse("Run detail")
  return payload
}

export async function startRun(
  token: string,
  payload: {
    configuration_digest: string
    source_set_digest: string
    fixture?: "success" | "failure"
  }
) {
  const result = await request("/api/v1/runs", "POST", token, payload)
  if (!isRunDetail(result)) throw invalidResponse("started Run")
  return result
}

export async function cancelRun(token: string, runId: string) {
  return runAction(token, runId, "cancel")
}

export async function recoverRun(token: string, runId: string) {
  return runAction(token, runId, "recover")
}

async function runAction(
  token: string,
  runId: string,
  action: "cancel" | "recover"
) {
  const result = await request(
    `/api/v1/runs/${encodeURIComponent(runId)}/${action}`,
    "POST",
    token
  )
  if (!isRunDetail(result)) throw invalidResponse(`${action} Run`)
  return result
}

export async function fetchRunSnapshot(token: string, signal?: AbortSignal) {
  const payload = await request(
    "/api/v1/workspace/run-snapshot",
    "GET",
    token,
    undefined,
    signal
  )
  if (!isRecord(payload) || payload.ok !== true || !isRunModels(payload.models))
    throw invalidResponse("Gateway Run snapshot")
  return payload.models
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
    } satisfies RunsError
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
          : "The Production Run operation failed.",
    } satisfies RunsError
  }
  return payload
}

function isRunDetail(value: unknown): value is RunDetail & { ok: true } {
  return (
    isRunSummary(value) &&
    value.ok === true &&
    typeof value.project_id === "string" &&
    isStringArray(value.actionable_errors) &&
    isAudit(value.audit) &&
    Array.isArray(value.coverage_obligations) &&
    value.coverage_obligations.every(isCoverageObligation) &&
    Array.isArray(value.events) &&
    value.events.every(isEvent) &&
    Array.isArray(value.entity_events) &&
    value.entity_events.every(
      (event) =>
        isEvent(event) &&
        ["analysis_task", "coverage_obligation"].includes(
          String(event.entity_type)
        ) &&
        typeof event.entity_id === "string"
    ) &&
    Array.isArray(value.sources) &&
    value.sources.every(
      (source) =>
        isRecord(source) &&
        typeof source.id === "string" &&
        typeof source.role === "string" &&
        typeof source.revision === "string" &&
        (typeof source.tree_digest === "string" || source.tree_digest === null)
    ) &&
    (value.models === null || isRunModels(value.models)) &&
    isDiagnostics(value.diagnostics) &&
    isOperations(value.operations) &&
    isRecord(value.tasks) &&
    [value.tasks.active, value.tasks.completed, value.tasks.failed].every(
      (tasks) => Array.isArray(tasks) && tasks.every(isTask)
    )
  )
}

function isDiagnostics(value: unknown) {
  return (
    isRecord(value) &&
    isStringArray(value.actionable_errors) &&
    Number.isInteger(value.active_tasks) &&
    Number(value.active_tasks) >= 0 &&
    isAudit(value.audit) &&
    isRecord(value.budgets) &&
    Object.values(value.budgets).every(
      (budget) =>
        isRecord(budget) &&
        Number.isInteger(budget.remaining) &&
        Number.isInteger(budget.used)
    ) &&
    ["active", "interrupted", "review_blocked", "terminal"].includes(
      String(value.classification)
    ) &&
    Number.isInteger(value.failed_tasks) &&
    Number(value.failed_tasks) >= 0 &&
    isStringArray(value.review_blockers) &&
    isRecord(value.staging) &&
    typeof value.staging.exists === "boolean" &&
    typeof value.staging.path === "string" &&
    (value.terminal_outcome === null ||
      ["published", "failed", "cancelled"].includes(
        String(value.terminal_outcome)
      ))
  )
}

function isOperations(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.can_cancel === "boolean" &&
    typeof value.can_recover === "boolean" &&
    (value.recover_reason === null || typeof value.recover_reason === "string")
  )
}

function isRunSummary(
  value: unknown
): value is RunSummary & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.run_id === "string" &&
    states.has(value.state as RunState) &&
    value.phase === value.state &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    typeof value.source_set_digest === "string" &&
    (value.outcome === null ||
      ["review_required", "published", "failed", "cancelled"].includes(
        String(value.outcome)
      )) &&
    isExecution(value.execution)
  )
}

function isEvent(value: unknown) {
  return (
    isRecord(value) &&
    Number.isInteger(value.sequence) &&
    (typeof value.previous_state === "string" ||
      value.previous_state === null) &&
    typeof value.state === "string" &&
    typeof value.occurred_at === "string"
  )
}

function isTask(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.state === "string" &&
    isStringArray(value.obligation_ids) &&
    typeof value.source_id === "string" &&
    isStringArray(value.path_scope) &&
    typeof value.agent_role === "string" &&
    isNumberRecord(value.budgets) &&
    (value.receipt === null || isReceipt(value.receipt)) &&
    (value.error === undefined ||
      value.error === null ||
      typeof value.error === "string")
  )
}

function isExecution(value: unknown) {
  if (!isRecord(value)) return false
  if (value.mode === "deterministic_fixture")
    return ["success", "failure"].includes(String(value.requested_outcome))
  return (
    ["gateway_semantic", "legacy"].includes(String(value.mode)) &&
    (value.requested_outcome === undefined || value.requested_outcome === null)
  )
}

function isRunModels(value: unknown): value is RunModels {
  return (
    isRecord(value) &&
    isRecord(value.profile) &&
    typeof value.profile.id === "string" &&
    typeof value.profile.registered === "boolean" &&
    optionalString(value.profile.name) &&
    optionalString(value.profile.gateway_id) &&
    optionalString(value.profile.base_url) &&
    (value.profile.header_names === undefined ||
      isStringArray(value.profile.header_names)) &&
    (value.profile.revision === undefined ||
      Number.isInteger(value.profile.revision)) &&
    typeof value.default_model === "string" &&
    isStringRecord(value.assignments) &&
    Number.isInteger(value.concurrency) &&
    isNumberRecord(value.budgets) &&
    isNumberRecord(value.runtime_limits) &&
    isRecord(value.capabilities) &&
    Object.values(value.capabilities).every(isBooleanRecord)
  )
}

function isCoverageObligation(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.priority === "string" &&
    typeof value.disposition === "string" &&
    typeof value.source === "string" &&
    typeof value.role === "string" &&
    Array.isArray(value.state_changes) &&
    value.state_changes.every(
      (event) =>
        isEvent(event) &&
        event.entity_type === "coverage_obligation" &&
        typeof event.entity_id === "string"
    )
  )
}

function isAudit(value: unknown) {
  return (
    isRecord(value) &&
    [
      value.failures,
      value.latency_ms,
      value.retries,
      value.tokens,
      value.tool_calls,
    ].every((item) => Number.isInteger(item) && Number(item) >= 0) &&
    isStringArray(value.models) &&
    Array.isArray(value.by_role_model) &&
    value.by_role_model.every(isRoleModelAudit)
  )
}

function isRoleModelAudit(value: unknown) {
  return (
    isRecord(value) &&
    ["planner", "worker", "verifier"].includes(String(value.role)) &&
    typeof value.model === "string" &&
    [
      value.calls,
      value.failures,
      value.latency_ms,
      value.retries,
      value.tokens,
      value.tool_calls,
    ].every((item) => Number.isInteger(item) && Number(item) >= 0)
  )
}

function isReceipt(value: unknown) {
  return (
    isRecord(value) &&
    isStringArray(value.accepted_ids) &&
    isStringArray(value.unresolved_ids) &&
    isStringArray(value.warnings)
  )
}

function invalidResponse(label: string): RunsError {
  return {
    kind: "server",
    message: `The local service returned an invalid ${label} response.`,
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  )
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (item) => Number.isInteger(item) && Number(item) >= 0
    )
  )
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "boolean")
  )
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
