export type OverviewRun = {
  run_id: string
  state: string
  updated_at: string
}

export type OverviewBundle = OverviewRun & { path: string }

export type Overview = {
  ok: true
  project: { id: string; name: string }
  source_count: number
  latest_bundle: OverviewBundle | null
  active_run: OverviewRun | null
  blockers: string[]
  next_actions: string[]
}

export type OverviewError = {
  kind: "session" | "invalid-workspace" | "server"
  message: string
}

const SESSION_TOKEN_KEY = "okf-wiki-console-token"

export function consumeSessionToken() {
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const token = fragment.get("token")
  history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}`
  )

  if (token) {
    try {
      sessionStorage.setItem(SESSION_TOKEN_KEY, token)
    } catch {
      // The fragment token remains valid when browser storage is unavailable.
    }
    return token
  }

  try {
    return sessionStorage.getItem(SESSION_TOKEN_KEY)
  } catch {
    return null
  }
}

export async function fetchOverview(
  token: string,
  signal: AbortSignal
): Promise<Overview> {
  let response: Response

  try {
    response = await fetch("/api/v1/overview", {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })
  } catch {
    throw {
      kind: "server",
      message:
        "The local service did not respond. Restart the Console and try again.",
    } satisfies OverviewError
  }

  if (response.status === 400 || response.status === 422) {
    throw {
      kind: "invalid-workspace",
      message: await responseMessage(
        response,
        "The Workspace definition is invalid."
      ),
    } satisfies OverviewError
  }

  if (!response.ok) {
    throw {
      kind: "server",
      message: await responseMessage(
        response,
        "The local service could not load this Workspace."
      ),
    } satisfies OverviewError
  }

  const payload: unknown = await response.json().catch(() => null)
  if (!isOverview(payload)) {
    throw {
      kind: "server",
      message: "The local service returned an invalid Overview response.",
    } satisfies OverviewError
  }

  return payload
}

async function responseMessage(response: Response, fallback: string) {
  const payload: unknown = await response.json().catch(() => null)
  if (
    isRecord(payload) &&
    Array.isArray(payload.errors) &&
    typeof payload.errors[0] === "string" &&
    payload.errors[0].trim()
  ) {
    return payload.errors[0]
  }
  if (
    isRecord(payload) &&
    typeof payload.message === "string" &&
    payload.message.trim()
  ) {
    return payload.message
  }
  return fallback
}

function isOverview(value: unknown): value is Overview {
  if (!isRecord(value)) return false

  return (
    value.ok === true &&
    isProject(value.project) &&
    Number.isInteger(value.source_count) &&
    (value.source_count as number) >= 0 &&
    isNullableRun(value.latest_bundle, true) &&
    isNullableRun(value.active_run, false) &&
    isStringArray(value.blockers) &&
    isStringArray(value.next_actions)
  )
}

function isProject(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string"
  )
}

function isNullableRun(value: unknown, bundle: boolean) {
  if (value === null) return true
  if (!isRecord(value)) return false

  return (
    typeof value.run_id === "string" &&
    typeof value.state === "string" &&
    typeof value.updated_at === "string" &&
    (!bundle || typeof value.path === "string")
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
