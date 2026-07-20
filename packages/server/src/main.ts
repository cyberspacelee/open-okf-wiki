import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  createSessionWorkflowStream,
  redactErrorMessage,
  resolveSkillPath,
  resumeWikiRun,
  sessionMessagesToUIMessages,
  startWikiRun,
  uiMessagesToSessionMessages,
  type SessionStreamBody,
} from "@okf-wiki/agent";
import {
  addSource,
  cloneIntoWorkspace,
  createModelProfile,
  createOperatorSession,
  createSkillFork,
  createWorkspace,
  DEFAULT_SOURCE_IGNORES,
  deleteModelProfile,
  deleteOperatorSession,
  deleteWorkspaceMeta,
  getModelProfile,
  getSkillInfo,
  hasProviderCredentials,
  listOperatorSessions,
  listPublishedWikiPages,
  listSkillDir,
  listWorkspaceSummaries,
  loadOperatorSession,
  loadProviderConfig,
  loadWorkspaceById,
  probeLocalGit,
  PublishedWikiError,
  readPublishedWikiPage,
  readSkillFile,
  registerWorkspaceInAppIndex,
  removeSource,
  removeWorkspaceFromAppIndex,
  replaceSessionMessages,
  resetOperatorSessionWorkflow,
  resolveProviderRuntime,
  saveWorkspace,
  setDefaultModelProfile,
  skillDigest,
  skillForkDir,
  slugFromPath,
  testProviderConnection,
  toProviderPublic,
  uniqueSourceId,
  updateModelProfile,
  updateSource,
  writeSkillFile,
} from "@okf-wiki/core";
import {
  consumeStream,
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
} from "ai";
import {
  IGNORE_PRESETS,
  isTerminalRunStatus,
  ModelProfileWriteSchema,
  ProviderApiShapeSchema,
  WikiLanguageSchema,
  WikiRunPlanSchema,
  WorkspaceLimitsSchema,
  type RunSseEvent,
  type WikiRunPlan,
  type WikiRunRecordStatus,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import {
  applyCors,
  BodyTooLargeError,
  InvalidJsonError,
  isLanAccessEnabled,
  matchRoute,
  readJsonBody,
  sendError,
  sendJson,
} from "./http-util.ts";
import {
  abortRun,
  clearRunAbortController,
  emitRunDone,
  emitRunEvent,
  emitRunStatus,
  registerRunAbortController,
  getRecentRunEvents,
  subscribeRunEvents,
} from "./run-events.ts";
import {
  createRun,
  listRuns,
  loadRun,
  registerRunRecord,
  RunStatusConflictError,
  updateRunRecord,
} from "./run-registry.ts";

const host = process.env.OKF_WIKI_HOST ?? "127.0.0.1";
const port = Number(process.env.OKF_WIKI_PORT ?? "8787");
const allowLan = isLanAccessEnabled();

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const LAN_BIND_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

// Default: loopback only. LAN requires explicit OKF_WIKI_ALLOW_LAN=1.
if (!LOOPBACK_HOSTS.has(host)) {
  if (!allowLan) {
    process.stderr.write(
      `refusing to bind non-loopback host "${host}" without OKF_WIKI_ALLOW_LAN=1\n` +
        `  local only:  OKF_WIKI_HOST=127.0.0.1 (default)\n` +
        `  LAN access:  OKF_WIKI_ALLOW_LAN=1 OKF_WIKI_HOST=0.0.0.0\n`,
    );
    process.exit(1);
  }
  if (!LAN_BIND_HOSTS.has(host) && !isPrivateOrLinkLocalHost(host)) {
    process.stderr.write(
      `refusing to bind host "${host}" even with LAN enabled (use 0.0.0.0 or a private IP)\n`,
    );
    process.exit(1);
  }
}

function isPrivateOrLinkLocalHost(value: string): boolean {
  // IPv4 private ranges only (simple operator LAN case).
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(value)) return true;
  return false;
}

function runGitVersion(): Promise<{ ok: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--version"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      resolve({ ok: false, version: null });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: stdout.trim() || null });
      } else {
        resolve({ ok: false, version: null });
      }
    });
  });
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    ok: true,
    service: "okf-wiki-server",
    version: "0.2.0-dev",
    pid: process.pid,
    host,
    port,
    allowLan,
  });
}

async function handleDoctor(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const git = await runGitVersion();
  const provider = await loadProviderConfig();
  const runtime = resolveProviderRuntime(provider);
  sendJson(res, 200, {
    ok: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    git: {
      available: git.ok,
      version: git.version,
    },
    env: {
      openaiBaseUrlSet: Boolean(process.env.OPENAI_BASE_URL),
      openaiApiKeySet: Boolean(process.env.OPENAI_API_KEY),
      // Never return secret values — flags only.
    },
    provider: {
      configured: hasProviderCredentials(provider),
      modelCount: provider.models.length,
      defaultModelProfileId: provider.defaultModelProfileId ?? null,
      baseUrlSet: runtime.source.baseUrl !== "none",
      apiKeySet: runtime.source.apiKey !== "none",
      apiShape: runtime.apiShape,
      baseUrlSource: runtime.source.baseUrl,
      apiKeySource: runtime.source.apiKey,
      baseUrlHost: runtime.baseUrl
        ? (() => {
            try {
              return new URL(runtime.baseUrl).host;
            } catch {
              return "(invalid)";
            }
          })()
        : null,
    },
  });
}

async function handleGetProvider(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = await loadProviderConfig();
  sendJson(res, 200, { provider: toProviderPublic(config) });
}

