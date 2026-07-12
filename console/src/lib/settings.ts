export type WorkspaceDefinition = {
  schema_version: 1
  project: { id: string; name: string }
  publication: { path: string; bundle_name: string | null }
  sources: Array<Record<string, unknown>>
  profile: {
    java_excluded_paths: string[] | null
    priorities: Record<string, "major" | "supporting">
    dispositions: Partial<
      Record<
        "major" | "supporting",
        {
          disposition:
            "open" | "covered" | "deferred" | "excluded" | "blocked" | "failed"
          reason: string | null
        }
      >
    >
  }
}

export type LocalWorkspaceSettings = {
  schema_version: 1
  checkouts: Record<string, string>
  managed_checkouts: Record<
    string,
    { path: string; device: number; inode: number }
  >
  models: Record<string, unknown>
  ui: { compact_navigation: boolean }
}

export type WorkspaceSettings = {
  ok: true
  definition: WorkspaceDefinition
  local_settings: LocalWorkspaceSettings
  configuration_digest: string
}

export type SettingsError = {
  kind: "invalid" | "stale" | "server"
  message: string
}

export async function fetchSettings(
  token: string,
  signal?: AbortSignal
): Promise<WorkspaceSettings> {
  return requestSettings("GET", token, undefined, signal)
}

export async function saveSettings(
  token: string,
  settings: Omit<WorkspaceSettings, "ok">
): Promise<WorkspaceSettings> {
  return requestSettings("PUT", token, settings)
}

async function requestSettings(
  method: "GET" | "PUT",
  token: string,
  body?: Omit<WorkspaceSettings, "ok">,
  signal?: AbortSignal
) {
  let response: Response
  try {
    response = await fetch("/api/v1/settings", {
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
    } satisfies SettingsError
  }

  if (!response.ok) {
    throw {
      kind:
        response.status === 409
          ? "stale"
          : response.status < 500
            ? "invalid"
            : "server",
      message: await responseMessage(response),
    } satisfies SettingsError
  }

  const payload: unknown = await response.json().catch(() => null)
  if (!isWorkspaceSettings(payload)) {
    throw {
      kind: "server",
      message: "The local service returned an invalid Settings response.",
    } satisfies SettingsError
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
  return "The Workspace settings could not be saved."
}

function isWorkspaceSettings(value: unknown): value is WorkspaceSettings {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.configuration_digest !== "string"
  ) {
    return false
  }
  const definition = value.definition
  const local = value.local_settings
  if (!isRecord(definition) || !isRecord(local)) return false
  const project = definition.project
  const publication = definition.publication
  const profile = definition.profile
  const ui = local.ui
  return (
    definition.schema_version === 1 &&
    isRecord(project) &&
    typeof project.id === "string" &&
    typeof project.name === "string" &&
    isRecord(publication) &&
    typeof publication.path === "string" &&
    (publication.bundle_name === null ||
      typeof publication.bundle_name === "string") &&
    Array.isArray(definition.sources) &&
    definition.sources.every(isRecord) &&
    isRecord(profile) &&
    (profile.java_excluded_paths === null ||
      isStringArray(profile.java_excluded_paths)) &&
    isPriorities(profile.priorities) &&
    isDispositions(profile.dispositions) &&
    local.schema_version === 1 &&
    isStringRecord(local.checkouts) &&
    isManagedCheckouts(local.managed_checkouts) &&
    isRecord(local.models) &&
    isRecord(ui) &&
    typeof ui.compact_navigation === "boolean"
  )
}

function isManagedCheckouts(value: unknown) {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (item) =>
        isRecord(item) &&
        typeof item.path === "string" &&
        Number.isInteger(item.device) &&
        Number(item.device) >= 0 &&
        Number.isInteger(item.inode) &&
        Number(item.inode) >= 1
    )
  )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isStringRecord(value: unknown) {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  )
}

function isPriorities(value: unknown) {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (item) => item === "major" || item === "supporting"
    )
  )
}

function isDispositions(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["major", "supporting"].includes(key))
  ) {
    return false
  }
  return Object.values(value).every(
    (item) =>
      isRecord(item) &&
      ["open", "covered", "deferred", "excluded", "blocked", "failed"].includes(
        String(item.disposition)
      ) &&
      (item.reason === null || typeof item.reason === "string")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
