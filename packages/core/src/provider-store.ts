import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  ModelProfileSchema,
  ProviderConfigSchema,
  ProviderConfigV1Schema,
  type ModelProfile,
  type ModelProfilePublic,
  type ModelProfileWrite,
  type ProviderApiShape,
  type ProviderConfig,
  type ProviderPublic,
  type ProviderTestResult,
} from "@okf-wiki/contract";
import { WORKSPACE_DIR_NAME } from "./workspace-store.js";

export const PROVIDER_FILE_NAME = "provider.json";

/**
 * User-level provider config path.
 * `$OKF_WIKI_HOME/provider.json` when set, otherwise `~/.okf-wiki/provider.json`.
 */
export function defaultProviderPath(): string {
  const home = process.env.OKF_WIKI_HOME?.trim();
  if (home) {
    return path.join(path.resolve(home), PROVIDER_FILE_NAME);
  }
  return path.join(homedir(), WORKSPACE_DIR_NAME, PROVIDER_FILE_NAME);
}

const emptyProvider = (): ProviderConfig =>
  ProviderConfigSchema.parse({
    version: 2,
    models: [],
  });

/** Migrate legacy v1 single-endpoint file into a one-entry catalog. */
export function migrateProviderConfigV1(raw: unknown): ProviderConfig | null {
  const parsed = ProviderConfigV1Schema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  // Detect v1: version 1, or missing version with baseUrl/apiKey fields and no models array.
  const asRecord = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (asRecord.version === 2 || Array.isArray(asRecord.models)) {
    return null;
  }
  if (
    asRecord.version !== 1 &&
    asRecord.version !== undefined &&
    !("baseUrl" in asRecord) &&
    !("apiKey" in asRecord)
  ) {
    return null;
  }

  const v1 = parsed.data;
  const hasAny =
    Boolean(v1.baseUrl?.trim()) ||
    Boolean(v1.apiKey?.trim()) ||
    Boolean(v1.defaultModelId?.trim());
  if (!hasAny) {
    return emptyProvider();
  }

  const modelId = v1.defaultModelId?.trim() || "openai/default";
  const profile: ModelProfile = ModelProfileSchema.parse({
    id: "default",
    name: "Default",
    providerKind: "openai-compatible",
    modelId,
    baseUrl: v1.baseUrl?.trim() ?? "",
    apiKey: v1.apiKey ?? "",
    apiShape: v1.apiShape ?? "completions",
  });
  return ProviderConfigSchema.parse({
    version: 2,
    defaultModelProfileId: profile.id,
    models: [profile],
  });
}

function normalizeLoaded(data: unknown): ProviderConfig {
  const migrated = migrateProviderConfigV1(data);
  if (migrated) {
    return migrated;
  }
  return ProviderConfigSchema.parse(data);
}

/** Load stored provider config; missing file yields empty catalog. */
export async function loadProviderConfig(
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  try {
    const raw = await readFile(providerPath, "utf8");
    const data = JSON.parse(raw) as unknown;
    return normalizeLoaded(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return emptyProvider();
    }
    if (error instanceof SyntaxError) {
      throw new Error(`provider config is not valid JSON: ${providerPath}`);
    }
    throw error;
  }
}