async function handleCreateModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as unknown;
  const parsed = ModelProfileWriteSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "invalid model profile", parsed.error.flatten());
    return;
  }
  try {
    const { config, profile } = await createModelProfile(parsed.data);
    sendJson(res, 201, {
      provider: toProviderPublic(config),
      model: toProviderPublic(config).models.find((m) => m.id === profile.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 400, message);
  }
}

async function handleUpdateModel(
  req: IncomingMessage,
  res: ServerResponse,
  profileId: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as unknown;
  const parsed = ModelProfileWriteSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "invalid model profile", parsed.error.flatten());
    return;
  }
  try {
    const { config, profile } = await updateModelProfile(profileId, parsed.data);
    sendJson(res, 200, {
      provider: toProviderPublic(config),
      model: toProviderPublic(config).models.find((m) => m.id === profile.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("model profile not found")) {
      sendError(res, 404, message);
      return;
    }
    sendError(res, 400, message);
  }
}

async function handleDeleteModel(
  _req: IncomingMessage,
  res: ServerResponse,
  profileId: string,
): Promise<void> {
  try {
    const config = await deleteModelProfile(profileId);
    sendJson(res, 200, { provider: toProviderPublic(config) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("model profile not found")) {
      sendError(res, 404, message);
      return;
    }
    sendError(res, 400, message);
  }
}

async function handleSetDefaultModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { defaultModelProfileId?: unknown };
  const id =
    body.defaultModelProfileId === null
      ? null
      : typeof body.defaultModelProfileId === "string"
        ? body.defaultModelProfileId.trim()
        : undefined;
  if (id === undefined) {
    sendError(res, 400, "defaultModelProfileId is required (string or null)");
    return;
  }
  try {
    const config = await setDefaultModelProfile(id || null);
    sendJson(res, 200, { provider: toProviderPublic(config) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("model profile not found")) {
      sendError(res, 404, message);
      return;
    }
    sendError(res, 400, message);
  }
}

async function handleTestProvider(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as {
    modelProfileId?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    apiShape?: unknown;
    modelId?: unknown;
  };

  const stored = await loadProviderConfig();
  const profileId =
    typeof body.modelProfileId === "string" && body.modelProfileId.trim()
      ? body.modelProfileId.trim()
      : undefined;
  const runtime = resolveProviderRuntime(stored, {
    profileId,
    modelId: typeof body.modelId === "string" ? body.modelId : undefined,
  });

  const baseUrl =
    typeof body.baseUrl === "string" && body.baseUrl.trim()
      ? body.baseUrl.trim()
      : runtime.baseUrl ?? "";

  let apiKey: string;
  if (typeof body.apiKey === "string") {
    apiKey = body.apiKey;
  } else {
    apiKey = runtime.source.apiKey !== "none" ? runtime.apiKey : "";
  }

  let apiShape = runtime.apiShape;
  if (body.apiShape !== undefined) {
    const shape = ProviderApiShapeSchema.safeParse(body.apiShape);
    if (!shape.success) {
      sendError(res, 400, "apiShape must be completions or responses");
      return;
    }
    apiShape = shape.data;
  }

  const modelId =
    typeof body.modelId === "string" && body.modelId.trim()
      ? body.modelId.trim()
      : runtime.modelId;

  if (!baseUrl) {
    sendError(res, 400, "base URL is required to test the connection");
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const result = await testProviderConnection({
      baseUrl,
      apiKey,
      apiShape,
      modelId,
      signal: controller.signal,
    });
    sendJson(res, 200, { result });
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve modelProfileId → denormalized model ref for workspace create/patch. */
async function resolveWorkspaceModelSelection(input: {
  modelProfileId?: string;
  modelId?: string;
}): Promise<{ id: string; profileId?: string }> {
  const catalog = await loadProviderConfig();

  if (input.modelProfileId) {
    const profile = getModelProfile(catalog, input.modelProfileId);
    return { id: profile.modelId, profileId: profile.id };
  }

  if (input.modelId?.trim()) {
    // Legacy free-text: keep id only (no profile link).
    return { id: input.modelId.trim() };
  }

  // Default profile when available.
  if (catalog.defaultModelProfileId) {
    const profile = getModelProfile(catalog, catalog.defaultModelProfileId);
    return { id: profile.modelId, profileId: profile.id };
  }
  if (catalog.models.length === 1) {
    const profile = catalog.models[0]!;
    return { id: profile.modelId, profileId: profile.id };
  }

  return { id: "openai/default" };
}

async function handleGitProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { path?: unknown };
  if (typeof body.path !== "string" || !body.path.trim()) {
    sendError(res, 400, "path is required");
    return;
  }
  const probe = await probeLocalGit(body.path);
  sendJson(res, 200, probe);
}

async function handleListWorkspaces(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const workspaces = await listWorkspaceSummaries();
  sendJson(res, 200, { workspaces });
}

async function handleCreateWorkspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as {
    name?: unknown;
    rootPath?: unknown;
    publicationPath?: unknown;
    modelId?: unknown;
    modelProfileId?: unknown;
  };
  if (typeof body.name !== "string" || !body.name.trim()) {
    sendError(res, 400, "name is required");
    return;
  }
  if (typeof body.rootPath !== "string" || !body.rootPath.trim()) {
    sendError(res, 400, "rootPath is required");
    return;
  }
  try {
    const model = await resolveWorkspaceModelSelection({
      modelProfileId:
        typeof body.modelProfileId === "string" ? body.modelProfileId.trim() : undefined,
      modelId: typeof body.modelId === "string" ? body.modelId : undefined,
    });
    const workspace = await createWorkspace({
      name: body.name,
      rootPath: body.rootPath,
      publicationPath:
        typeof body.publicationPath === "string" ? body.publicationPath : undefined,
      modelProfileId: model.profileId,
      resolvedModelId: model.id,
      modelId: model.id,
    });
    await saveWorkspace(workspace);
    await registerWorkspaceInAppIndex(workspace.rootPath);
    sendJson(res, 201, { workspace });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("workspace already exists")) {
      sendError(res, 409, message);
      return;
    }
    if (message.startsWith("model profile not found")) {
      sendError(res, 400, message);
      return;
    }
    // Absolute-path validation and other client errors → 400
    sendError(res, 400, message);
  }
}

async function handleGetWorkspace(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  // Do not rewrite workspace.json for lastOpenedAt — only bump recents index.
  await registerWorkspaceInAppIndex(workspace.rootPath);
  sendJson(res, 200, { workspace });
}

async function handlePatchWorkspace(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const next: WorkspaceConfig = { ...workspace };

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) {
      sendError(res, 400, "name must be a non-empty string ≤ 120 chars");
      return;
    }
    next.name = body.name.trim();
  }

  if (
    body.modelProfileId !== undefined ||
    body.modelId !== undefined ||
    body.model !== undefined
  ) {
    try {
      if (typeof body.modelProfileId === "string" && body.modelProfileId.trim()) {
        const model = await resolveWorkspaceModelSelection({
          modelProfileId: body.modelProfileId.trim(),
        });
        next.model = {
          id: model.id,
          ...(model.profileId ? { profileId: model.profileId } : {}),
        };
      } else if (typeof body.modelId === "string" && body.modelId.trim()) {
        // Legacy free-text path (no profile).
        next.model = { id: body.modelId.trim() };
      } else if (
        body.model &&
        typeof body.model === "object" &&
        typeof (body.model as { profileId?: unknown }).profileId === "string" &&
        (body.model as { profileId: string }).profileId.trim()
      ) {
        const model = await resolveWorkspaceModelSelection({
          modelProfileId: (body.model as { profileId: string }).profileId.trim(),
        });
        next.model = {
          id: model.id,
          ...(model.profileId ? { profileId: model.profileId } : {}),
        };
      } else if (
        body.model &&
        typeof body.model === "object" &&
        typeof (body.model as { id?: unknown }).id === "string" &&
        (body.model as { id: string }).id.trim()
      ) {
        next.model = { id: (body.model as { id: string }).id.trim() };
      } else {
        sendError(res, 400, "modelProfileId or modelId is required");
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 400, message);
      return;
    }
  }

  if (body.publicationPath !== undefined) {
    if (typeof body.publicationPath !== "string" || !body.publicationPath.trim()) {
      sendError(res, 400, "publicationPath must be a non-empty string");
      return;
    }
    next.publicationPath = path.resolve(body.publicationPath.trim());
  }

  if (body.adaptive !== undefined) {
    if (typeof body.adaptive !== "boolean") {
      sendError(res, 400, "adaptive must be a boolean");
      return;
    }
    next.adaptive = body.adaptive;
  }

  if (body.reviewer !== undefined) {
    if (typeof body.reviewer !== "boolean") {
      sendError(res, 400, "reviewer must be a boolean");
      return;
    }
    next.reviewer = body.reviewer;
  }

  if (body.limits !== undefined) {
    try {
      next.limits = WorkspaceLimitsSchema.parse(body.limits);
    } catch (error) {
      sendError(res, 400, "invalid limits", error instanceof Error ? error.message : String(error));
      return;
    }
  }

  if (body.skillPath !== undefined) {
    if (body.skillPath === null) {
      delete next.skillPath;
    } else if (typeof body.skillPath === "string" && body.skillPath.trim()) {
      next.skillPath = path.resolve(body.skillPath.trim());
    } else {
      sendError(res, 400, "skillPath must be a non-empty string or null");
      return;
    }
  }

  if (body.planConfirm !== undefined) {
    if (typeof body.planConfirm !== "boolean") {
      sendError(res, 400, "planConfirm must be a boolean");
      return;
    }
    next.planConfirm = body.planConfirm;
  }

  if (body.wikiLanguage !== undefined) {
    const parsed = WikiLanguageSchema.safeParse(body.wikiLanguage);
    if (!parsed.success) {
      sendError(res, 400, "wikiLanguage must be 'en' or 'zh'");
      return;
    }
    next.wikiLanguage = parsed.data;
  }

  // rootPath and id are immutable via PATCH
  await saveWorkspace(next);
  await registerWorkspaceInAppIndex(next.rootPath);
  sendJson(res, 200, { workspace: next });
}

async function handleDeleteWorkspace(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPathQuery = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPathQuery ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  await removeWorkspaceFromAppIndex(workspace.rootPath);

  const deleteFiles = url.searchParams.get("deleteFiles") === "true";
  let deletedMeta = false;
  if (deleteFiles) {
    try {
      await deleteWorkspaceMeta(workspace.rootPath);
      deletedMeta = true;
    } catch (error) {
      sendError(
        res,
        500,
        "removed from index but failed to delete .okf-wiki",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
  }

  sendJson(res, 200, {
    ok: true,
    id,
    removedFromIndex: true,
    deletedMeta,
    rootPath: workspace.rootPath,
  });
}

async function handleAddSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const body = (await readJsonBody(req)) as {
    path?: unknown;
    id?: unknown;
    applyDefaultIgnores?: unknown;
    ignore?: unknown;
  };

  if (typeof body.path !== "string" || !body.path.trim()) {
    sendError(res, 400, "path is required");
    return;
  }

  const sourcePath = path.resolve(body.path.trim());
  const desiredId =
    typeof body.id === "string" && body.id.trim()
      ? body.id.trim()
      : slugFromPath(sourcePath);
  const sourceId = uniqueSourceId(desiredId, workspace.sources);

  try {
    // Config editing: allow dirty trees; reject only non-git.
    const result = await addSource(
      workspace,
      {
        id: sourceId,
        path: sourcePath,
        applyDefaultIgnores:
          typeof body.applyDefaultIgnores === "boolean" ? body.applyDefaultIgnores : undefined,
        ignore: Array.isArray(body.ignore) ? (body.ignore as string[]) : undefined,
      },
      { requireClean: false },
    );
    await saveWorkspace(result.config);
    sendJson(res, 201, {
      workspace: result.config,
      source: result.source,
      probe: result.probe,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git/i.test(message)) {
      const probe = await probeLocalGit(sourcePath);
      sendError(res, 400, message, { probe });
      return;
    }
    if (/already (exists|registered)/i.test(message)) {
      sendError(res, 409, message);
      return;
    }
    sendError(res, 400, message);
  }
}

async function handleDeleteSource(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sourceId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  try {
    const next = removeSource(workspace, sourceId);
    await saveWorkspace(next);
    sendJson(res, 200, { workspace: next });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/source not found/i.test(message)) {
      sendError(res, 404, message);
      return;
    }
    sendError(res, 400, message);
  }
}

async function handleUpdateSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sourceId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const body = (await readJsonBody(req)) as {
    applyDefaultIgnores?: unknown;
    ignore?: unknown;
  };

  const patch: { applyDefaultIgnores?: boolean; ignore?: string[] } = {};
  if (body.applyDefaultIgnores !== undefined) {
    if (typeof body.applyDefaultIgnores !== "boolean") {
      sendError(res, 400, "applyDefaultIgnores must be a boolean");
      return;
    }
    patch.applyDefaultIgnores = body.applyDefaultIgnores;
  }
  if (body.ignore !== undefined) {
    if (!Array.isArray(body.ignore) || !body.ignore.every((p) => typeof p === "string")) {
      sendError(res, 400, "ignore must be an array of strings");
      return;
    }
    patch.ignore = body.ignore as string[];
  }
  if (patch.applyDefaultIgnores === undefined && patch.ignore === undefined) {
    sendError(res, 400, "provide applyDefaultIgnores and/or ignore");
    return;
  }

  try {
    const next = updateSource(workspace, sourceId, patch);
    await saveWorkspace(next);
    const source = next.sources.find((s) => s.id === sourceId);
    sendJson(res, 200, { workspace: next, source });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/source not found/i.test(message)) {
      sendError(res, 404, message);
      return;
    }
    sendError(res, 400, message);
  }
}

