import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  CatalogModelSchema,
  ModelProfileSchema,
  ProviderConfigSchema,
  ProviderConfigV1Schema,
  ProviderConfigV2Schema,
  ProviderEntrySchema,
  type CatalogModel,
  type ModelProfile,
  type ModelProfilePublic,
  type ModelProfileWrite,
  type ProviderApiShape,
  type ProviderConfig,
  type ProviderEntry,
  type ProviderEntryPublic,
  type ProviderEntryWrite,
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
    version: 3,
    providers: [],
  });

function slugifyId(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "item";
}

function uniqueId(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desired.slice(0, 56)}-${i}`.slice(0, 64);
    if (!taken.has(candidate)) return candidate;
  }
  return randomUUID();
}

function normalizeHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  if (headers === null) return undefined;
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.trim();
    if (!key || typeof v !== "string") continue;
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Merge provider + model headers (model wins on key conflict, case-sensitive). */
export function mergeHeaders(
  provider?: Record<string, string>,
  model?: Record<string, string>,
): Record<string, string> | undefined {
  const merged = { ...(provider ?? {}), ...(model ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Flatten provider tree → selectable model profiles (runtime view). */
export function flattenModels(config: ProviderConfig): ModelProfile[] {
  const out: ModelProfile[] = [];
  for (const p of config.providers ?? []) {
    for (const m of p.models ?? []) {
      out.push(
        ModelProfileSchema.parse({
          id: m.id,
          name: m.name,
          providerKind: p.kind ?? "openai-compatible",
          providerId: p.id,
          modelId: m.modelId,
          baseUrl: p.baseUrl ?? "",
          apiKey: p.apiKey ?? "",
          apiShape: p.apiShape ?? "completions",
          ...(m.maxContextTokens !== undefined
            ? { maxContextTokens: m.maxContextTokens }
            : {}),
          headers: mergeHeaders(p.headers, m.headers),
        }),
      );
    }
  }
  return out;
}

/** All model selection ids across providers. */
function allModelIds(config: ProviderConfig): Set<string> {
  return new Set(flattenModels(config).map((m) => m.id));
}

function allProviderIds(config: ProviderConfig): Set<string> {
  return new Set((config.providers ?? []).map((p) => p.id));
}

/** Migrate legacy v1 single-endpoint file into a provider with one model. */
export function migrateProviderConfigV1(raw: unknown): ProviderConfig | null {
  const parsed = ProviderConfigV1Schema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const asRecord =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (asRecord.version === 2 || asRecord.version === 3) {
    return null;
  }
  if (Array.isArray(asRecord.models) || Array.isArray(asRecord.providers)) {
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
  const headers = normalizeHeaders(v1.headers);
  const provider = ProviderEntrySchema.parse({
    id: "default",
    name: "Default",
    kind: "openai-compatible",
    baseUrl: v1.baseUrl?.trim() ?? "",
    apiKey: v1.apiKey ?? "",
    apiShape: v1.apiShape ?? "completions",
    ...(headers ? { headers } : {}),
    models: [
      {
        id: "default",
        name: "Default",
        modelId,
      },
    ],
  });
  return ProviderConfigSchema.parse({
    version: 3,
    defaultModelProfileId: "default",
    providers: [provider],
  });
}

/** Migrate v2 flat models[] into provider tree (group by endpoint). */
export function migrateProviderConfigV2(raw: unknown): ProviderConfig | null {
  const parsed = ProviderConfigV2Schema.safeParse(raw);
  if (!parsed.success) return null;

  const v2 = parsed.data;
  const groups = new Map<
    string,
    {
      baseUrl: string;
      apiKey: string;
      apiShape: ProviderApiShape;
      headers?: Record<string, string>;
      models: CatalogModel[];
      nameHint: string;
    }
  >();

  for (const m of v2.models) {
    const baseUrl = (m.baseUrl ?? "").trim();
    const apiKey = m.apiKey ?? "";
    const apiShape = m.apiShape ?? "completions";
    const headers = normalizeHeaders(m.headers);
    const key = `${baseUrl}\0${apiShape}\0${apiKey}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        baseUrl,
        apiKey,
        apiShape,
        headers,
        models: [],
        nameHint: m.name || baseUrl || "Provider",
      };
      groups.set(key, g);
    }
    g.models.push(
      CatalogModelSchema.parse({
        id: m.id,
        name: m.name,
        modelId: m.modelId,
        ...(m.maxContextTokens !== undefined
          ? { maxContextTokens: m.maxContextTokens }
          : {}),
      }),
    );
  }

  const usedProviderIds = new Set<string>();
  const providers: ProviderEntry[] = [];
  let i = 0;
  for (const g of groups.values()) {
    i += 1;
    const preferred =
      groups.size === 1
        ? "default"
        : slugifyId(g.nameHint) || `provider-${i}`;
    const id = uniqueId(preferred, usedProviderIds);
    usedProviderIds.add(id);
    providers.push(
      ProviderEntrySchema.parse({
        id,
        name: groups.size === 1 ? "Default" : g.nameHint.slice(0, 120),
        kind: "openai-compatible",
        baseUrl: g.baseUrl,
        apiKey: g.apiKey,
        apiShape: g.apiShape,
        ...(g.headers ? { headers: g.headers } : {}),
        models: g.models,
      }),
    );
  }

  return ProviderConfigSchema.parse({
    version: 3,
    ...(v2.defaultModelProfileId
      ? { defaultModelProfileId: v2.defaultModelProfileId }
      : {}),
    providers,
  });
}

