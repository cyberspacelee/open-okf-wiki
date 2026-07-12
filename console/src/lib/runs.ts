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
  execution: {
    mode: "deterministic_fixture" | "legacy"
    requested_outcome: "success" | "failure" | null
  }
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
  error?: string | null
}

export type RunDetail = RunSummary & {
  project_id: string
  actionable_errors: string[]
  events: RunEvent[]
  entity_events: EntityEvent[]
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
    fixture: "success" | "failure"
  }
) {
  const result = await request("/api/v1/runs", "POST", token, payload)
  if (!isRunDetail(result)) throw invalidResponse("started Run")
  return result
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
    isRecord(value.tasks) &&
    [value.tasks.active, value.tasks.completed, value.tasks.failed].every(
      (tasks) => Array.isArray(tasks) && tasks.every(isTask)
    )
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
    isRecord(value.execution) &&
    ["deterministic_fixture", "legacy"].includes(
      String(value.execution.mode)
    ) &&
    (value.execution.requested_outcome === null ||
      ["success", "failure"].includes(
        String(value.execution.requested_outcome)
      ))
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
    (value.error === undefined ||
      value.error === null ||
      typeof value.error === "string")
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