async function handleIgnoreCatalog(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, {
    defaultSourceIgnores: [...DEFAULT_SOURCE_IGNORES],
    presets: Object.fromEntries(
      Object.entries(IGNORE_PRESETS).map(([id, meta]) => [
        id,
        { label: meta.label, patterns: [...meta.patterns] },
      ]),
    ),
  });
}

async function handleProbeSources(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const probes = await Promise.all(
    workspace.sources.map(async (source) => ({
      sourceId: source.id,
      probe: await probeLocalGit(source.path),
    })),
  );
  sendJson(res, 200, { workspaceId: workspace.id, probes });
}

/**
 * Persist a status change and emit matching SSE events.
 * When status is terminal, also emits a `done` event so streams close.
 * Does not overwrite an already-cancelled record (cancel wins races);
 * `updateRunRecord` enforces this under concurrent cancel/finalize.
 */
async function finalizeRunStatus(
  rootPath: string,
  runId: string,
  patch: {
    status: WikiRunRecordStatus;
    error?: string | null;
    pages?: string[] | null;
    summary?: string | null;
    plan?: WikiRunPlan | null;
  },
): Promise<void> {
  const existing = await loadRun(rootPath, runId);
  if (existing?.status === "cancelled" && patch.status !== "cancelled") {
    // Cancel already recorded — keep it and ensure stream is closed.
    emitRunDone(runId, "cancelled", existing.summary ?? "Wiki Run cancelled");
    return;
  }

  const updated = await updateRunRecord(rootPath, runId, {
    status: patch.status,
    error: patch.error,
    pages: patch.pages,
    summary: patch.summary,
    ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
  });

  // TOCTOU: cancel may have landed between load and write; registry returns the
  // cancelled record unchanged when a non-cancel patch loses the race.
  if (updated.status === "cancelled" && patch.status !== "cancelled") {
    emitRunDone(runId, "cancelled", updated.summary ?? "Wiki Run cancelled");
    return;
  }

  if (isTerminalRunStatus(updated.status)) {
    emitRunDone(
      runId,
      updated.status,
      updated.error ?? updated.summary ?? updated.status,
    );
  } else {
    emitRunStatus(runId, updated.status, updated.summary ?? updated.status);
  }
}

type ProcessRunOptions = {
  autoApprove?: boolean;
  phase?: "plan" | "write";
  plan?: WikiRunPlan;
};

/**
 * Background Wiki Run via Mastra wiki-run workflow (single production path).
 * Plan/write/publish gates live in the workflow; autoApprove skips suspends.
 */
function processRunInBackground(
  workspace: WorkspaceConfig,
  runId: string,
  options: ProcessRunOptions = {},
): void {
  const autoApprove = options.autoApprove;
  const skipPlanConfirm =
    options.phase === "write" ||
    Boolean(options.plan) ||
    autoApprove === true ||
    !workspace.planConfirm;

  void (async () => {
    const abortSignal = registerRunAbortController(runId);
    emitRunStatus(
      runId,
      "running",
      skipPlanConfirm ? "Wiki Run started" : "Wiki Run plan phase started",
    );
    emitRunEvent(runId, {
      type: "log",
      message: skipPlanConfirm
        ? "wiki workflow started"
        : "wiki workflow plan phase started",
    });

    try {
      if (abortSignal.aborted) {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "cancelled",
          error: "cancelled",
          summary: "Wiki Run cancelled",
        });
        return;
      }

      const result = await startWikiRun({
        runId,
        workspace,
        autoApprove,
        skipPlanConfirm,
        plan: options.plan,
        abortSignal,
        onEvent: (event) => {
          if (event.type === "part") {
            emitRunEvent(runId, {
              type: "part",
              partType: event.partType,
              message: event.message,
              text: event.text,
              nodeId: event.nodeId,
            });
            return;
          }
          emitRunEvent(runId, {
            type: "log",
            message: event.message,
            nodeId: event.nodeId,
          });
        },
      });

      // Late abort must not rewrite durable publish outcomes.
      const durableSuccess =
        result.status === "published" ||
        result.status === "publication_declined";
      if (
        result.status === "cancelled" ||
        (abortSignal.aborted && !durableSuccess)
      ) {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "cancelled",
          error: "cancelled",
          pages: result.pages ?? null,
          summary: result.summary ?? "Wiki Run cancelled",
        });
        return;
      }

      if (result.status === "awaiting_plan") {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "awaiting_plan",
          error: null,
          pages: result.pages ?? null,
          summary: result.summary ?? "Awaiting plan confirmation",
          plan: result.plan ?? null,
        });
        emitRunEvent(runId, {
          type: "part",
          partType: "data-plan",
          message: result.plan?.summary ?? "plan ready",
          text: result.plan ? JSON.stringify(result.plan) : undefined,
        });
        return;
      }

      emitRunEvent(runId, {
        type: "log",
        message: result.summary ?? `workflow finished: ${result.status}`,
      });
      await finalizeRunStatus(workspace.rootPath, runId, {
        status: result.status,
        error: result.error ?? null,
        pages: result.pages ?? null,
        summary: result.summary ?? null,
        ...(result.plan ? { plan: result.plan } : {}),
      });
    } catch (error) {
      process.stderr.write(`run ${runId} failed: ${redactErrorMessage(error)}\n`);
      try {
        const status: WikiRunRecordStatus = abortSignal.aborted
          ? "cancelled"
          : "failed";
        await finalizeRunStatus(workspace.rootPath, runId, {
          status,
          error:
            status === "cancelled" ? "cancelled" : redactErrorMessage(error),
          summary: status === "cancelled" ? "Wiki Run cancelled" : undefined,
        });
      } catch (updateError) {
        process.stderr.write(
          `run ${runId} status update failed: ${redactErrorMessage(updateError)}\n`,
        );
      }
    } finally {
      clearRunAbortController(runId);
    }
  })();
}

/**
 * Resume a suspended wiki-run workflow (plan or publication) and persist status.
 */
function resumeRunInBackground(
  workspace: WorkspaceConfig,
  runId: string,
  gate: "plan" | "publication",
  action: "approve" | "deny",
  plan?: WikiRunPlan,
): void {
  void (async () => {
    const abortSignal = registerRunAbortController(runId);
    emitRunStatus(
      runId,
      "running",
      gate === "plan" ? "Resuming after plan decision" : "Resuming after publication decision",
    );
    try {
      if (abortSignal.aborted) {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "cancelled",
          error: "cancelled",
          summary: "Wiki Run cancelled",
        });
        return;
      }

      const result = await resumeWikiRun({
        runId,
        gate,
        action,
        plan,
        abortSignal,
        onEvent: (event) => {
          emitRunEvent(runId, {
            type: "log",
            message: event.message,
            nodeId: event.nodeId,
          });
        },
      });

      // Late abort must not rewrite durable publish outcomes.
      const durableSuccess =
        result.status === "published" ||
        result.status === "publication_declined";
      if (
        result.status === "cancelled" ||
        (abortSignal.aborted && !durableSuccess)
      ) {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "cancelled",
          error: "cancelled",
          pages: result.pages ?? null,
          summary: result.summary ?? "Wiki Run cancelled",
        });
        return;
      }

      if (result.status === "awaiting_plan") {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "awaiting_plan",
          error: null,
          plan: result.plan ?? plan ?? null,
          summary: result.summary ?? "Awaiting plan confirmation",
        });
        return;
      }

      if (result.status === "awaiting_publication") {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "awaiting_publication",
          error: null,
          pages: result.pages ?? null,
          summary: result.summary ?? "Awaiting publication approval",
          plan: result.plan ?? plan ?? null,
        });
        return;
      }

      await finalizeRunStatus(workspace.rootPath, runId, {
        status: result.status,
        error: result.error ?? null,
        pages: result.pages ?? null,
        summary: result.summary ?? null,
        ...(result.plan || plan ? { plan: result.plan ?? plan ?? null } : {}),
      });
    } catch (error) {
      process.stderr.write(
        `run ${runId} resume failed: ${redactErrorMessage(error)}\n`,
      );
      try {
        const status: WikiRunRecordStatus = abortSignal.aborted
          ? "cancelled"
          : "failed";
        await finalizeRunStatus(workspace.rootPath, runId, {
          status,
          error:
            status === "cancelled" ? "cancelled" : redactErrorMessage(error),
          summary: status === "cancelled" ? "Wiki Run cancelled" : undefined,
        });
      } catch {
        // best-effort status write
      }
    } finally {
      clearRunAbortController(runId);
    }
  })();
}


