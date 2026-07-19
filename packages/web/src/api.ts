const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8787";

export type WorkspaceSummary = {
  id: string;
  name: string;
  rootPath: string;
  lastOpenedAt?: string;
  sourceCount: number;
};

export type WorkspaceSource = {
  id: string;
  path: string;
  applyDefaultIgnores: boolean;
  ignore: string[];
};

export type WorkspaceConfig = {
  version: 1;
  id: string;
  name: string;
  rootPath: string;
  sources: WorkspaceSource[];
  model: { id: string };
  publicationPath: string;
  limits: {
    requestTimeoutSeconds: number;
    contextTargetTokens?: number;
    inputTokensLimit?: number;
    outputTokensLimit?: number;
    totalTokensLimit?: number;
    maxSteps?: number;
  };
  adaptive: boolean;
  reviewer: boolean;
  skillPath?: string;
  createdAt: string;
  lastOpenedAt?: string;
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
};

export type GitProbe = {
  path: string;
  isGit: boolean;
  head: string | null;
  branch: string | null;
  dirty: boolean;
  error: string | null;
};

export type SourceProbeResult = {
  sourceId: string;
  probe: GitProbe;
};

export type CreateWorkspaceInput = {
  name: string;
  rootPath: string;
  publicationPath?: string;
  modelId?: string;
};

export type PatchWorkspaceInput = {
  name?: string;
  modelId?: string;
  publicationPath?: string;
  adaptive?: boolean;
  reviewer?: boolean;
};

export type AddSourceInput = {
  path: string;
  id?: string;
};

export type WikiRunRecordStatus =
  | "running"
  | "published"
  | "needs_input"
  | "failed"
  | "cancelled"
  | "awaiting_publication"
  | "publication_declined";

export type StoredRunRecord = {
  runId: string;
  workspaceId: string;
  status: WikiRunRecordStatus;
  error?: string;
  autoApprove?: boolean;
  pages?: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
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

export type RunSseEvent = {
  type: "status" | "log" | "error" | "done";
  runId: string;
  sequence: number;
  status?: WikiRunRecordStatus;
  message?: string;
};

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
