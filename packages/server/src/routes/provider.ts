import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createModelProfile,
  deleteModelProfile,
  getModelProfile,
  loadProviderConfig,
  probeLocalGit,
  resolveProviderRuntime,
  setDefaultModelProfile,
  testProviderConnection,
  toProviderPublic,
  updateModelProfile,
} from "@okf-wiki/core";
import {
  ModelProfileWriteSchema,
  ProviderApiShapeSchema,
} from "@okf-wiki/contract";
import {
  readJsonBody,
  sendError,
  sendJson,
} from "../http-util.ts";

export async function handleGetProvider(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = await loadProviderConfig();
  sendJson(res, 200, { provider: toProviderPublic(config) });
}

export async function handleCreateModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

export async function handleUpdateModel(
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

export async function handleDeleteModel(
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

export async function handleSetDefaultModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

export async function handleTestProvider(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function resolveWorkspaceModelSelection(input: {
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

export async function handleGitProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { path?: unknown };
  if (typeof body.path !== "string" || !body.path.trim()) {
    sendError(res, 400, "path is required");
    return;
  }
  const probe = await probeLocalGit(body.path);
  sendJson(res, 200, probe);
}