async function handleCreateRun(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  if (!workspace.sources || workspace.sources.length === 0) {
    sendError(res, 400, "workspace must have at least one source before starting a run");
    return;
  }

  // Dirty-tree gate: every source must be a clean git working tree before a run.
  for (const source of workspace.sources) {
    const probe = await probeLocalGit(source.path);
    if (!probe.isGit) {
      sendError(
        res,
        400,
        `source "${source.id}" is not a git working tree: ${source.path}`,
        { sourceId: source.id, probe },
      );
      return;
    }
    if (probe.dirty) {
      sendError(
        res,
        400,
        `source "${source.id}" has a dirty git working tree; commit or stash before starting a run: ${source.path}`,
        { sourceId: source.id, probe },
      );
      return;
    }
  }

  const body = (await readJsonBody(req)) as { autoApprove?: unknown };
  const autoApprove =
    typeof body.autoApprove === "boolean" ? body.autoApprove : undefined;

  // Freeze Producer Skill path + content digest for this run (Manual Retry input).
  let frozenSkillPath: string;
  let frozenSkillDigest: string;
  try {
    frozenSkillPath = await resolveSkillPath(workspace.skillPath);
    frozenSkillDigest = await skillDigest(frozenSkillPath);
  } catch (error) {
    sendError(
      res,
      400,
      error instanceof Error ? error.message : "failed to freeze producer skill",
    );
    return;
  }

  const run = await createRun(workspace.rootPath, workspace.id, {
    autoApprove,
    skillPath: frozenSkillPath,
    skillDigest: frozenSkillDigest,
  });
  processRunInBackground(workspace, run.runId, { autoApprove });
  sendJson(res, 201, { run });
}

/**
 * Manual Retry: new Wiki Run reusing the earlier run's frozen skill path/digest
 * (and autoApprove). Does not resume Semantic Workflow history.
 */
