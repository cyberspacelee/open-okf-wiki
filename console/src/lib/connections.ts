export type GatewayProfile = {
  id: string
  name: string
  gateway_id: string
  base_url: string
  header_names: string[]
  credential_backend: string | null
  credential_configured: boolean
  capabilities: Record<string, Record<string, boolean>>
  models: string[]
  revision: number
}

export type ModelSettings = {
  gateway_profile: string | null
  default_model: string | null
  role_overrides: Record<string, string>
  concurrency: number
  budgets: Record<string, number>
}

export type ConnectionsState = {
  profiles: GatewayProfile[]
  models: ModelSettings
}

export type ProfileInput = {
  id: string
  name: string
  gateway_id: string
  base_url: string
  headers: Record<string, string>
}

export type WorkspaceModelInput = {
  profile_id: string
  default_model: string
  concurrency: number
  budgets: Record<string, number>
  role_overrides: Record<string, string>
}

export async function loadConnections(
  token: string
): Promise<ConnectionsState> {
  const [profilePayload, workspacePayload] = await Promise.all([
    request(token, "/api/v1/gateway-profiles"),
    request(token, "/api/v1/workspace"),
  ])
  if (
    !isRecord(profilePayload) ||
    !Array.isArray(profilePayload.profiles) ||
    !isRecord(workspacePayload) ||
    !isRecord(workspacePayload.models)
  ) {
    throw new Error("The local service returned invalid connection settings.")
  }
  return {
    profiles: profilePayload.profiles as GatewayProfile[],
    models: workspacePayload.models as ModelSettings,
  }
}

export async function saveProfile(
  token: string,
  profile: ProfileInput,
  credential: string
) {
  return request(token, "/api/v1/gateway-profiles", {
    method: "POST",
    body: JSON.stringify({ profile, credential }),
  })
}

export async function testProfile(
  token: string,
  profileId: string,
  model: string
) {
  return request(
    token,
    `/api/v1/gateway-profiles/${encodeURIComponent(profileId)}/test`,
    { method: "POST", body: JSON.stringify({ model }) }
  )
}

export async function selectWorkspaceModels(
  token: string,
  models: WorkspaceModelInput
) {
  return request(token, "/api/v1/workspace/models", {
    method: "PUT",
    body: JSON.stringify(models),
  })
}

async function request(token: string, path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(responseMessage(payload))
  }
  return payload
}

function responseMessage(payload: unknown) {
  if (
    isRecord(payload) &&
    Array.isArray(payload.errors) &&
    typeof payload.errors[0] === "string"
  ) {
    return payload.errors[0]
  }
  return "The local service could not update gateway settings."
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
