/**
 * HTTP transport for the operator Web UI.
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type {
  GitProbe,
  ModelProfilePublic,
  ModelProfileWrite,
  OperatorSession,
  ProviderApiShape,
  ProviderPublic,
  ProviderTestResult,
  RunSseEvent,
  SkillFileContent,
  SkillFileEntry,
  SkillInfo,
  StoredRunRecord,
  ToolPartState,
  WikiLanguage,
  WikiRunPlan,
  WikiRunRecordStatus,
  WorkspaceConfig,
  WorkspaceSource,
  SourceOrigin,
} from "@okf-wiki/contract";

export type {
  GitProbe,
  ModelProfilePublic,
  OperatorSession,
  ProviderApiShape,
  ProviderPublic,
  ProviderTestResult,
  RunSseEvent,
  SkillFileContent,
  SkillFileEntry,
  SkillInfo,
  StoredRunRecord,
  ToolPartState,
  WikiLanguage,
  WikiRunPlan,
  WikiRunRecordStatus,
  WorkspaceConfig,
  WorkspaceSource,
  SourceOrigin,
};

/** Alias kept for existing call sites (create/update model profile body). */
export type ModelProfileWriteInput = ModelProfileWrite;

/**
 * API origin for fetch / EventSource.
 *
 * Default: **same origin** (empty string) so the UI works for any host:port
 * you open (127.0.0.1, localhost, or LAN IP). In dev, Vite proxies `/api` →
 * the local server (see vite.config.ts).
 *
 * Optional override: `VITE_API_BASE=http://host:8787` when the API is not
 * reverse-proxied on the same origin.
 */
function resolveApiBase(): string {
  const raw = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
  if (raw) {
    return raw.replace(/\/$/, "");
  }
  return "";
}

const API_BASE = resolveApiBase();

/** App-index list row (not the full WorkspaceConfig document). */
export type WorkspaceSummary = {
  id: string;
  name: string;
  rootPath: string;
  lastOpenedAt?: string;
  sourceCount: number;
};

export type HealthResponse = {
  ok: boolean;
  service: string;
  version?: string;
  pid?: number;
};

export type DoctorResponse = {
  ok: boolean;
  node: string;
  platform: string;
  arch: string;
  git: {
    available: boolean;
    version: string | null;
  };
  env: {
    openaiBaseUrlSet: boolean;
    openaiApiKeySet: boolean;
  };
  provider?: {
    configured: boolean;
    modelCount?: number;
    defaultModelProfileId?: string | null;
    baseUrlSet: boolean;
    apiKeySet: boolean;
    apiShape: ProviderApiShape;
    baseUrlSource: "stored" | "env" | "none";
    apiKeySource: "stored" | "env" | "none";
    baseUrlHost: string | null;
  };
};

export type SourceProbeResult = {
  sourceId: string;
  probe: GitProbe;
};

export type CreateWorkspaceInput = {
  name: string;
  rootPath: string;
  publicationPath?: string;
  /** Preferred: select a Settings model profile. */
  modelProfileId?: string;
  /** Legacy free-text model id. */
  modelId?: string;
};

export type PatchWorkspaceInput = {
  name?: string;
  modelProfileId?: string;
  modelId?: string;
  publicationPath?: string;
  adaptive?: boolean;
  reviewer?: boolean;
  planConfirm?: boolean;
  wikiLanguage?: WikiLanguage;
  skillPath?: string | null;
};

export type UpdateSourceInput = {
  applyDefaultIgnores?: boolean;
  ignore?: string[];
};

export type IgnoreCatalog = {
  defaultSourceIgnores: string[];
  presets: Record<string, { label: string; patterns: string[] }>;
};

export type AddSourceInput = {
  path: string;
  id?: string;
};

export type CloneSourceInput = {
  remoteUrl: string;
  id?: string;
  relativeDir?: string;
  ref?: string;
};

export type CreateRunInput = {
  autoApprove?: boolean;
};