async function handleRetryRun(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  if (!workspace.sources || workspace.sources.length === 0) {
    sendError(res, 400, "workspace must have at least one source before retrying a run");
    return;
  }

  const previous = await loadRun(workspace.rootPath, runId);
  if (!previous || previous.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (
    previous.status === "running" ||
    previous.status === "awaiting_plan" ||
    previous.status === "awaiting_publication" ||
    previous.status === "needs_input"
  ) {
    sendError(
      res,
      409,
      `cannot retry an in-progress run (status: ${previous.status})`,
    );
    return;
  }

  // Dirty-tree gate (same as create).
  for (const source of workspace.sources) {
    const probe = await probeLocalGit(source.path);
    if (!probe.isGit) {
      sendError(
        res,
        400,
        `source "${source.id}" is not a git working tree: ${source.path}`,
        { sourceId: source.id, probe },
      );
      return;
    }
    if (probe.dirty) {
      sendError(
        res,
        400,
        `source "${source.id}" has a dirty git working tree; commit or stash before retry: ${source.path}`,
        { sourceId: source.id, probe },
      );
      return;
    }
  }

  let frozenSkillPath = previous.skillPath;
  let frozenSkillDigest = previous.skillDigest;
  try {
    if (!frozenSkillPath) {
      frozenSkillPath = await resolveSkillPath(workspace.skillPath);
    }
    if (!frozenSkillDigest) {
      frozenSkillDigest = await skillDigest(frozenSkillPath);
    } else {
      // Verify frozen path still has SKILL.md; digest is trusted from record.
      await resolveSkillPath(frozenSkillPath);
    }
  } catch (error) {
    sendError(
      res,
      400,
      error instanceof Error ? error.message : "failed to resolve frozen skill for retry",
    );
    return;
  }

  const run = await createRun(workspace.rootPath, workspace.id, {
    autoApprove: previous.autoApprove,
    skillPath: frozenSkillPath,
    skillDigest: frozenSkillDigest,
  });
  processRunInBackground(workspace, run.runId, {
    autoApprove: previous.autoApprove,
  });
  sendJson(res, 201, {
    run,
    retriedFrom: previous.runId,
    skillDigest: frozenSkillDigest,
  });
}

/**
 * HITL: approve a proposed plan and continue the write phase.
 * Headless/autoApprove never lands in awaiting_plan.
 */
async function handleApprovePlan(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const existing = await loadRun(workspace.rootPath, runId);
  if (!existing) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (existing.status !== "awaiting_plan") {
    sendError(res, 409, `run is not awaiting plan (status: ${existing.status})`);
    return;
  }

  const body = (await readJsonBody(req)) as { notes?: unknown; plan?: unknown };
  let plan = existing.plan;
  if (body.plan !== undefined) {
    try {
      plan = WikiRunPlanSchema.parse(body.plan);
    } catch (error) {
      sendError(
        res,
        400,
        "invalid plan",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
  }
  if (!plan) {
    sendError(res, 400, "no plan available to approve");
    return;
  }
  if (typeof body.notes === "string" && body.notes.trim()) {
    plan = { ...plan, notes: body.notes.trim() };
  }

  try {
    const updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "running",
      plan,
      summary: "Plan approved; write phase starting",
      error: null,
    });
    // Resume the suspended Mastra workflow plan-gate (same runId).
    resumeRunInBackground(workspace, runId, "plan", "approve", plan);
    sendJson(res, 200, { run: updated });
  } catch (error) {
    if (error instanceof RunStatusConflictError) {
      sendError(res, 409, error.message);
      return;
    }
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

/** HITL: decline plan — cancel the run without writing wiki pages. */
async function handleDenyPlan(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const existing = await loadRun(workspace.rootPath, runId);
  if (!existing) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (existing.status !== "awaiting_plan") {
    sendError(res, 409, `run is not awaiting plan (status: ${existing.status})`);
    return;
  }

  try {
    const updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "cancelled",
      error: "plan declined",
      summary: "Plan declined by operator",
    });
    // Best-effort: close suspended workflow snapshot.
    resumeRunInBackground(workspace, runId, "plan", "deny", existing.plan);
    emitRunDone(runId, "cancelled", "Plan declined by operator");
    sendJson(res, 200, { run: updated });
  } catch (error) {
    if (error instanceof RunStatusConflictError) {
      sendError(res, 409, error.message);
      return;
    }
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

async function handleCloneSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const body = (await readJsonBody(req)) as {
    remoteUrl?: unknown;
    id?: unknown;
    relativeDir?: unknown;
    ref?: unknown;
    applyDefaultIgnores?: unknown;
    ignore?: unknown;
  };

  if (typeof body.remoteUrl !== "string" || !body.remoteUrl.trim()) {
    sendError(res, 400, "remoteUrl is required");
    return;
  }

  const remoteUrl = body.remoteUrl.trim();
  const desiredId =
    typeof body.id === "string" && body.id.trim()
      ? body.id.trim()
      : slugFromPath(remoteUrl.replace(/\.git$/i, ""));
  const sourceId = uniqueSourceId(desiredId, workspace.sources);
  const relativeDir =
    typeof body.relativeDir === "string" && body.relativeDir.trim()
      ? body.relativeDir.trim()
      : undefined;
  const ref =
    typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined;

  try {
    const cloned = await cloneIntoWorkspace({
      workspaceRoot: workspace.rootPath,
      remoteUrl,
      sourceId,
      relativeDir,
      ref,
    });
    const result = await addSource(
      workspace,
      {
        id: sourceId,
        path: cloned.path,
        applyDefaultIgnores:
          typeof body.applyDefaultIgnores === "boolean"
            ? body.applyDefaultIgnores
            : undefined,
        ignore: Array.isArray(body.ignore) ? (body.ignore as string[]) : undefined,
        origin: {
          type: "clone",
          remoteUrl,
          ...(ref ? { ref } : {}),
          clonedAt: new Date().toISOString(),
        },
      },
      { requireClean: false },
    );
    await saveWorkspace(result.config);
    sendJson(res, 201, {
      workspace: result.config,
      source: result.source,
      probe: result.probe,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already (exists|registered)/i.test(message)) {
      sendError(res, 409, message);
      return;
    }
    sendError(res, 400, message);
  }
}

async function handleGetSkill(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  try {
    const bundled = await resolveSkillPath();
    const skill = await getSkillInfo({
      workspaceRoot: workspace.rootPath,
      skillPath: workspace.skillPath,
      bundledSkillPath: bundled,
    });
    sendJson(res, 200, { skill });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

async function handleCreateSkillFork(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  try {
    const bundled = await resolveSkillPath();
    const forkPath = await createSkillFork({
      workspaceRoot: workspace.rootPath,
      bundledSkillPath: bundled,
    });
    const next = { ...workspace, skillPath: forkPath };
    await saveWorkspace(next);
    const skill = await getSkillInfo({
      workspaceRoot: next.rootPath,
      skillPath: next.skillPath,
      bundledSkillPath: bundled,
    });
    sendJson(res, 201, { workspace: next, skill });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

async function handleResetSkill(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  const next = { ...workspace };
  delete next.skillPath;
  await saveWorkspace(next);
  try {
    const bundled = await resolveSkillPath();
    const skill = await getSkillInfo({
      workspaceRoot: next.rootPath,
      bundledSkillPath: bundled,
    });
    sendJson(res, 200, { workspace: next, skill });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

async function handleListSkillFiles(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  const dir = url.searchParams.get("path") ?? "";
  try {
    const skillRoot = await resolveSkillPath(workspace.skillPath);
    // Only allow writing later for forks; listing is OK for bundled too.
    const entries = await listSkillDir(skillRoot, dir);
    sendJson(res, 200, {
      skillPath: skillRoot,
      path: dir,
      entries,
      writable: Boolean(workspace.skillPath),
    });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

async function handleReadSkillFile(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  const filePath = url.searchParams.get("path") ?? "";
  if (!filePath.trim()) {
    sendError(res, 400, "path query is required");
    return;
  }
  try {
    const skillRoot = await resolveSkillPath(workspace.skillPath);
    const file = await readSkillFile(skillRoot, filePath);
    sendJson(res, 200, {
      file,
      writable: Boolean(workspace.skillPath),
    });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

async function handleWriteSkillFile(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  if (!workspace.skillPath) {
    sendError(res, 400, "create a skill fork before editing skill files");
    return;
  }
  const body = (await readJsonBody(req)) as { path?: unknown; content?: unknown };
  if (typeof body.path !== "string" || !body.path.trim()) {
    sendError(res, 400, "path is required");
    return;
  }
  if (typeof body.content !== "string") {
    sendError(res, 400, "content must be a string");
    return;
  }
  try {
    // Only write under the workspace skill fork path, never the bundled package.
    const forkPath = path.resolve(workspace.skillPath);
    const expectedFork = skillForkDir(workspace.rootPath);
    // Allow skillPath override only if it is still under workspace root meta or explicit fork.
    // For safety, require SKILL.md and refuse writing when path equals bundled.
    const bundled = await resolveSkillPath();
    if (path.resolve(forkPath) === path.resolve(bundled)) {
      sendError(res, 400, "refusing to write into the bundled producer skill");
      return;
    }
    const file = await writeSkillFile(forkPath, body.path.trim(), body.content);
    const skill = await getSkillInfo({
      workspaceRoot: workspace.rootPath,
      skillPath: workspace.skillPath,
      bundledSkillPath: bundled,
    });
    sendJson(res, 200, { file, skill, expectedFork });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

async function handleListRuns(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const runs = await listRuns(workspace.rootPath);
  sendJson(res, 200, { workspaceId: workspace.id, runs });
}

async function handleGetRun(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  sendJson(res, 200, { run });
}

/**
 * HITL: approve publication of a run that is awaiting_publication.
 * Copies staging → publicationPath and marks the run published.
 */
async function handleApprovePublication(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (run.status !== "awaiting_publication") {
    sendError(
      res,
      409,
      `run is not awaiting publication (status: ${run.status})`,
    );
    return;
  }

  try {
    const updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "running",
      error: null,
      summary: "Publication approved; publishing…",
    });
    resumeRunInBackground(workspace, runId, "publication", "approve");
    sendJson(res, 200, {
      run: updated,
      publicationPath: workspace.publicationPath,
    });
  } catch (error) {
    if (error instanceof RunStatusConflictError) {
      sendError(res, 409, error.message);
      return;
    }
    const message = redactErrorMessage(error);
    emitRunEvent(runId, {
      type: "error",
      status: "awaiting_publication",
      message: `publication failed: ${message}`,
    });
    sendError(res, 500, `publication failed: ${message}`);
  }
}

/**
 * HITL: decline publication. Staging is retained; run becomes publication_declined.
 */
async function handleDenyPublication(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (run.status !== "awaiting_publication") {
    sendError(
      res,
      409,
      `run is not awaiting publication (status: ${run.status})`,
    );
    return;
  }

  try {
    const updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "running",
      error: null,
      summary: "Publication declining…",
    });
    resumeRunInBackground(workspace, runId, "publication", "deny");
    sendJson(res, 200, { run: updated });
  } catch (error) {
    if (error instanceof RunStatusConflictError) {
      sendError(res, 409, error.message);
      return;
    }
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Cancel a run that is still `running` or suspended on operator HITL
 * (`awaiting_plan` / `awaiting_publication`).
 * Best-effort: aborts the agent signal, marks the record cancelled, and
 * resets any linked Operator Session so Stop at a gate does not leave
 * durable approve/deny chips for a cancelled run.
 */
async function handleCancelRun(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }
  if (
    run.status !== "running" &&
    run.status !== "awaiting_plan" &&
    run.status !== "awaiting_publication"
  ) {
    sendError(res, 409, `run is not cancellable (status: ${run.status})`);
    return;
  }

  abortRun(runId);
  emitRunEvent(runId, {
    type: "log",
    status: "running",
    message: "cancel requested",
  });

  let updated;
  try {
    updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "cancelled",
      error: "cancelled",
      summary: "Wiki Run cancelled",
    });
  } catch (error) {
    // Agent finalized between our status check and write — surface current state.
    if (error instanceof RunStatusConflictError) {
      sendError(
        res,
        409,
        `run is not running (status: ${error.record.status})`,
      );
      return;
    }
    throw error;
  }
  emitRunDone(runId, "cancelled", "Wiki Run cancelled");

  // Session-first: cancel after a stream has already finalized at a gate must
  // still clear durable HITL so refresh does not re-offer approve/deny.
  // Mid-stream cancel also races finalizeOnce; neutralize is idempotent.
  // Do not clobber a concurrent finalize that already persisted a durable
  // publish outcome (phase done / completed) while cancel won the run record.
  const linkedSessionId = updated.sessionId;
  if (linkedSessionId) {
    try {
      const linked = await loadOperatorSession(
        workspace.rootPath,
        linkedSessionId,
      );
      const phase = linked?.workflow?.phase;
      const durableSessionDone =
        phase === "done" || linked?.status === "completed";
      if (
        linked &&
        linked.workspaceId === workspace.id &&
        !durableSessionDone &&
        (linked.workflow?.linkedRunId === runId ||
          !linked.workflow?.linkedRunId)
      ) {
        const messages = neutralizeSessionDecisionParts(linked.messages);
        await replaceSessionMessages(
          workspace.rootPath,
          linkedSessionId,
          messages,
          {
            status: "active",
            pending: null,
            workflow: {
              ...linked.workflow,
              phase: "idle",
              linkedRunId: runId,
            },
          },
        );
      }
    } catch (error) {
      process.stderr.write(
        `session cancel cleanup failed: ${redactErrorMessage(error)}\n`,
      );
    }
  }

  sendJson(res, 200, { run: updated });
}

/** Map PublishedWikiError codes to HTTP status. */
function publishedWikiHttpStatus(code: PublishedWikiError["code"]): number {
  switch (code) {
    case "not_found":
    case "empty":
      return 404;
    case "invalid_path":
    case "symlink":
      return 400;
    case "too_large":
      return 413;
    case "io":
    default:
      return 500;
  }
}

/**
 * List published wiki pages under workspace.publicationPath.
 * GET /api/workspaces/:id/wiki?rootPath=
 */
async function handleListWiki(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  try {
    const pages = await listPublishedWikiPages(workspace.publicationPath);
    sendJson(res, 200, {
      workspaceId: workspace.id,
      publicationPath: workspace.publicationPath,
      pages,
    });
  } catch (error) {
    if (error instanceof PublishedWikiError) {
      sendError(res, publishedWikiHttpStatus(error.code), error.message, {
        code: error.code,
      });
      return;
    }
    throw error;
  }
}

/**
 * Read one published wiki markdown page.
 * GET /api/workspaces/:id/wiki/*path?rootPath=
 * GET /api/workspaces/:id/wiki?path=overview.md&rootPath=
 */
async function handleReadWiki(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  pagePath: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const trimmed = pagePath.trim();
  if (!trimmed) {
    sendError(res, 400, "path is required");
    return;
  }

  try {
    const page = await readPublishedWikiPage(workspace.publicationPath, trimmed);
    sendJson(res, 200, page);
  } catch (error) {
    if (error instanceof PublishedWikiError) {
      sendError(res, publishedWikiHttpStatus(error.code), error.message, {
        code: error.code,
      });
      return;
    }
    throw error;
  }
}

/**
 * Match /api/workspaces/:id/wiki and /api/workspaces/:id/wiki/**path.
 * Returns null when the path is not a wiki route.
 */
function matchWikiApiRoute(
  pathname: string,
): { id: string; pagePath: string | null } | null {
  const parts = pathname.split("/").filter(Boolean);
  // api / workspaces / :id / wiki [ / ...page ]
  if (parts.length < 4) {
    return null;
  }
  if (parts[0] !== "api" || parts[1] !== "workspaces" || parts[3] !== "wiki") {
    return null;
  }
  const id = decodeURIComponent(parts[2]!);
  if (parts.length === 4) {
    return { id, pagePath: null };
  }
  const pagePath = parts
    .slice(4)
    .map((p) => decodeURIComponent(p))
    .join("/");
  return { id, pagePath };
}

/**
 * SSE stream of run progress events.
 * Sends a status snapshot first, then live events until terminal, then closes.
 */
async function handleRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }

  const run = await loadRun(workspace.rootPath, runId);
  if (!run || run.workspaceId !== workspace.id) {
    sendError(res, 404, `run not found: ${runId}`);
    return;
  }

  // SSE headers (CORS already applied by dispatch).
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const writeEvent = (event: RunSseEvent): void => {
    if (res.writableEnded) {
      return;
    }
    res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  // Replay buffered stream parts so late subscribers still see text/tools
  // (fixture runs often finish before EventSource connects).
  const recent = getRecentRunEvents(runId);
  for (const event of recent) {
    writeEvent(event);
  }

  // Terminal snapshot last when the run already finished.
  if (isTerminalRunStatus(run.status)) {
    const snapshot: RunSseEvent = {
      type: "done",
      runId: run.runId,
      sequence: (recent[recent.length - 1]?.sequence ?? 0) + 1,
      status: run.status,
      message: run.error ?? run.summary ?? run.status,
    };
    writeEvent(snapshot);
    res.end();
    return;
  }

  // Live run: status snapshot if buffer was empty.
  if (recent.length === 0) {
    writeEvent({
      type: "status",
      runId: run.runId,
      sequence: 0,
      status: run.status,
      message: run.error ?? run.summary ?? run.status,
    });
  }

  let closed = false;
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      return;
    }
    // SSE comment heartbeat keeps intermediaries from closing idle streams.
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);

  // Skip replaying sequences already sent from the ring buffer.
  const lastReplayed = recent[recent.length - 1]?.sequence ?? -1;
  const unsubscribe = subscribeRunEvents(runId, (event) => {
    if (event.sequence <= lastReplayed) {
      return;
    }
    writeEvent(event);
    if (event.type === "done" || (event.status && isTerminalRunStatus(event.status))) {
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    req.off("close", onClose);
  };

  const onClose = (): void => {
    cleanup();
  };
  req.on("close", onClose);

  // Re-check status in case the run finished between load and subscribe.
  const latest = await loadRun(workspace.rootPath, runId);
  if (latest && isTerminalRunStatus(latest.status) && !closed) {
    writeEvent({
      type: "done",
      runId: latest.runId,
      sequence: lastReplayed + 1,
      status: latest.status,
      message: latest.error ?? latest.summary ?? latest.status,
    });
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  }
}

async function handleListSessions(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  const sessions = await listOperatorSessions(workspace.rootPath);
  sendJson(res, 200, {
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      pending: s.pending,
      workflow: s.workflow,
    })),
  });
}

async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  const body = (await readJsonBody(req).catch(() => ({}))) as { title?: unknown };
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : `Wiki Session · ${workspace.name}`;
  const session = await createOperatorSession({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
    title,
  });
  sendJson(res, 201, { session });
}

async function handleGetSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  const session = await loadOperatorSession(workspace.rootPath, sessionId);
  if (!session || session.workspaceId !== workspace.id) {
    sendError(res, 404, `session not found: ${sessionId}`);
    return;
  }
  sendJson(res, 200, { session });
}

async function handleDeleteSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, {
    rootPath: rootPath ?? undefined,
  });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  const existing = await loadOperatorSession(workspace.rootPath, sessionId);
  if (!existing || existing.workspaceId !== workspace.id) {
    sendError(res, 404, `session not found: ${sessionId}`);
    return;
  }
  const ok = await deleteOperatorSession(workspace.rootPath, sessionId);
  if (!ok) {
    sendError(res, 404, `session not found: ${sessionId}`);
    return;
  }
  sendJson(res, 200, { deleted: true, sessionId });
}

/** Clear pending gate / stuck phase so kickoff can run again. */
async function handleResetSession(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, {
    rootPath: rootPath ?? undefined,
  });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  const existing = await loadOperatorSession(workspace.rootPath, sessionId);
  if (!existing || existing.workspaceId !== workspace.id) {
    sendError(res, 404, `session not found: ${sessionId}`);
    return;
  }
  try {
    const session = await resetOperatorSessionWorkflow(
      workspace.rootPath,
      sessionId,
    );
    sendJson(res, 200, { session });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("session not found")) {
      sendError(res, 404, message);
      return;
    }
    sendError(res, 400, message);
  }
}