function normalizeLoaded(data: unknown): ProviderConfig {
  const v1 = migrateProviderConfigV1(data);
  if (v1) return v1;

  const asRecord =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};

  // Explicit v2 or models without providers.
  if (
    asRecord.version === 2 ||
    (Array.isArray(asRecord.models) && !Array.isArray(asRecord.providers))
  ) {
    const v2 = migrateProviderConfigV2(data);
    if (v2) return v2;
  }

  // v3 (or already providers[])
  if (Array.isArray(asRecord.providers) || asRecord.version === 3) {
    const parsed = ProviderConfigSchema.parse({
      ...asRecord,
      version: 3,
    });
    // Drop default if dangling.
    if (
      parsed.defaultModelProfileId &&
      !flattenModels(parsed).some((m) => m.id === parsed.defaultModelProfileId)
    ) {
      delete parsed.defaultModelProfileId;
    }
    return parsed;
  }

  // Empty / unknown → empty catalog.
  if (!asRecord || Object.keys(asRecord).length === 0) {
    return emptyProvider();
  }

  // Last resort: try v2 migrate on anything with models
  const v2 = migrateProviderConfigV2({ version: 2, ...asRecord });
  if (v2) return v2;

  return emptyProvider();
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

/** Persist provider config atomically (v3 tree only). */
export async function saveProviderConfig(
  config: ProviderConfig,
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  const parsed = ProviderConfigSchema.parse({
    version: 3,
    providers: config.providers ?? [],
    ...(config.defaultModelProfileId
      ? { defaultModelProfileId: config.defaultModelProfileId }
      : {}),
  });
  if (
    parsed.defaultModelProfileId &&
    !flattenModels(parsed).some((m) => m.id === parsed.defaultModelProfileId)
  ) {
    delete parsed.defaultModelProfileId;
  }
  // Never persist deprecated flat models[]
  const toWrite = {
    version: 3 as const,
    ...(parsed.defaultModelProfileId
      ? { defaultModelProfileId: parsed.defaultModelProfileId }
      : {}),
    providers: parsed.providers,
  };
  const dir = path.dirname(providerPath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${providerPath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(toWrite, null, 2)}\n`;
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
  return ProviderConfigSchema.parse(toWrite);
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

export function toModelProfilePublic(
  profile: ModelProfile,
  providerName?: string,
): ModelProfilePublic {
  const apiKey = profile.apiKey?.trim() ?? "";
  return {
    id: profile.id,
    name: profile.name,
    providerKind: profile.providerKind ?? "openai-compatible",
    ...(profile.providerId ? { providerId: profile.providerId } : {}),
    ...(providerName ? { providerName } : {}),
    modelId: profile.modelId,
    baseUrl: profile.baseUrl?.trim() ?? "",
    apiKeySet: apiKey.length > 0,
    apiKeyMasked: maskSecret(apiKey),
    apiShape: profile.apiShape ?? "completions",
    ...(profile.maxContextTokens !== undefined
      ? { maxContextTokens: profile.maxContextTokens }
      : {}),
    ...(profile.headers ? { headers: profile.headers } : {}),
  };
}

export function toProviderEntryPublic(p: ProviderEntry): ProviderEntryPublic {
  const apiKey = p.apiKey?.trim() ?? "";
  return {
    id: p.id,
    name: p.name,
    kind: p.kind ?? "openai-compatible",
    baseUrl: p.baseUrl?.trim() ?? "",
    apiKeySet: apiKey.length > 0,
    apiKeyMasked: maskSecret(apiKey),
    apiShape: p.apiShape ?? "completions",
    ...(p.headers ? { headers: p.headers } : {}),
    models: (p.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      modelId: m.modelId,
      ...(m.maxContextTokens !== undefined
        ? { maxContextTokens: m.maxContextTokens }
        : {}),
      ...(m.headers ? { headers: m.headers } : {}),
    })),
  };
}

/** Public, non-secret catalog for GET /api/provider. */
export function toProviderPublic(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProviderPublic {
  const flat = flattenModels(config);
  const nameByProvider = new Map(
    (config.providers ?? []).map((p) => [p.id, p.name]),
  );
  return {
    version: 3,
    models: flat.map((m) =>
      toModelProfilePublic(
        m,
        m.providerId ? nameByProvider.get(m.providerId) : undefined,
      ),
    ),
    providers: (config.providers ?? []).map(toProviderEntryPublic),
    ...(config.defaultModelProfileId
      ? { defaultModelProfileId: config.defaultModelProfileId }
      : {}),
    envFallback: {
      openaiBaseUrlSet: Boolean(env.OPENAI_BASE_URL?.trim()),
      openaiApiKeySet: Boolean(env.OPENAI_API_KEY?.trim()),
    },
  };
}

function findProviderIndex(
  config: ProviderConfig,
  providerId: string,
): number {
  return (config.providers ?? []).findIndex((p) => p.id === providerId);
}

function findModelLocation(
  config: ProviderConfig,
  profileId: string,
): { providerIndex: number; modelIndex: number } | null {
  for (let pi = 0; pi < (config.providers ?? []).length; pi++) {
    const p = config.providers![pi]!;
    const mi = p.models.findIndex((m) => m.id === profileId);
    if (mi >= 0) return { providerIndex: pi, modelIndex: mi };
  }
  return null;
}

/** Create a provider endpoint (optionally with zero models). */
export async function createProviderEntry(
  input: ProviderEntryWrite,
  providerPath: string = defaultProviderPath(),
): Promise<{ config: ProviderConfig; provider: ProviderEntry }> {
  const current = await loadProviderConfig(providerPath);
  const preferred = input.id?.trim() || slugifyId(input.name);
  const id = uniqueId(preferred, allProviderIds(current));
  const headers = normalizeHeaders(
    input.headers === null ? null : input.headers,
  );
  const provider = ProviderEntrySchema.parse({
    id,
    name: input.name.trim(),
    kind: input.kind ?? "openai-compatible",
    baseUrl: (input.baseUrl ?? "").trim(),
    apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
    apiShape: input.apiShape ?? "completions",
    ...(headers ? { headers } : {}),
    models: [],
  });
  const config = await saveProviderConfig(
    {
      version: 3,
      providers: [...(current.providers ?? []), provider],
      ...(current.defaultModelProfileId
        ? { defaultModelProfileId: current.defaultModelProfileId }
        : {}),
    },
    providerPath,
  );
  return {
    config,
    provider: config.providers.find((p) => p.id === id)!,
  };
}

/** Update provider connection fields (not models list). */
export async function updateProviderEntry(
  providerId: string,
  input: ProviderEntryWrite,
  providerPath: string = defaultProviderPath(),
): Promise<{ config: ProviderConfig; provider: ProviderEntry }> {
  const current = await loadProviderConfig(providerPath);
  const index = findProviderIndex(current, providerId);
  if (index < 0) {
    throw new Error(`provider not found: ${providerId}`);
  }
  const existing = current.providers[index]!;
  let apiKey = existing.apiKey;
  if (input.apiKey !== undefined) {
    if (input.apiKey === null || input.apiKey === "") {
      apiKey = "";
    } else {
      apiKey = input.apiKey;
    }
  }
  let headers = existing.headers;
  if (input.headers !== undefined) {
    headers = normalizeHeaders(input.headers === null ? null : input.headers);
  }
  const provider = ProviderEntrySchema.parse({
    id: existing.id,
    name: input.name.trim(),
    kind: input.kind ?? existing.kind ?? "openai-compatible",
    baseUrl: (input.baseUrl ?? "").trim(),
    apiKey,
    apiShape: input.apiShape ?? existing.apiShape,
    ...(headers ? { headers } : {}),
    models: existing.models,
  });
  const providers = [...current.providers];
  providers[index] = provider;
  const config = await saveProviderConfig(
    {
      version: 3,
      providers,
      ...(current.defaultModelProfileId
        ? { defaultModelProfileId: current.defaultModelProfileId }
        : {}),
    },
    providerPath,
  );
  return { config, provider };
}

/** Delete a provider and all of its models. */
export async function deleteProviderEntry(
  providerId: string,
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  const current = await loadProviderConfig(providerPath);
  const providers = (current.providers ?? []).filter((p) => p.id !== providerId);
  if (providers.length === current.providers.length) {
    throw new Error(`provider not found: ${providerId}`);
  }
  const remainingIds = new Set(
    providers.flatMap((p) => p.models.map((m) => m.id)),
  );
  let defaultModelProfileId = current.defaultModelProfileId;
  if (defaultModelProfileId && !remainingIds.has(defaultModelProfileId)) {
    defaultModelProfileId = [...remainingIds][0];
  }
  return saveProviderConfig(
    {
      version: 3,
      providers,
      ...(defaultModelProfileId ? { defaultModelProfileId } : {}),
    },
    providerPath,
  );
}

/**
 * Create a model profile in the catalog.
 * - With providerId: add under that provider (connection fields ignored unless provider empty).
 * - Without: create a new provider (or merge into same baseUrl+key+shape).
 */
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
    providerId: input.providerId?.trim(),
    providerName: input.providerName?.trim(),
    headers: normalizeHeaders(
      input.headers === null ? null : input.headers ?? undefined,
    ),
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
  const profileId = uniqueId(
    input.id?.trim() || slugifyId(write.name) || slugifyId(write.modelId),
    allModelIds(current),
  );

  const catalogModel = CatalogModelSchema.parse({
    id: profileId,
    name: write.name,
    modelId: write.modelId,
    ...(typeof input.maxContextTokens === "number"
      ? { maxContextTokens: input.maxContextTokens }
      : {}),
  });

  let providers = [...(current.providers ?? [])];
  let targetIndex = -1;

  if (write.providerId) {
    targetIndex = findProviderIndex(current, write.providerId);
    if (targetIndex < 0) {
      throw new Error(`provider not found: ${write.providerId}`);
    }
  } else {
    // Merge into existing endpoint if baseUrl+shape+key match.
    targetIndex = providers.findIndex(
      (p) =>
        (p.baseUrl ?? "").trim() === write.baseUrl &&
        (p.apiShape ?? "completions") === write.apiShape &&
        (p.apiKey ?? "") === write.apiKey,
    );
  }

  if (targetIndex >= 0) {
    const p = providers[targetIndex]!;
    const nextHeaders =
      write.headers !== undefined
        ? write.headers
        : p.headers;
    providers[targetIndex] = ProviderEntrySchema.parse({
      ...p,
      // Allow first create under empty provider to set connection from form.
      baseUrl: p.baseUrl?.trim() || write.baseUrl,
      apiKey: p.apiKey || write.apiKey,
      apiShape: p.apiShape ?? write.apiShape,
      ...(nextHeaders ? { headers: nextHeaders } : { headers: undefined }),
      models: [...p.models, catalogModel],
    });
  } else {
    const providerId = uniqueId(
      slugifyId(write.providerName || write.name || write.baseUrl || "provider"),
      allProviderIds(current),
    );
    providers.push(
      ProviderEntrySchema.parse({
        id: providerId,
        name: (write.providerName || write.name || "Provider").slice(0, 120),
        kind: "openai-compatible",
        baseUrl: write.baseUrl,
        apiKey: write.apiKey,
        apiShape: write.apiShape,
        ...(write.headers ? { headers: write.headers } : {}),
        models: [catalogModel],
      }),
    );
  }

  const config = await saveProviderConfig(
    {
      version: 3,
      providers,
      defaultModelProfileId:
        current.defaultModelProfileId ??
        (flattenModels({ version: 3, providers }).length === 1
          ? profileId
          : undefined),
    },
    providerPath,
  );
  const profile = flattenModels(config).find((m) => m.id === profileId)!;
  return { config, profile };
}

/** Update an existing model profile; connection edits update the parent provider. */
export async function updateModelProfile(
  profileId: string,
  input: ModelProfileWrite,
  providerPath: string = defaultProviderPath(),
): Promise<{ config: ProviderConfig; profile: ModelProfile }> {
  const current = await loadProviderConfig(providerPath);
  const loc = findModelLocation(current, profileId);
  if (!loc) {
    throw new Error(`model profile not found: ${profileId}`);
  }
  const provider = current.providers[loc.providerIndex]!;
  const existingModel = provider.models[loc.modelIndex]!;

  let maxContextTokens = existingModel.maxContextTokens;
  if (input.maxContextTokens !== undefined) {
    maxContextTokens =
      input.maxContextTokens === null ? undefined : input.maxContextTokens;
  }

  const catalogModel = CatalogModelSchema.parse({
    id: existingModel.id,
    name: input.name.trim(),
    modelId: input.modelId.trim(),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(existingModel.headers ? { headers: existingModel.headers } : {}),
  });

  let apiKey = provider.apiKey;
  if (input.apiKey !== undefined) {
    if (input.apiKey === null || input.apiKey === "") {
      apiKey = "";
    } else {
      apiKey = input.apiKey;
    }
  }

  let headers = provider.headers;
  if (input.headers !== undefined) {
    headers = normalizeHeaders(input.headers === null ? null : input.headers);
  }

  const models = [...provider.models];
  models[loc.modelIndex] = catalogModel;

  const nextProvider = ProviderEntrySchema.parse({
    id: provider.id,
    name: input.providerName?.trim() || provider.name,
    kind: input.providerKind ?? provider.kind ?? "openai-compatible",
    baseUrl: (input.baseUrl ?? provider.baseUrl ?? "").trim(),
    apiKey,
    apiShape: input.apiShape ?? provider.apiShape,
    ...(headers ? { headers } : {}),
    models,
  });

  const providers = [...current.providers];
  providers[loc.providerIndex] = nextProvider;

  const config = await saveProviderConfig(
    {
      version: 3,
      providers,
      ...(current.defaultModelProfileId
        ? { defaultModelProfileId: current.defaultModelProfileId }
        : {}),
    },
    providerPath,
  );
  const profile = flattenModels(config).find((m) => m.id === profileId)!;
  return { config, profile };
}

/** Remove a model profile; drops empty parent provider. */
export async function deleteModelProfile(
  profileId: string,
  providerPath: string = defaultProviderPath(),
): Promise<ProviderConfig> {
  const current = await loadProviderConfig(providerPath);
  const loc = findModelLocation(current, profileId);
  if (!loc) {
    throw new Error(`model profile not found: ${profileId}`);
  }
  const provider = current.providers[loc.providerIndex]!;
  const models = provider.models.filter((m) => m.id !== profileId);
  let providers = [...current.providers];
  if (models.length === 0) {
    providers = providers.filter((_, i) => i !== loc.providerIndex);
  } else {
    providers[loc.providerIndex] = ProviderEntrySchema.parse({
      ...provider,
      models,
    });
  }
  const remaining = flattenModels({ version: 3, providers });
  let defaultModelProfileId = current.defaultModelProfileId;
  if (defaultModelProfileId === profileId) {
    defaultModelProfileId = remaining[0]?.id;
  }
  return saveProviderConfig(
    {
      version: 3,
      providers,
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
    if (!flattenModels(current).some((m) => m.id === profileId)) {
      throw new Error(`model profile not found: ${profileId}`);
    }
    return saveProviderConfig(
      {
        version: 3,
        providers: current.providers,
        defaultModelProfileId: profileId,
      },
      providerPath,
    );
  }
  return saveProviderConfig(
    {
      version: 3,
      providers: current.providers,
    },
    providerPath,
  );
}

export type ResolvedProviderRuntime = {
  baseUrl: string | undefined;
  apiKey: string;
  apiShape: ProviderApiShape;
  providerKind: "openai-compatible";
  modelId: string | undefined;
  profileId: string | undefined;
  profileName: string | undefined;
  maxContextTokens: number | undefined;
  /** Effective HTTP headers for Pi / probe. */
  headers: Record<string, string> | undefined;
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
  const flat = flattenModels(config);

  let profile: ModelProfile | undefined;
  if (options.profileId) {
    profile = flat.find((m) => m.id === options.profileId);
  }
  if (!profile && options.modelId) {
    profile = flat.find((m) => m.modelId === options.modelId);
  }
  if (!profile && config.defaultModelProfileId) {
    profile = flat.find((m) => m.id === config.defaultModelProfileId);
  }
  if (!profile && flat.length === 1) {
    profile = flat[0];
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

  // Default User-Agent for WAF-sensitive gateways when nothing configured.
  const headers =
    profile?.headers && Object.keys(profile.headers).length > 0
      ? profile.headers
      : { "User-Agent": "node" };

  return {
    baseUrl,
    apiKey: apiKey || "local",
    apiShape: profile?.apiShape ?? "completions",
    providerKind: profile?.providerKind ?? "openai-compatible",
    modelId: profile?.modelId ?? options.modelId,
    profileId: profile?.id,
    profileName: profile?.name,
    maxContextTokens: profile?.maxContextTokens,
    headers,
    source: { baseUrl: baseUrlSource, apiKey: apiKeySource },
  };
}

/** Look up a profile by id (throws if missing). */
export function getModelProfile(
  config: ProviderConfig,
  profileId: string,
): ModelProfile {
  const profile = flattenModels(config).find((m) => m.id === profileId);
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
  return flattenModels(config).some(
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
  headers?: Record<string, string>;
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
    "User-Agent": "node",
    ...(input.headers ?? {}),
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
      const modelMissing = /model|not found|does not exist|unknown/i.test(
        snippet,
      );
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
