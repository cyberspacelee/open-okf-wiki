/**
 * HTTP transport for the operator Web UI.
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type {
  AgentCommand,
  AgentCommandResponse,
  CreatePiAgentSessionBody,
  CreatePiAgentSessionResponse,
  GitProbe,
  ModelProfilePublic,
  ModelProfileWrite,
  PiSessionSummary,
  ProviderApiShape,
  ProviderEntryPublic,
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
  WorkspaceSummary,
  SourceOrigin,
} from "@okf-wiki/contract";

export type {
  AgentCommand,
  AgentCommandResponse,
  CreatePiAgentSessionBody,
  CreatePiAgentSessionResponse,
  GitProbe,
  ModelProfilePublic,
  PiSessionSummary,
  ProviderApiShape,
  ProviderEntryPublic,
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
  WorkspaceSummary,
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
  planConfirm?: boolean;
  wikiLanguage?: WikiLanguage;
  skillPath?: string | null;
  /** Full workspace limits document (server replaces the limits object). */
  limits?: WorkspaceConfig["limits"];
  /** Hybrid model economics: planner / worker / writer / reviewers. */
  roleModels?: WorkspaceConfig["roleModels"];
  /** Supervisor tree budgets. */
  orchestration?: WorkspaceConfig["orchestration"];
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
  headers?: Record<string, string>;
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

/** HITL: revise plan with free-text feedback and re-suspend. */
export function revisePlan(
  workspaceId: string,
  runId: string,
  feedback: string,
  rootPath?: string,
): Promise<{ run: StoredRunRecord }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/revise-plan`,
      rootPath,
    ),
    { method: "POST", body: JSON.stringify({ feedback }) },
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

/** Domain/Leaf analysis receipt summary (from Host research). */
export type AnalysisReceiptSummary = {
  nodeId: string;
  parentId: string | null;
  status: string;
  scope: string;
  summary: string;
  relativePath: string;
  findingsCount: number;
  childReceipts: string[];
};

export type AnalysisReceiptDetail = {
  version?: number;
  runId: string;
  nodeId: string;
  parentId: string | null;
  attempt?: number;
  status: string;
  scope: string;
  summary: string;
  findings?: string[];
  evidence?: unknown[];
  childReceipts?: string[];
  openQuestions?: string[];
};

/** List analysis receipts for a Wiki Run. */
export function listRunReceipts(
  workspaceId: string,
  runId: string,
  rootPath?: string,
): Promise<{ runId: string; receipts: AnalysisReceiptSummary[] }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/receipts`,
      rootPath,
    ),
  );
}

/** Read one analysis receipt by nodeId. */
export function getRunReceipt(
  workspaceId: string,
  runId: string,
  nodeId: string,
  rootPath?: string,
): Promise<{ runId: string; receipt: AnalysisReceiptDetail }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/receipts/${encodeURIComponent(nodeId)}`,
      rootPath,
    ),
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

// --- Pi Agent Workspace (ADR 0030) ---
// Routes match packages/server/src/routes/agent-sessions.ts

/** List Pi agent sessions under `.okf-wiki/pi-sessions/`. */
export function listAgentSessions(
  workspaceId: string,
  rootPath?: string,
): Promise<{ sessions: PiSessionSummary[] }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions`,
      rootPath,
    ),
  );
}

/** Create a Pi agent session placeholder (stub until AgentSession factory lands). */
export function createAgentSession(
  workspaceId: string,
  input?: CreatePiAgentSessionBody,
  rootPath?: string,
): Promise<CreatePiAgentSessionResponse> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions`,
      rootPath,
    ),
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

/**
 * POST an AgentCommand (prompt | steer | abort | compact | start_wiki_run | resume_gate).
 * Server returns 202 with status `stub` | `accepted`.
 */
export function agentSessionCommand(
  workspaceId: string,
  sessionId: string,
  command: AgentCommand,
  rootPath?: string,
): Promise<AgentCommandResponse> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(sessionId)}/command`,
      rootPath,
    ),
    {
      method: "POST",
      body: JSON.stringify(command),
    },
  );
}

/** Absolute EventSource URL for Pi + product agent SSE. */
export function agentSessionEventsUrl(
  workspaceId: string,
  sessionId: string,
  rootPath?: string,
): string {
  return `${API_BASE}${withRootPathQuery(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(sessionId)}/events`,
    rootPath,
  )}`;
}

/** Cold-load Pi JSONL history + product meta (reload / reconnect). */
export type AgentSessionHistoryMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  status?: "done" | "error" | string;
  errorMessage?: string;
  createdAt?: string;
  tools?: Array<{ id: string; name: string; status: "running" | "done" | "error" }>;
};

export type AgentSessionSnapshot = {
  session: {
    id: string;
    workspaceId: string;
    title?: string;
    sessionFile?: string;
  };
  messages: AgentSessionHistoryMessage[];
  product: {
    runId?: string;
    runStatus?: string;
    phase?: string;
    /** True while server registry has an in-flight prompt/produce. */
    busy?: boolean;
    pendingGate?: {
      gate: "plan" | "publication";
      plan?: WikiRunPlan;
      pages?: string[];
    } | null;
    plan?: WikiRunPlan | null;
    /** Durable Work surface units (last-by-unitId fold from trajectory). */
    workUnits?: Array<{
      unitId: string;
      role: string;
      status: string;
      runId?: string;
      task?: string;
      parentId?: string;
      message?: { thinking?: string; text?: string };
      tools?: Array<{
        toolCallId: string;
        toolName: string;
        state: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
      }>;
      summary?: string;
      receiptPath?: string;
      error?: string;
      updatedAt?: number;
    }>;
    /** Full product inject history for cold project (optional). */
    trajectory?: unknown[];
  };
};

export function getAgentSession(
  workspaceId: string,
  sessionId: string,
  rootPath?: string,
): Promise<AgentSessionSnapshot> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(sessionId)}`,
      rootPath,
    ),
  );
}

/**
 * @deprecated Prefer {@link agentSessionCommand} with `{ type: "prompt", text }`.
 * Thin alias kept for early shell call sites.
 */
export function agentPrompt(
  workspaceId: string,
  sessionId: string,
  input: { text: string; intent?: string },
  rootPath?: string,
): Promise<AgentCommandResponse> {
  if (input.intent === "start_wiki_run") {
    return agentSessionCommand(
      workspaceId,
      sessionId,
      { type: "start_wiki_run", notes: input.text },
      rootPath,
    );
  }
  return agentSessionCommand(
    workspaceId,
    sessionId,
    { type: "prompt", text: input.text },
    rootPath,
  );
}

/**
 * @deprecated Prefer {@link agentSessionCommand} with `{ type: "abort" }`.
 */
export function agentAbort(
  workspaceId: string,
  sessionId: string,
  rootPath?: string,
): Promise<AgentCommandResponse> {
  return agentSessionCommand(
    workspaceId,
    sessionId,
    { type: "abort" },
    rootPath,
  );
}