/**
 * In-process lock so rapid double-submit cannot start two Wiki Runs before
 * the first turn finalizes session messages. Keyed by workspace root + session.
 */
const sessionChatInFlight = new Set<string>();

function sessionChatLockKey(rootPath: string, sessionId: string): string {
  return `${path.resolve(rootPath)}::${sessionId}`;
}

/**
 * After product cancel, strip actionable HITL chips from durable history so a
 * refresh does not re-offer approve/deny on a cancelled run.
 */
function neutralizeSessionDecisionParts<
  T extends { role: string; parts: Array<Record<string, unknown> & { type: string }> },
>(messages: T[]): T[] {
  return messages.map((m) => {
    if (m.role !== "assistant") {
      return m;
    }
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (
          typeof p.type === "string" &&
          p.type === "tool-request_user_decision" &&
          p.state === "input-available"
        ) {
          return {
            ...p,
            state: "output-denied",
            output: { cancelled: true },
          };
        }
        if (p.type === "data-choice" && p.data && typeof p.data === "object") {
          const data = p.data as Record<string, unknown>;
          return {
            ...p,
            data: {
              ...data,
              cancelled: true,
              options: [],
              mode: "input_only",
            },
          };
        }
        return p;
      }),
    };
  });
}

/**
 * AI SDK UI message stream for conversational Session.
 *
 * Body (preferred): { message (last only), id?, resumeData?, runId?, step? }
 * Body (legacy):    { messages (full client history), resumeData?, runId?, step? }
 *
 * Server loads prior session messages, appends the new user message, streams,
 * then onFinish saves the full UIMessage-compatible history.
 */