/** Persist provider config atomically; best-effort mode 0600 on POSIX. */
export async function saveProviderConfig(
  config: ProviderConfig,
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  const parsed = ProviderConfigSchema.parse(config);
  // Drop default pointer if the profile no longer exists.
  if (
    parsed.defaultModelProfileId &&
    !parsed.models.some((m) => m.id === parsed.defaultModelProfileId)
  ) {
    delete parsed.defaultModelProfileId;
  }
  const dir = path.dirname(providerPath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${providerPath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(parsed, null, 2)}\n`;
  await writeFile(tempPath, body, "utf8");
  try {
    await chmod(tempPath, 0o600);
  } catch {
    // Windows or restricted FS — ignore.
  }
  await rename(tempPath, providerPath);
  try {
    await chmod(providerPath, 0o600);
  } catch {
    // ignore
  }
  return parsed;
}

/** Mask a secret for UI display (never full value). */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return "••••••••";
  }
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}…${tail}`;
}

export function toModelProfilePublic(profile: ModelProfile): ModelProfilePublic {
  const apiKey = profile.apiKey?.trim() ?? "";
  return {
    id: profile.id,
    name: profile.name,
    providerKind: profile.providerKind ?? "openai-compatible",
    modelId: profile.modelId,
    baseUrl: profile.baseUrl?.trim() ?? "",
    apiKeySet: apiKey.length > 0,
    apiKeyMasked: maskSecret(apiKey),
    apiShape: profile.apiShape ?? "completions",
    ...(profile.maxContextTokens !== undefined
      ? { maxContextTokens: profile.maxContextTokens }
      : {}),
  };
}

/** Public, non-secret catalog for GET /api/provider. */
export function toProviderPublic(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProviderPublic {
  return {
    version: 2,
    models: config.models.map(toModelProfilePublic),
    ...(config.defaultModelProfileId
      ? { defaultModelProfileId: config.defaultModelProfileId }
      : {}),
    envFallback: {
      openaiBaseUrlSet: Boolean(env.OPENAI_BASE_URL?.trim()),
      openaiApiKeySet: Boolean(env.OPENAI_API_KEY?.trim()),
    },
  };
}

function slugifyModelId(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "model";
}

function uniqueProfileId(desired: string, existing: readonly ModelProfile[]): string {
  const taken = new Set(existing.map((m) => m.id));
  if (!taken.has(desired)) {
    return desired;
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desired.slice(0, 56)}-${i}`.slice(0, 64);
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return randomUUID();
}

/** Create a model profile in the catalog. */
export async function createModelProfile(
  input: ModelProfileWrite,
  providerPath: string = defaultProviderPath(),
): Promise<{ config: ProviderConfig; profile: ModelProfile }> {
  const write = {
    name: input.name.trim(),
    modelId: input.modelId.trim(),
    baseUrl: (input.baseUrl ?? "").trim(),
    apiShape: input.apiShape ?? "completions",
    providerKind: input.providerKind ?? "openai-compatible",
    apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
  };
  if (!write.name || !write.modelId) {
    throw new Error("name and modelId are required");
  }
  if (write.providerKind !== "openai-compatible") {
    throw new Error(
      `Unsupported provider kind "${write.providerKind}". Currently only openai-compatible is supported.`,
    );
  }

  const current = await loadProviderConfig(providerPath);
  const preferred =
    input.id?.trim() ||
    slugifyModelId(write.name) ||
    slugifyModelId(write.modelId);
  const id = uniqueProfileId(preferred, current.models);

  const profile = ModelProfileSchema.parse({
    id,
    name: write.name,
    providerKind: write.providerKind,
    modelId: write.modelId,
    baseUrl: write.baseUrl,
    apiKey: write.apiKey,
    apiShape: write.apiShape,
    ...(typeof input.maxContextTokens === "number"
      ? { maxContextTokens: input.maxContextTokens }
      : {}),
  });

  const models = [...current.models, profile];
  const config = await saveProviderConfig(
    {
      version: 2,
      models,
      defaultModelProfileId:
        current.defaultModelProfileId ?? (models.length === 1 ? id : undefined),
    },
    providerPath,
  );
  return { config, profile };
}

/** Update an existing model profile; omit apiKey to keep the secret. */
export async function updateModelProfile(
  profileId: string,
  input: ModelProfileWrite,
  providerPath: string = defaultProviderPath(),
): Promise<{ config: ProviderConfig; profile: ModelProfile }> {
  const current = await loadProviderConfig(providerPath);
  const index = current.models.findIndex((m) => m.id === profileId);
  if (index < 0) {
    throw new Error(`model profile not found: ${profileId}`);
  }
  const existing = current.models[index]!;

  let apiKey = existing.apiKey;
  if (input.apiKey !== undefined) {
    if (input.apiKey === null || input.apiKey === "") {
      apiKey = "";
    } else {
      apiKey = input.apiKey;
    }
  }

  let maxContextTokens = existing.maxContextTokens;
  if (input.maxContextTokens !== undefined) {
    maxContextTokens =
      input.maxContextTokens === null ? undefined : input.maxContextTokens;
  }

  const providerKind = input.providerKind ?? existing.providerKind ?? "openai-compatible";
  if (providerKind !== "openai-compatible") {
    throw new Error(
      `Unsupported provider kind "${providerKind}". Currently only openai-compatible is supported.`,
    );
  }

  const profile = ModelProfileSchema.parse({
    id: existing.id,
    name: input.name.trim(),
    providerKind,
    modelId: input.modelId.trim(),
    baseUrl: (input.baseUrl ?? "").trim(),
    apiKey,
    apiShape: input.apiShape ?? existing.apiShape,
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
  });

  const models = [...current.models];
  models[index] = profile;
  const config = await saveProviderConfig(
    {
      version: 2,
      models,
      defaultModelProfileId: current.defaultModelProfileId,
    },
    providerPath,
  );
  return { config, profile };
}

/** Remove a model profile from the catalog. */
export async function deleteModelProfile(
  profileId: string,
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  const current = await loadProviderConfig(providerPath);
  const models = current.models.filter((m) => m.id !== profileId);
  if (models.length === current.models.length) {
    throw new Error(`model profile not found: ${profileId}`);
  }
  let defaultModelProfileId = current.defaultModelProfileId;
  if (defaultModelProfileId === profileId) {
    defaultModelProfileId = models[0]?.id;
  }
  return saveProviderConfig(
    {
      version: 2,
      models,
      ...(defaultModelProfileId ? { defaultModelProfileId } : {}),
    },
    providerPath,
  );
}

/** Set which profile is the default for new workspaces. */
export async function setDefaultModelProfile(
  profileId: string | null,
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  const current = await loadProviderConfig(providerPath);
  if (profileId) {
    if (!current.models.some((m) => m.id === profileId)) {
      throw new Error(`model profile not found: ${profileId}`);
    }
    return saveProviderConfig(
      {
        version: 2,
        models: current.models,
        defaultModelProfileId: profileId,
      },
      providerPath,
    );
  }
  return saveProviderConfig(
    {
      version: 2,
      models: current.models,
    },
    providerPath,
  );
}

export type ResolvedProviderRuntime = {
  baseUrl: string | undefined;
  apiKey: string;
  apiShape: ProviderApiShape;
  /**
   * Product provider kind (wire family).
   * Currently always openai-compatible when a profile is selected.
   */
  providerKind: "openai-compatible";
  /** Served model id (may still include provider/ prefix). */
  modelId: string | undefined;
  profileId: string | undefined;
  profileName: string | undefined;
  /** Provider hard context window from the selected model profile, when set. */
  maxContextTokens: number | undefined;
  source: {
    baseUrl: "stored" | "env" | "none";
    apiKey: "stored" | "env" | "none";
  };
};

/**
 * Resolve credentials for a workspace model selection.
 * Prefers profileId, then matching modelId, then default profile, then env-only.
 */
export function resolveProviderRuntime(
  config: ProviderConfig,
  options: {
    profileId?: string;
    modelId?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): ResolvedProviderRuntime {
  const env = options.env ?? process.env;
  const envUrl = env.OPENAI_BASE_URL?.trim() ?? "";
  const envKey = env.OPENAI_API_KEY?.trim() ?? "";

  let profile: ModelProfile | undefined;
  if (options.profileId) {
    profile = config.models.find((m) => m.id === options.profileId);
  }
  if (!profile && options.modelId) {
    profile = config.models.find((m) => m.modelId === options.modelId);
  }
  if (!profile && config.defaultModelProfileId) {
    profile = config.models.find((m) => m.id === config.defaultModelProfileId);
  }
  if (!profile && config.models.length === 1) {
    profile = config.models[0];
  }

  const storedUrl = profile?.baseUrl?.trim() ?? "";
  const storedKey = profile?.apiKey?.trim() ?? "";

  let baseUrl: string | undefined;
  let baseUrlSource: ResolvedProviderRuntime["source"]["baseUrl"] = "none";
  if (storedUrl) {
    baseUrl = storedUrl.replace(/\/$/, "");
    baseUrlSource = "stored";
  } else if (envUrl) {
    baseUrl = envUrl.replace(/\/$/, "");
    baseUrlSource = "env";
  }

  let apiKey = "";
  let apiKeySource: ResolvedProviderRuntime["source"]["apiKey"] = "none";
  if (storedKey) {
    apiKey = storedKey;
    apiKeySource = "stored";
  } else if (envKey) {
    apiKey = envKey;
    apiKeySource = "env";
  }

  return {
    baseUrl,
    apiKey: apiKey || "local",
    apiShape: profile?.apiShape ?? "completions",
    providerKind: profile?.providerKind ?? "openai-compatible",
    modelId: profile?.modelId ?? options.modelId,
    profileId: profile?.id,
    profileName: profile?.name,
    maxContextTokens: profile?.maxContextTokens,
    source: { baseUrl: baseUrlSource, apiKey: apiKeySource },
  };
}

/** Look up a profile by id (throws if missing). */
export function getModelProfile(
  config: ProviderConfig,
  profileId: string,
): ModelProfile {
  const profile = config.models.find((m) => m.id === profileId);
  if (!profile) {
    throw new Error(`model profile not found: ${profileId}`);
  }
  return profile;
}

/** True when any model or env can drive a live call. */
export function hasProviderCredentials(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENAI_BASE_URL?.trim() || env.OPENAI_API_KEY?.trim()) {
    return true;
  }
  return config.models.some(
    (m) => Boolean(m.baseUrl?.trim()) || Boolean(m.apiKey?.trim()),
  );
}

function redactProbeText(text: string): string {
  return text
    .replace(/\bsk-[a-zA-Z0-9-]{10,}\b/g, "[redacted-key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "api_key=[redacted]")
    .slice(0, 240);
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/$/, "");
}

/**
 * Probe an OpenAI-compatible endpoint with a minimal request.
 * Never echoes credentials or large provider bodies.
 */
export async function testProviderConnection(input: {
  baseUrl: string;
  apiKey: string;
  apiShape: ProviderApiShape;
  modelId?: string;
  signal?: AbortSignal;
}): Promise<ProviderTestResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) {
    return {
      ok: false,
      apiShape: input.apiShape,
      message: "base URL is required",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return {
      ok: false,
      apiShape: input.apiShape,
      message: "base URL is not a valid absolute URL",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      apiShape: input.apiShape,
      message: "base URL must use http or https",
    };
  }

  const model =
    input.modelId?.includes("/")
      ? input.modelId.split("/").slice(1).join("/") || "default"
      : input.modelId?.trim() || "default";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (input.apiKey.trim()) {
    headers.Authorization = `Bearer ${input.apiKey.trim()}`;
  }

  const started = Date.now();
  let url: string;
  let body: string;

  if (input.apiShape === "responses") {
    url = `${baseUrl}/responses`;
    body = JSON.stringify({
      model,
      input: "ping",
      max_output_tokens: 1,
    });
  } else {
    url = `${baseUrl}/chat/completions`;
    body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: input.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await response.text().catch(() => "");
    const snippet = redactProbeText(text);

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        apiShape: input.apiShape,
        status: response.status,
        message: `authentication failed (HTTP ${response.status})`,
        latencyMs,
      };
    }

    if (response.status === 404) {
      return {
        ok: false,
        apiShape: input.apiShape,
        status: 404,
        message: `endpoint not found — check base URL and API shape (${input.apiShape})`,
        latencyMs,
      };
    }

    if (response.status === 400 || response.status === 422) {
      const modelMissing = /model|not found|does not exist|unknown/i.test(snippet);
      return {
        ok: true,
        apiShape: input.apiShape,
        status: response.status,
        message: modelMissing
          ? `reachable (HTTP ${response.status}) — model may be invalid: ${model}`
          : `reachable (HTTP ${response.status})`,
        latencyMs,
      };
    }

    if (response.ok) {
      return {
        ok: true,
        apiShape: input.apiShape,
        status: response.status,
        // Reachability only — full agent turns (tools + system) may still fail.
        message: `reachable (HTTP ${response.status}) — probe is not a full agent turn`,
        latencyMs,
      };
    }

    if (response.status === 429 || response.status >= 500) {
      return {
        ok: true,
        apiShape: input.apiShape,
        status: response.status,
        message: `reachable but provider returned HTTP ${response.status}`,
        latencyMs,
      };
    }

    return {
      ok: false,
      apiShape: input.apiShape,
      status: response.status,
      message: `provider returned HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError") {
      return {
        ok: false,
        apiShape: input.apiShape,
        message: "request timed out",
        latencyMs,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      apiShape: input.apiShape,
      message: redactProbeText(message) || "network error",
      latencyMs,
    };
  }
}