/** @deprecated Prefer OperatorSession from contract; alias for call sites. */
export type OperatorSessionDto = OperatorSession;

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) {
      if (record.details !== undefined) {
        const details =
          typeof record.details === "string"
            ? record.details
            : JSON.stringify(record.details);
        return `${record.error}: ${details}`;
      }
      return record.error;
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body;
  }
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(0, `Network error: ${message}`);
  }

  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      errorMessageFromBody(body, `Request failed (${response.status})`),
      body,
    );
  }

  return body as T;
}

export function getApiBase(): string {
  return API_BASE;
}

/** Append optional rootPath query for workspace-scoped routes. */
function withRootPathQuery(path: string, rootPath?: string): string {
  if (!rootPath) {
    return path;
  }
  const params = new URLSearchParams({ rootPath });
  return `${path}?${params.toString()}`;
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

export function getDoctor(): Promise<DoctorResponse> {
  return request<DoctorResponse>("/api/doctor");
}

export function getProvider(): Promise<{ provider: ProviderPublic }> {
  return request<{ provider: ProviderPublic }>("/api/provider");
}

/** Machine-local app settings (home skills switch; page-editable only). */
export type AppSettingsPublic = {
  loadHomeSkills: boolean;
  loadHomeSkillsStored: boolean | null;
  homeSkillsDir: string;
  homeProducerSkill: string;
  workspaceSkillsRelative: string;
};

export function getAppSettings(): Promise<{ settings: AppSettingsPublic }> {
  return request<{ settings: AppSettingsPublic }>("/api/app-settings");
}

export function patchAppSettings(input: {
  loadHomeSkills: boolean;
}): Promise<{ settings: AppSettingsPublic }> {
  return request<{ settings: AppSettingsPublic }>("/api/app-settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function createModelProfile(
  input: ModelProfileWriteInput,
): Promise<{ provider: ProviderPublic; model?: ModelProfilePublic }> {
  return request("/api/provider/models", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateModelProfile(
  profileId: string,
  input: ModelProfileWriteInput,
): Promise<{ provider: ProviderPublic; model?: ModelProfilePublic }> {
  return request(`/api/provider/models/${encodeURIComponent(profileId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteModelProfile(
  profileId: string,
): Promise<{ provider: ProviderPublic }> {
  return request(`/api/provider/models/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
  });
}

export function setDefaultModelProfile(
  defaultModelProfileId: string | null,
): Promise<{ provider: ProviderPublic }> {
  return request("/api/provider/default", {
    method: "PUT",
    body: JSON.stringify({ defaultModelProfileId }),
  });
}

export function testProvider(input?: {
  modelProfileId?: string;
  baseUrl?: string;
  apiKey?: string;
  apiShape?: ProviderApiShape;
  modelId?: string;
}): Promise<{ result: ProviderTestResult }> {
  return request<{ result: ProviderTestResult }>("/api/provider/test", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export function listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
  return request<{ workspaces: WorkspaceSummary[] }>("/api/workspaces");
}

export function getWorkspace(
  id: string,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig }> {
  return request<{ workspace: WorkspaceConfig }>(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(id)}`, rootPath),
  );
}

export function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<{ workspace: WorkspaceConfig }> {
  return request<{ workspace: WorkspaceConfig }>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function patchWorkspace(
  id: string,
  input: PatchWorkspaceInput,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig }> {
  return request<{ workspace: WorkspaceConfig }>(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(id)}`, rootPath),
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

/**
 * Remove workspace from the app index.
 * When deleteFiles is true, also removes `<root>/.okf-wiki` (not the whole project tree).
 */
export function deleteWorkspace(
  id: string,
  options?: { rootPath?: string; deleteFiles?: boolean },
): Promise<{
  ok: boolean;
  id: string;
  removedFromIndex: boolean;
  deletedMeta: boolean;
  rootPath: string;
}> {
  const base = withRootPathQuery(
    `/api/workspaces/${encodeURIComponent(id)}`,
    options?.rootPath,
  );
  const sep = base.includes("?") ? "&" : "?";
  const url = options?.deleteFiles ? `${base}${sep}deleteFiles=true` : base;
  return request(url, { method: "DELETE" });
}

export function updateSource(
  workspaceId: string,
  sourceId: string,
  input: UpdateSourceInput,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig; source: WorkspaceSource }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}`,
      rootPath,
    ),
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export function getIgnoreCatalog(): Promise<IgnoreCatalog> {
  return request<IgnoreCatalog>("/api/ignore-catalog");
}

export function addSource(
  workspaceId: string,
  input: AddSourceInput,
  rootPath?: string,
): Promise<{
  workspace: WorkspaceConfig;
  source: WorkspaceSource;
  probe: GitProbe;
}> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sources`,
      rootPath,
    ),
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

/** Clone a remote git repo into the workspace and register it as a source. */
export function cloneSource(
  workspaceId: string,
  input: CloneSourceInput,
  rootPath?: string,
): Promise<{
  workspace: WorkspaceConfig;
  source: WorkspaceSource;
  probe: GitProbe;
}> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/clone`,
      rootPath,
    ),
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function getWorkspaceSkill(
  workspaceId: string,
  rootPath?: string,
): Promise<{ skill: SkillInfo }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/skill`,
      rootPath,
    ),
  );
}