async function handleSessionChat(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  const session = await loadOperatorSession(workspace.rootPath, sessionId);
  if (!session || session.workspaceId !== workspace.id) {
    sendError(res, 404, `session not found: ${sessionId}`);
    return;
  }

  let body: SessionStreamBody;
  try {
    body = (await readJsonBody(req)) as SessionStreamBody;
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      sendError(res, 400, "invalid JSON body");
      return;
    }
    if (error instanceof BodyTooLargeError) {
      sendError(res, 413, "request body too large");
      return;
    }
    throw error;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendError(res, 400, "chat body must be a JSON object");
    return;
  }

  // Server is source of truth: load history, append only the new last message.
  // Preferred: body.message (last only). Legacy: last entry of body.messages[].
  const previousUI = sessionMessagesToUIMessages(session.messages);
  let lastFromClient: UIMessage | undefined;
  if (body.message && typeof body.message === "object") {
    lastFromClient = body.message as UIMessage;
  } else if (Array.isArray(body.messages) && body.messages.length > 0) {
    // Multi-message fallback for older clients: take only the trailing user turn.
    lastFromClient = body.messages[body.messages.length - 1] as UIMessage;
  }

  if (
    !lastFromClient ||
    typeof lastFromClient !== "object" ||
    lastFromClient.role !== "user"
  ) {
    sendError(
      res,
      400,
      "chat body must include a user message (message or messages[])",
    );
    return;
  }
  if (typeof lastFromClient.id !== "string" || !lastFromClient.id.trim()) {
    sendError(res, 400, "user message must include a non-empty id");
    return;
  }
  if (!Array.isArray(lastFromClient.parts)) {
    // Normalize missing parts so conversion never throws.
    lastFromClient = { ...lastFromClient, parts: [] };
  }

  // Dedup by id if client re-sent a message already persisted.
  const alreadyStored = previousUI.some((m) => m.id === lastFromClient!.id);
  if (alreadyStored) {
    // Idempotent retry: do not re-run the workflow turn.
    pipeUIMessageStreamToResponse({
      response: res,
      stream: createUIMessageStream({
        originalMessages: previousUI,
        execute: async () => {
          /* no-op — history already contains this user turn */
        },
      }),
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-transform",
      },
    });
    return;
  }

  // Refuse resume against a cancelled/terminal run (Stop-at-gate race or stale chips).
  // Free-text approve/deny and structured resumeData both need a live suspend.
  const candidateRunId =
    (typeof body.runId === "string" && body.runId.trim()
      ? body.runId.trim()
      : undefined) ?? session.workflow?.linkedRunId;
  const lastText = (() => {
    for (const p of lastFromClient.parts ?? []) {
      if (
        p &&
        typeof p === "object" &&
        "type" in p &&
        (p as { type?: string }).type === "text" &&
        "text" in p &&
        typeof (p as { text?: unknown }).text === "string"
      ) {
        return (p as { text: string }).text.trim();
      }
    }
    return "";
  })();
  const looksLikeResume =
    Boolean(body.resumeData) ||
    lastText === "approve" ||
    lastText === "deny";
  if (looksLikeResume && candidateRunId) {
    const linkedRun = await loadRun(workspace.rootPath, candidateRunId);
    if (
      linkedRun &&
      linkedRun.status !== "awaiting_plan" &&
      linkedRun.status !== "awaiting_publication" &&
      linkedRun.status !== "running" &&
      linkedRun.status !== "needs_input"
    ) {
      // Reset session gate so the next turn can kick off cleanly.
      try {
        const cleaned = neutralizeSessionDecisionParts(session.messages);
        await replaceSessionMessages(
          workspace.rootPath,
          sessionId,
          cleaned,
          {
            status: "active",
            pending: null,
            workflow: {
              ...session.workflow,
              phase: "idle",
              linkedRunId: candidateRunId,
            },
          },
        );
      } catch {
        // best-effort
      }
      sendError(
        res,
        409,
        `cannot resume run (status: ${linkedRun.status}); start a new Wiki Run`,
      );
      return;
    }
  }

  const messages: UIMessage[] = [...previousUI, lastFromClient];

  // Reject concurrent turns for the same session (double-submit before finalize).
  const lockKey = sessionChatLockKey(workspace.rootPath, sessionId);
  if (sessionChatInFlight.has(lockKey)) {
    sendError(res, 409, "session chat turn already in progress");
    return;
  }
  sessionChatInFlight.add(lockKey);

  // Once the server drain task is scheduled, only finalizeOnce may release the lock.
  let serverDrainOwnsLock = false;
  // Track abort registration so setup failures before drain can clear the map.
  let registeredAbortRunId: string | undefined;

  try {
    // abortSignalForRun registers AbortController when mode/runId are known
    // (sync, before stream execute) so Stop → abortRun can hard-stop mid-step.
    const chat = await createSessionWorkflowStream({
      session: {
        ...session,
        messages: uiMessagesToSessionMessages(messages),
      },
      workspace,
      messages,
      body,
      abortSignalForRun: (runId) => {
        registeredAbortRunId = runId;
        return registerRunAbortController(runId);
      },
    });

    // Eager run registry on start so explicit Session Stop → cancel can target
    // the job while the first stream is still open (before finalize upsert).
    if (chat.mode === "start" && chat.runId) {
      try {
        const existing = await loadRun(workspace.rootPath, chat.runId);
        if (!existing) {
          let frozenSkillPath: string | undefined;
          let frozenSkillDigest: string | undefined;
          try {
            frozenSkillPath = await resolveSkillPath(workspace.skillPath);
            frozenSkillDigest = await skillDigest(frozenSkillPath);
          } catch {
            // optional freeze
          }
          await registerRunRecord(workspace.rootPath, workspace.id, {
            runId: chat.runId,
            status: "running",
            summary: "Session Wiki Run started",
            skillPath: frozenSkillPath,
            skillDigest: frozenSkillDigest,
            sessionId,
          });
        }
      } catch (error) {
        process.stderr.write(
          `session eager run register failed: ${redactErrorMessage(error)}\n`,
        );
      }
    }

    let finalized = false;
    const finalizeOnce = async () => {
      if (finalized) {
        return;
      }
      finalized = true;
      try {
        const result = await chat.finalize();
        let workflow = { ...result.workflow };
        let sessionStatus = result.status;
        let sessionPending = result.pending;

        if (result.sideEffects?.upsertRun) {
          const u = result.sideEffects.upsertRun;
          try {
            let frozenSkillPath: string | undefined;
            let frozenSkillDigest: string | undefined;
            try {
              frozenSkillPath = await resolveSkillPath(workspace.skillPath);
              frozenSkillDigest = await skillDigest(frozenSkillPath);
            } catch {
              // optional freeze
            }
            const existing = await loadRun(workspace.rootPath, u.runId);
            // Late abort / cancel must not rewrite durable publish outcomes
            // (same rule as processRunInBackground / cancelUnlessDurableSuccess).
            const durableSuccess =
              u.status === "published" || u.status === "publication_declined";
            const cancelledWin =
              !durableSuccess &&
              (existing?.status === "cancelled" || u.status === "cancelled");
            // Explicit Stop/cancel may mark the run cancelled while the stream
            // still drains. Cancel wins on the record; reset session gate state.
            if (cancelledWin) {
              workflow = {
                ...workflow,
                linkedRunId: u.runId,
                phase: "idle",
              };
              sessionStatus = "active";
              sessionPending = null;
              // Neutralize any mid-stream decision chips so durable history
              // does not leave actionable HITL after cancel.
              result.messages = neutralizeSessionDecisionParts(result.messages);
              if (!existing) {
                await registerRunRecord(workspace.rootPath, workspace.id, {
                  runId: u.runId,
                  status: "cancelled",
                  pages: u.pages,
                  summary: u.summary ?? "Wiki Run cancelled",
                  skillPath: frozenSkillPath,
                  skillDigest: frozenSkillDigest,
                  sessionId: u.sessionId ?? sessionId,
                });
              } else if (existing.status !== "cancelled") {
                await updateRunRecord(workspace.rootPath, u.runId, {
                  status: "cancelled",
                  pages: u.pages ?? null,
                  summary: u.summary ?? "Wiki Run cancelled",
                  error: "cancelled",
                  ...(u.sessionId || sessionId
                    ? { sessionId: u.sessionId ?? sessionId }
                    : {}),
                }).catch(() => undefined);
              }
            } else if (!existing) {
              await registerRunRecord(workspace.rootPath, workspace.id, {
                runId: u.runId,
                status: (u.status as WikiRunRecordStatus) ?? "running",
                pages: u.pages,
                summary: u.summary,
                skillPath: frozenSkillPath,
                skillDigest: frozenSkillDigest,
                sessionId: u.sessionId ?? sessionId,
              });
              workflow = {
                ...workflow,
                linkedRunId: u.runId,
              };
            } else {
              // Registry cancel-wins: if cancel already landed, updateRunRecord
              // keeps cancelled; session still reflects durableSuccess above.
              await updateRunRecord(workspace.rootPath, u.runId, {
                status: u.status as WikiRunRecordStatus,
                pages: u.pages ?? null,
                summary: u.summary ?? null,
                ...(u.plan ? { plan: u.plan } : {}),
                ...(u.sessionId || sessionId
                  ? { sessionId: u.sessionId ?? sessionId }
                  : {}),
                error: null,
              }).catch(() => undefined);
              workflow = {
                ...workflow,
                linkedRunId: u.runId,
              };
            }
          } catch (error) {
            process.stderr.write(
              `session run upsert failed: ${redactErrorMessage(error)}\n`,
            );
          }
        }

        // Cancel-vs-finalize TOCTOU: handleCancelRun may mark the run cancelled
        // after our loadRun snapshot (or after we wrote awaiting_*), then clean
        // the session. Re-read before replaceSessionMessages so a late finalize
        // cannot restore gate HITL over cancel cleanup.
        // Do not apply when the turn already produced a durable publish outcome.
        const linkedRunId =
          result.sideEffects?.upsertRun?.runId ?? chat.runId ?? undefined;
        const upsertStatus = result.sideEffects?.upsertRun?.status;
        const turnDurableSuccess =
          upsertStatus === "published" ||
          upsertStatus === "publication_declined";
        if (linkedRunId && !turnDurableSuccess) {
          try {
            const latest = await loadRun(workspace.rootPath, linkedRunId);
            if (latest?.status === "cancelled") {
              workflow = {
                ...workflow,
                linkedRunId,
                phase: "idle",
              };
              sessionStatus = "active";
              sessionPending = null;
              result.messages = neutralizeSessionDecisionParts(result.messages);
            }
          } catch {
            // best-effort; prefer writing stream outcome over blocking finalize
          }
        }

        // Persist full UIMessage timeline (text + tool + data parts), not only finalText.
        await replaceSessionMessages(
          workspace.rootPath,
          sessionId,
          result.messages,
          {
            status: sessionStatus,
            pending: sessionPending,
            workflow,
          },
        );

        // Post-write cancel barrier: cancel may land between the re-read above
        // and replaceSessionMessages, restoring gate HITL over cancel cleanup.
        // Skip when this turn already produced a durable publish outcome so a
        // cancel-wins run record cannot clobber session phase done/completed.
        if (linkedRunId && !turnDurableSuccess) {
          try {
            const after = await loadRun(workspace.rootPath, linkedRunId);
            if (after?.status === "cancelled") {
              const current = await loadOperatorSession(
                workspace.rootPath,
                sessionId,
              );
              if (
                current &&
                current.workflow?.phase !== "done" &&
                current.status !== "completed" &&
                (current.workflow?.phase === "awaiting_plan" ||
                  current.workflow?.phase === "awaiting_publish" ||
                  current.pending != null ||
                  current.status === "waiting")
              ) {
                await replaceSessionMessages(
                  workspace.rootPath,
                  sessionId,
                  neutralizeSessionDecisionParts(current.messages),
                  {
                    status: "active",
                    pending: null,
                    workflow: {
                      ...current.workflow,
                      linkedRunId,
                      phase: "idle",
                    },
                  },
                );
              }
            }
          } catch {
            // best-effort second pass
          }
        }
      } catch (error) {
        process.stderr.write(
          `session chat finalize failed: ${redactErrorMessage(error)}\n`,
        );
      } finally {
        sessionChatInFlight.delete(lockKey);
      }
    };

    // Disconnect durability (AI SDK consumeStream pattern):
    // tee the UI stream so the server fully drains one branch and always
    // finalizes/saves after execute + onFinish, even if the client aborts.
    // HTTP close cancels only the client tee branch (avoids backpressure stall)
    // and must NOT abort the underlying wiki run — explicit product cancel is
    // POST .../runs/:runId/cancel (Session Stop button calls that separately).
    const [clientStream, serverStream] = chat.stream.tee();

    serverDrainOwnsLock = true;
    void (async () => {
      try {
        await consumeStream({
          stream: serverStream,
          onError: (error) => {
            process.stderr.write(
              `session chat stream drain error: ${redactErrorMessage(error)}\n`,
            );
          },
        });
      } finally {
        // Drain completion means createUIMessageStream onFinish has run
        // (handleUIMessageStreamFinish flush), so finalize sees full messages.
        await finalizeOnce();
        if (chat.runId) {
          clearRunAbortController(chat.runId);
        }
      }
    })();

    const cancelClientBranch = () => {
      void clientStream.cancel().catch(() => undefined);
    };
    res.on("close", cancelClientBranch);

    pipeUIMessageStreamToResponse({
      response: res,
      stream: clientStream,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (error) {
    // Drain task (if started) finalizes, clears abort controller, and releases the lock.
    // If setup failed before drain ownership, release lock + abort map here.
    if (!serverDrainOwnsLock) {
      sessionChatInFlight.delete(lockKey);
      if (registeredAbortRunId) {
        clearRunAbortController(registeredAbortRunId);
      }
    }
    if (!res.headersSent) {
      sendError(
        res,
        500,
        error instanceof Error ? error.message : "session chat failed",
      );
    }
  }
}

/** Get or create the latest session for a workspace (v1 single default thread). */
async function handleGetOrCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const rootPath = url.searchParams.get("rootPath") ?? undefined;
  const workspace = await loadWorkspaceById(id, { rootPath: rootPath ?? undefined });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return;
  }
  const existing = await listOperatorSessions(workspace.rootPath);
  if (existing.length > 0) {
    sendJson(res, 200, { session: existing[0], created: false });
    return;
  }
  // Allow POST body title
  let title: string | undefined;
  if (req.method === "POST") {
    const body = (await readJsonBody(req).catch(() => ({}))) as { title?: unknown };
    if (typeof body.title === "string") {
      title = body.title;
    }
  }
  const session = await createOperatorSession({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
    title: title ?? `Wiki Session · ${workspace.name}`,
  });
  sendJson(res, 201, { session, created: true });
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const { pathname } = url;
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && pathname === "/api/health") {
      await handleHealth(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/doctor") {
      await handleDoctor(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/ignore-catalog") {
      await handleIgnoreCatalog(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/provider") {
      await handleGetProvider(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/provider/test") {
      await handleTestProvider(req, res);
      return;
    }
    if (method === "PUT" && pathname === "/api/provider/default") {
      await handleSetDefaultModel(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/provider/models") {
      await handleCreateModel(req, res);
      return;
    }
    {
      const params = matchRoute(pathname, "/api/provider/models/:id");
      if (params) {
        if (method === "PUT") {
          await handleUpdateModel(req, res, params.id!);
          return;
        }
        if (method === "DELETE") {
          await handleDeleteModel(req, res, params.id!);
          return;
        }
      }
    }
    if (method === "POST" && pathname === "/api/git/probe") {
      await handleGitProbe(req, res);
      return;
    }
    if (method === "GET" && pathname === "/api/workspaces") {
      await handleListWorkspaces(req, res);
      return;
    }
    if (method === "POST" && pathname === "/api/workspaces") {
      await handleCreateWorkspace(req, res);
      return;
    }

    // More specific source/run routes before generic :id
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/sources/probe");
      if (params && method === "POST") {
        await handleProbeSources(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/sources/clone");
      if (params && method === "POST") {
        await handleCloneSource(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/sources/:sourceId");
      if (params && method === "DELETE") {
        await handleDeleteSource(req, res, params.id!, params.sourceId!, url);
        return;
      }
      if (params && method === "PATCH") {
        await handleUpdateSource(req, res, params.id!, params.sourceId!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/sources");
      if (params && method === "POST") {
        await handleAddSource(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/skill/fork");
      if (params && method === "POST") {
        await handleCreateSkillFork(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/skill/reset");
      if (params && method === "POST") {
        await handleResetSkill(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/skill/files");
      if (params && method === "GET") {
        await handleListSkillFiles(req, res, params.id!, url);
        return;
      }
      if (params && method === "PUT") {
        await handleWriteSkillFile(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/skill/file");
      if (params && method === "GET") {
        await handleReadSkillFile(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/skill");
      if (params && method === "GET") {
        await handleGetSkill(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/sessions/current",
      );
      if (params && (method === "GET" || method === "POST")) {
        await handleGetOrCreateSession(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/sessions/:sessionId/chat",
      );
      if (params && method === "POST") {
        await handleSessionChat(req, res, params.id!, params.sessionId!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/sessions/:sessionId/reset",
      );
      if (params && method === "POST") {
        await handleResetSession(req, res, params.id!, params.sessionId!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/sessions/:sessionId",
      );
      if (params && method === "GET") {
        await handleGetSession(req, res, params.id!, params.sessionId!, url);
        return;
      }
      if (params && method === "DELETE") {
        await handleDeleteSession(req, res, params.id!, params.sessionId!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/sessions");
      if (params && method === "GET") {
        await handleListSessions(req, res, params.id!, url);
        return;
      }
      if (params && method === "POST") {
        await handleCreateSession(req, res, params.id!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/runs/:runId/retry",
      );
      if (params && method === "POST") {
        await handleRetryRun(req, res, params.id!, params.runId!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/runs/:runId/approve-plan",
      );
      if (params && method === "POST") {
        await handleApprovePlan(req, res, params.id!, params.runId!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/runs/:runId/deny-plan",
      );
      if (params && method === "POST") {
        await handleDenyPlan(req, res, params.id!, params.runId!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/runs/:runId/approve-publication",
      );
      if (params && method === "POST") {
        await handleApprovePublication(req, res, params.id!, params.runId!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/runs/:runId/deny-publication",
      );
      if (params && method === "POST") {
        await handleDenyPublication(req, res, params.id!, params.runId!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/runs/:runId/cancel",
      );
      if (params && method === "POST") {
        await handleCancelRun(req, res, params.id!, params.runId!, url);
        return;
      }
    }
    {
      const params = matchRoute(
        pathname,
        "/api/workspaces/:id/runs/:runId/events",
      );
      if (params && method === "GET") {
        await handleRunEvents(req, res, params.id!, params.runId!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/runs/:runId");
      if (params && method === "GET") {
        await handleGetRun(req, res, params.id!, params.runId!, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id/runs");
      if (params) {
        if (method === "GET") {
          await handleListRuns(req, res, params.id!, url);
          return;
        }
        if (method === "POST") {
          await handleCreateRun(req, res, params.id!, url);
          return;
        }
      }
    }
    // Published Wiki browse: list and read under publicationPath
    {
      const wikiMatch = matchWikiApiRoute(pathname);
      if (wikiMatch && method === "GET") {
        const queryPath = url.searchParams.get("path");
        if (wikiMatch.pagePath !== null) {
          await handleReadWiki(req, res, wikiMatch.id, wikiMatch.pagePath, url);
          return;
        }
        if (queryPath !== null && queryPath.trim() !== "") {
          await handleReadWiki(req, res, wikiMatch.id, queryPath, url);
          return;
        }
        await handleListWiki(req, res, wikiMatch.id, url);
        return;
      }
    }
    {
      const params = matchRoute(pathname, "/api/workspaces/:id");
      if (params) {
        if (method === "GET") {
          await handleGetWorkspace(req, res, params.id!, url);
          return;
        }
        if (method === "PATCH") {
          await handlePatchWorkspace(req, res, params.id!, url);
          return;
        }
        if (method === "DELETE") {
          await handleDeleteWorkspace(req, res, params.id!, url);
          return;
        }
      }
    }

    sendError(res, 404, "not found");
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      sendError(res, 400, error.message);
      return;
    }
    if (error instanceof BodyTooLargeError) {
      sendError(res, 413, error.message);
      return;
    }
    process.stderr.write(
      `request error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    sendError(res, 500, "internal server error");
  }
}

const server = createServer((req, res) => {
  void dispatch(req, res);
});

server.listen(port, host, () => {
  process.stdout.write(`okf-wiki server listening on http://${host}:${port}\n`);
  if (allowLan) {
    process.stdout.write(
      `LAN access enabled (OKF_WIKI_ALLOW_LAN=1). Use http://<this-machine-ip>:${port} from other devices.\n` +
        `Point the Web UI at the same host: VITE_API_BASE=http://<this-machine-ip>:${port}\n`,
    );
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `EADDRINUSE: port ${port} is already in use on ${host}. ` +
        `Stop the other process or set OKF_WIKI_PORT to a free port.\n`,
    );
  } else {
    process.stderr.write(
      `server listen error: ${err.stack ?? err.message}\n`,
    );
  }
  process.exit(1);
});
