import type { IncomingMessage, ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import path from "node:path";
import { resolveSkillSource } from "@okf-wiki/agent";
import {
  addSource,
  cloneIntoWorkspace,
  createSkillFork,
  createWorkspace,
  DEFAULT_SOURCE_IGNORES,
  deleteWorkspaceMeta,
  getSkillInfo,
  listSkillDir,
  listWorkspaceSummaries,
  loadWorkspaceById,
  probeLocalGit,
  readSkillFile,
  registerWorkspaceInAppIndex,
  removeSource,
  removeWorkspaceFromAppIndex,
  saveWorkspace,
  skillForkDir,
  slugFromPath,
  uniqueSourceId,
  updateSource,
  writeSkillFile,
} from "@okf-wiki/core";
import {
  IGNORE_PRESETS,
  WikiLanguageSchema,
  WorkspaceLimitsSchema,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import {
  readJsonBody,
  sendError,
  sendJson,
} from "../http-util.ts";
import { resolveWorkspaceModelSelection } from "./provider.ts";

export async function handleListWorkspaces(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const workspaces = await listWorkspaceSummaries();
  sendJson(res, 200, { workspaces });
}

export async function handleCreateWorkspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

export async function handleGetWorkspace(
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

export async function handlePatchWorkspace(
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

export async function handleDeleteWorkspace(
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

export async function handleAddSource(
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

export async function handleDeleteSource(
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

export async function handleUpdateSource(
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

export async function handleIgnoreCatalog(
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

export async function handleProbeSources(
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

export async function handleCloneSource(
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

export async function handleGetSkill(
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
    const active = await resolveSkillSource({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    const skill = await getSkillInfo(active);
    sendJson(res, 200, { skill });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleCreateSkillFork(
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
    // Fork from home/package default — not from an existing project skill.
    const fallback = await resolveSkillSource({});
    const forkPath = await createSkillFork({
      workspaceRoot: workspace.rootPath,
      sourceSkillPath: fallback.path,
    });
    const next = { ...workspace, skillPath: forkPath };
    await saveWorkspace(next);
    const skill = await getSkillInfo({ path: forkPath, kind: "fork" });
    sendJson(res, 201, { workspace: next, skill });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleResetSkill(
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
  // Remove project-level `.agents/skills/<producer>` so resolution falls back
  // to home/package (Grok-like: no project skill = not project-scoped).
  try {
    const projectSkill = skillForkDir(workspace.rootPath);
    await rm(projectSkill, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  try {
    const active = await resolveSkillSource({
      workspaceRoot: next.rootPath,
    });
    const skill = await getSkillInfo(active);
    sendJson(res, 200, { workspace: next, skill });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleListSkillFiles(
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
    const active = await resolveSkillSource({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    const entries = await listSkillDir(active.path, dir);
    sendJson(res, 200, {
      skillPath: active.path,
      path: dir,
      entries,
      writable: active.kind === "fork",
    });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleReadSkillFile(
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
    const active = await resolveSkillSource({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    const file = await readSkillFile(active.path, filePath);
    sendJson(res, 200, {
      file,
      writable: active.kind === "fork",
    });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleWriteSkillFile(
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
    // Only write under the workspace `.agents/skills` producer path.
    const forkPath = path.resolve(workspace.skillPath);
    const expectedFork = skillForkDir(workspace.rootPath);
    if (path.resolve(forkPath) !== path.resolve(expectedFork)) {
      // Allow writing only into the canonical project skill directory.
      sendError(
        res,
        400,
        `skill writes must target the project skill at ${expectedFork}`,
      );
      return;
    }
    const file = await writeSkillFile(forkPath, body.path.trim(), body.content);
    const skill = await getSkillInfo({ path: forkPath, kind: "fork" });
    sendJson(res, 200, { file, skill, expectedFork });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}