export function createWorkspaceSkillFork(
  workspaceId: string,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig; skill: SkillInfo }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/skill/fork`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function resetWorkspaceSkill(
  workspaceId: string,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig; skill: SkillInfo }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/skill/reset`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function listWorkspaceSkillFiles(
  workspaceId: string,
  dirPath?: string,
  rootPath?: string,
): Promise<{
  skillPath: string;
  path: string;
  entries: SkillFileEntry[];
  writable: boolean;
}> {
  const base = withRootPathQuery(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skill/files`,
    rootPath,
  );
  const sep = base.includes("?") ? "&" : "?";
  const url =
    dirPath && dirPath.trim()
      ? `${base}${sep}path=${encodeURIComponent(dirPath.trim())}`
      : base;
  return request(url);
}

export function readWorkspaceSkillFile(
  workspaceId: string,
  filePath: string,
  rootPath?: string,
): Promise<{ file: SkillFileContent; writable: boolean }> {
  const base = withRootPathQuery(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skill/file`,
    rootPath,
  );
  const sep = base.includes("?") ? "&" : "?";
  return request(
    `${base}${sep}path=${encodeURIComponent(filePath)}`,
  );
}

export function writeWorkspaceSkillFile(
  workspaceId: string,
  input: { path: string; content: string },
  rootPath?: string,
): Promise<{ file: SkillFileContent; skill: SkillInfo }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/skill/files`,
      rootPath,
    ),
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export function deleteSource(
  workspaceId: string,
  sourceId: string,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}`,
      rootPath,
    ),
    { method: "DELETE" },
  );
}

export function probeSources(
  workspaceId: string,
  rootPath?: string,
): Promise<{ workspaceId: string; probes: SourceProbeResult[] }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/probe`,
      rootPath,
    ),
    { method: "POST" },
  );
}

export function listRuns(
  workspaceId: string,
  rootPath?: string,
): Promise<{ workspaceId: string; runs: StoredRunRecord[] }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs`,
      rootPath,
    ),
  );
}

