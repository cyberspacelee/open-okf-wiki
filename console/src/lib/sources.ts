export type SourceRole =
  "implementation" | "documentation" | "requirements" | "contract"

export type SourceCheckout = {
  id: string
  role: SourceRole
  revision: string
  ownership: "managed" | "linked" | null
  checkout: string | null
  remote: string | null
  branch: string | null
  commit: string | null
  dirty: boolean | null
  ahead: number | null
  behind: number | null
  error: string | null
}

export type SourcesSnapshot = {
  ok: true
  configuration_digest: string
  sources: SourceCheckout[]
  retained_managed: Array<{ id: string; checkout: string }>
}

export type SourcesError = {
  kind: "invalid" | "server"
  message: string
}

export function fetchSources(token: string, signal?: AbortSignal) {
  return requestSources("/api/v1/sources", "GET", token, undefined, signal)
}

export function cloneSource(
  token: string,
  payload: { id: string; role: SourceRole; remote: string }
) {
  return requestSources("/api/v1/sources/clone", "POST", token, payload)
}

export function cloneConfiguredSource(token: string, id: string) {
  return requestSources("/api/v1/sources/clone", "POST", token, { id })
}

export function linkSource(
  token: string,
  payload: { id: string; role: SourceRole; checkout: string }
) {
  return requestSources("/api/v1/sources/link", "POST", token, payload)
}

export function linkConfiguredSource(
  token: string,
  id: string,
  checkout: string
) {
  return requestSources("/api/v1/sources/link", "POST", token, {
    id,
    checkout,
  })
}

export function removeSource(token: string, id: string) {
  return requestSources("/api/v1/sources/remove", "POST", token, { id })
}

export function deleteManagedSource(
  token: string,
  id: string,
  confirmation: string
) {
  return requestSources("/api/v1/sources/delete-managed", "POST", token, {
    id,
    confirmation,
  })
}

async function requestSources(
  path: string,
  method: "GET" | "POST",
  token: string,
  body?: object,
  signal?: AbortSignal
): Promise<SourcesSnapshot> {
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
    } satisfies SourcesError
  }
  if (!response.ok) {
    throw {
      kind: response.status < 500 ? "invalid" : "server",
      message: await responseMessage(response),
    } satisfies SourcesError
  }
  const payload: unknown = await response.json().catch(() => null)
  if (!isSourcesSnapshot(payload)) {
    throw {
      kind: "server",
      message: "The local service returned an invalid Sources response.",
    } satisfies SourcesError
  }
  return payload
}

async function responseMessage(response: Response) {
  const payload: unknown = await response.json().catch(() => null)
  if (
    isRecord(payload) &&
    Array.isArray(payload.errors) &&
    typeof payload.errors[0] === "string" &&
    payload.errors[0].trim()
  ) {
    return payload.errors[0]
  }
  return "The Source Checkout operation failed."
}

function isSourcesSnapshot(value: unknown): value is SourcesSnapshot {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.configuration_digest === "string" &&
    Array.isArray(value.sources) &&
    value.sources.every(isSource) &&
    Array.isArray(value.retained_managed) &&
    value.retained_managed.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.checkout === "string"
    )
  )
}

function isSource(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    ["implementation", "documentation", "requirements", "contract"].includes(
      String(value.role)
    ) &&
    typeof value.revision === "string" &&
    (value.ownership === "managed" ||
      value.ownership === "linked" ||
      value.ownership === null) &&
    nullableString(value.checkout) &&
    nullableString(value.remote) &&
    nullableString(value.branch) &&
    nullableString(value.commit) &&
    (typeof value.dirty === "boolean" || value.dirty === null) &&
    nullableNumber(value.ahead) &&
    nullableNumber(value.behind) &&
    nullableString(value.error)
  )
}

function nullableString(value: unknown) {
  return value === null || typeof value === "string"
}

function nullableNumber(value: unknown) {
  return value === null || (Number.isInteger(value) && Number(value) >= 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
