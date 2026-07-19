import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { redactErrorMessage, runWikiAgent, stagingDirForRun } from "@okf-wiki/agent";
import {
  addSource,
  createWorkspace,
  deleteWorkspaceMeta,
  listPublishedWikiPages,
  listWorkspaceSummaries,
  loadWorkspaceById,
  probeLocalGit,
  PublishedWikiError,
  publishStagingToPublication,
  readPublishedWikiPage,
  registerWorkspaceInAppIndex,
  removeSource,
  removeWorkspaceFromAppIndex,
  saveWorkspace,
  slugFromPath,
  uniqueSourceId,
} from "@okf-wiki/core";
import {
  isTerminalRunStatus,
  WorkspaceLimitsSchema,
  type RunSseEvent,
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
  subscribeRunEvents,
} from "./run-events.ts";
import {
  createRun,
  listRuns,
  loadRun,
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
  });
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
    const workspace = await createWorkspace({
      name: body.name,
      rootPath: body.rootPath,
      publicationPath:
        typeof body.publicationPath === "string" ? body.publicationPath : undefined,
      modelId: typeof body.modelId === "string" ? body.modelId : undefined,
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

  if (body.modelId !== undefined || body.model !== undefined) {
    if (typeof body.modelId === "string" && body.modelId.trim()) {
      next.model = { id: body.modelId.trim() };
    } else if (
      body.model &&
      typeof body.model === "object" &&
      typeof (body.model as { id?: unknown }).id === "string" &&
      (body.model as { id: string }).id.trim()
    ) {
      next.model = { id: (body.model as { id: string }).id.trim() };
    } else {
      sendError(res, 400, "model or modelId must provide a non-empty id");
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
 * Publish staging → publicationPath for a run that is ready for publication.
 * Caller must ensure the run is in `awaiting_publication` (or just became so).
 */
async function publishRunStaging(
  workspace: WorkspaceConfig,
  runId: string,
): Promise<{ publicationPath: string; pageCount: number }> {
  const stagingDir = stagingDirForRun(workspace.rootPath, runId);
  return publishStagingToPublication({
    stagingDir,
    publicationPath: workspace.publicationPath,
    runId,
  });
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

/**
 * Background agent work for a run. Errors are written onto the run record.
 * When the agent reaches `awaiting_publication` and `autoApprove` is true,
 * the server publishes staging automatically and marks the run `published`.
 */
function processRunInBackground(
  workspace: WorkspaceConfig,
  runId: string,
  autoApprove: boolean | undefined,
): void {
  void (async () => {
    const abortSignal = registerRunAbortController(runId);
    emitRunStatus(runId, "running", "Wiki Run started");
    emitRunEvent(runId, { type: "log", message: "agent started" });

    try {
      // If cancel raced ahead of agent start, honor it immediately.
      if (abortSignal.aborted) {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "cancelled",
          error: "cancelled",
          summary: "Wiki Run cancelled",
        });
        return;
      }

      const result = await runWikiAgent({
        runId,
        workspace,
        autoApprove,
        abortSignal,
      });

      // Prefer cancelled if abort fired while agent was finishing.
      if (abortSignal.aborted || result.status === "cancelled") {
        await finalizeRunStatus(workspace.rootPath, runId, {
          status: "cancelled",
          error: "cancelled",
          pages: result.pages ?? null,
          summary: result.summary ?? "Wiki Run cancelled",
        });
        return;
      }

      if (result.status === "awaiting_publication" && autoApprove === true) {
        // Re-check abort before the publish side-effect (cancel can race here).
        if (abortSignal.aborted) {
          await finalizeRunStatus(workspace.rootPath, runId, {
            status: "cancelled",
            error: "cancelled",
            pages: result.pages ?? null,
            summary: result.summary ?? "Wiki Run cancelled",
          });
          return;
        }
        emitRunEvent(runId, {
          type: "log",
          message: "agent done; auto-publishing",
        });
        try {
          if (abortSignal.aborted) {
            await finalizeRunStatus(workspace.rootPath, runId, {
              status: "cancelled",
              error: "cancelled",
              pages: result.pages ?? null,
              summary: result.summary ?? "Wiki Run cancelled",
            });
            return;
          }
          const published = await publishRunStaging(workspace, runId);
          await finalizeRunStatus(workspace.rootPath, runId, {
            status: "published",
            error: null,
            pages: result.pages ?? null,
            summary:
              result.summary ??
              `Published ${published.pageCount} page(s) (auto-approve)`,
          });
          return;
        } catch (publishError) {
          await finalizeRunStatus(workspace.rootPath, runId, {
            status: "failed",
            error: `auto-publish failed: ${redactErrorMessage(publishError)}`,
            pages: result.pages ?? null,
            summary: result.summary ?? null,
          });
          return;
        }
      }

      emitRunEvent(runId, {
        type: "log",
        message: result.summary ?? `agent finished: ${result.status}`,
      });
      await finalizeRunStatus(workspace.rootPath, runId, {
        status: result.status,
        error: result.error ?? null,
        pages: result.pages ?? null,
        summary: result.summary ?? null,
      });
    } catch (error) {
      // Never log raw stacks — they may include API keys / tokens from model SDKs.
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

  const run = await createRun(workspace.rootPath, workspace.id, {
    autoApprove,
  });
  processRunInBackground(workspace, run.runId, autoApprove);
  sendJson(res, 201, { run });
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
    const published = await publishRunStaging(workspace, runId);
    const updated = await updateRunRecord(workspace.rootPath, runId, {
      status: "published",
      error: null,
      summary: run.summary ?? `Published ${published.pageCount} page(s)`,
    });
    emitRunDone(
      runId,
      "published",
      updated.summary ?? `Published ${published.pageCount} page(s)`,
    );
    sendJson(res, 200, {
      run: updated,
      publicationPath: published.publicationPath,
      pageCount: published.pageCount,
    });
  } catch (error) {
    // Stay in awaiting_publication so the operator can fix and retry approve.
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

  const updated = await updateRunRecord(workspace.rootPath, runId, {
    status: "publication_declined",
    error: null,
  });
  emitRunDone(runId, "publication_declined", "Publication declined");
  sendJson(res, 200, { run: updated });
}

/**
 * Cancel a run that is still `running`. Best-effort: aborts the agent signal
 * and marks the record cancelled; in-flight model work may finish shortly after.
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
  if (run.status !== "running") {
    sendError(res, 409, `run is not running (status: ${run.status})`);
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

  // Initial snapshot so the client does not need a separate GET.
  const snapshot: RunSseEvent = {
    type: isTerminalRunStatus(run.status) ? "done" : "status",
    runId: run.runId,
    sequence: 0,
    status: run.status,
    message: run.error ?? run.summary ?? run.status,
  };
  writeEvent(snapshot);

  if (isTerminalRunStatus(run.status)) {
    res.end();
    return;
  }

  let closed = false;
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      return;
    }
    // SSE comment heartbeat keeps intermediaries from closing idle streams.
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);

  const unsubscribe = subscribeRunEvents(runId, (event) => {
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
      sequence: snapshot.sequence + 1,
      status: latest.status,
      message: latest.error ?? latest.summary ?? latest.status,
    });
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  }
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
      const params = matchRoute(pathname, "/api/workspaces/:id/sources/:sourceId");
      if (params && method === "DELETE") {
        await handleDeleteSource(req, res, params.id!, params.sourceId!, url);
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