export function createRun(
  workspaceId: string,
  input?: CreateRunInput,
  rootPath?: string,
): Promise<{ run: StoredRunRecord }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs`,
      rootPath,
    ),
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

// --- Operator Session (conversational workspace) ---

/** List row from GET /sessions (no message bodies). */
export type OperatorSessionSummary = {
  id: string;
  title: string;
  status: OperatorSession["status"];
  updatedAt: string;
  createdAt: string;
  pending?: OperatorSession["pending"];
  workflow?: OperatorSession["workflow"];
};

export function listSessions(
  workspaceId: string,
  rootPath?: string,
): Promise<{ sessions: OperatorSessionSummary[] }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
      rootPath,
    ),
  );
}

export function createSession(
  workspaceId: string,
  input?: { title?: string },
  rootPath?: string,
): Promise<{ session: OperatorSessionDto }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
      rootPath,
    ),
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export function getOrCreateSession(
  workspaceId: string,
  rootPath?: string,
): Promise<{ session: OperatorSessionDto; created: boolean }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/current`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function getSession(
  workspaceId: string,
  sessionId: string,
  rootPath?: string,
): Promise<{ session: OperatorSessionDto }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      rootPath,
    ),
  );
}

/** Clear stuck plan/publish gate; keeps transcript. */
export function resetSession(
  workspaceId: string,
  sessionId: string,
  rootPath?: string,
): Promise<{ session: OperatorSessionDto }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/reset`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify({}) },
  );
}

/** Delete a session thread permanently. */
export function deleteSession(
  workspaceId: string,
  sessionId: string,
  rootPath?: string,
): Promise<{ deleted: boolean; sessionId: string }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      rootPath,
    ),
    { method: "DELETE" },
  );
}

/**
 * Manual Retry: new run reusing frozen skillPath/skillDigest from a terminal run.
 */
export function retryRun(
  workspaceId: string,
  runId: string,
  rootPath?: string,
): Promise<{ run: StoredRunRecord; retriedFrom: string; skillDigest?: string }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/retry`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify({}) },
  );
}

/** HITL: approve proposed plan and continue write phase. */
export function approvePlan(
  workspaceId: string,
  runId: string,
  input?: { notes?: string; plan?: WikiRunPlan },
  rootPath?: string,
): Promise<{ run: StoredRunRecord }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/approve-plan`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify(input ?? {}) },
  );
}

/** HITL: decline plan; run becomes cancelled. */
export function denyPlan(
  workspaceId: string,
  runId: string,
  rootPath?: string,
): Promise<{ run: StoredRunRecord }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/deny-plan`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify({}) },
  );
}

/** HITL: approve publication of a run that is awaiting_publication. */
export function approvePublication(
  workspaceId: string,
  runId: string,
  rootPath?: string,
): Promise<{ run: StoredRunRecord; publicationPath: string; pageCount: number }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/approve-publication`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify({}) },
  );
}

/** HITL: decline publication; staging is retained. */
export function denyPublication(
  workspaceId: string,
  runId: string,
  rootPath?: string,
): Promise<{ run: StoredRunRecord }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/deny-publication`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify({}) },
  );
}

/** Best-effort cancel of a running Wiki Run. */
export function cancelRun(
  workspaceId: string,
  runId: string,
  rootPath?: string,
): Promise<{ run: StoredRunRecord }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/cancel`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify({}) },
  );
}

/** Absolute EventSource URL for run progress SSE. */
export function runEventsUrl(
  workspaceId: string,
  runId: string,
  rootPath?: string,
): string {
  return `${API_BASE}${withRootPathQuery(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/events`,
    rootPath,
  )}`;
}

export type WikiPageListResponse = {
  workspaceId: string;
  publicationPath: string;
  pages: string[];
};

export type WikiPageResponse = {
  path: string;
  content: string;
  title?: string;
};

/** List published wiki markdown pages (404 when missing/empty). */
export function listWikiPages(
  workspaceId: string,
  rootPath?: string,
): Promise<WikiPageListResponse> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/wiki`,
      rootPath,
    ),
  );
}

/**
 * Read one published wiki page by relative path (e.g. `overview.md`).
 * Uses the `?path=` query form so nested paths stay simple.
 */
export function getWikiPage(
  workspaceId: string,
  pagePath: string,
  rootPath?: string,
): Promise<WikiPageResponse> {
  const params = new URLSearchParams();
  params.set("path", pagePath);
  if (rootPath) {
    params.set("rootPath", rootPath);
  }
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/wiki?${params.toString()}`,
  );
}
