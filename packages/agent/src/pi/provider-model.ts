/**
 * Bridge OKF provider catalog → Pi ModelRuntime + Model (ADR 0030).
 *
 * Product Settings store OpenAI-compatible gateways as model profiles
 * (baseUrl, apiKey, apiShape, modelId). Pi speaks providers; this module
 * registers one in-memory provider per selected profile and returns the
 * Model that createWikiSession / produceWithPi need.
 *
 * Currently only `openai-compatible` (completions | responses). Other
 * provider kinds are reserved for a later multi-provider catalog.
 */

import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderApiShape } from "@okf-wiki/contract";
import {
  flattenModels,
  hasProviderCredentials,
  loadProviderConfig,
  type ResolvedProviderRuntime,
  resolveProviderRuntime,
} from "@okf-wiki/core";
import { resolveContextBudget } from "./context-budget.js";

/** Supported product provider kinds. Extend when non-OpenAI APIs land. */
export type OkfProviderKind = "openai-compatible";

export const OKF_PROVIDER_KINDS = [
  "openai-compatible",
] as const satisfies readonly OkfProviderKind[];

export type ResolvePiModelInput = {
  baseUrl?: string;
  apiKey: string;
  apiShape: ProviderApiShape;
  /** Served model identity (may include `openai/` prefix). */
  modelId: string;
  profileId?: string;
  profileName?: string;
  maxContextTokens?: number;
  /**
   * Product provider kind. Only openai-compatible is implemented.
   * Defaults to openai-compatible.
   */
  providerKind?: OkfProviderKind;
  /**
   * Extra HTTP headers (User-Agent, etc.) from provider settings.
   * Merged over the product default User-Agent: node.
   */
  headers?: Record<string, string>;
  /**
   * When true, allow OpenAI `developer` role for system prompts.
   * Default false — most third-party gateways reject `developer`.
   */
  supportsDeveloperRole?: boolean;
};

export type ResolvedPiModel = {
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  /** Pi provider id registered on the runtime. */
  providerId: string;
  /** Model id sent on the wire (prefix stripped). */
  servedModelId: string;
  providerKind: OkfProviderKind;
  /** Profile / env resolution used to build this model. */
  runtime: ResolvedProviderRuntime;
};

/** Map product apiShape → pi-ai Api string. */
export function piApiFromShape(shape: ProviderApiShape): Api {
  return shape === "responses" ? "openai-responses" : "openai-completions";
}

/**
 * Served model id for the wire protocol.
 * Strips a single `provider/` prefix (e.g. `openai/gpt-4o` → `gpt-4o`)
 * so enterprise gateways receive the deployment name they expect.
 */
export function servedModelIdFromProfile(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return "default";
  if (trimmed.includes("/")) {
    const rest = trimmed.split("/").slice(1).join("/") || trimmed;
    return rest;
  }
  return trimmed;
}

/** Stable, filesystem-safe Pi provider id for a profile. */
export function okfProviderId(profileId?: string): string {
  const raw = (profileId?.trim() || "default")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `okf-${raw || "default"}`;
}

function missingCredentialsMessage(): string {
  return (
    "No provider credentials configured. Add a model profile in Settings " +
    "(base URL + API key), or set OPENAI_API_KEY and optional OPENAI_BASE_URL " +
    "in the environment. Currently only OpenAI-compatible gateways are supported."
  );
}

function missingModelMessage(): string {
  return (
    "No model selected. Pick a model profile in Workspace Settings, or set a " +
    "default model in global Settings."
  );
}

/**
 * True when live LLM work can proceed (stored profile or env fallback).
 * Prefer this over env-only checks after the provider catalog exists.
 */
export function hasLiveProviderCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  // Sync check: env alone is enough. Full catalog is async — callers that
  // already loaded config should use hasProviderCredentials(config, env).
  return Boolean(env.OPENAI_API_KEY?.trim() || env.OPENAI_BASE_URL?.trim());
}

/**
 * Build an isolated ModelRuntime + Model from a resolved provider runtime.
 * Does not read ~/.pi or product provider.json — pure from inputs.
 */
export async function resolvePiModelFromProvider(
  input: ResolvePiModelInput,
): Promise<ResolvedPiModel> {
  const providerKind = input.providerKind ?? "openai-compatible";
  if (providerKind !== "openai-compatible") {
    throw new Error(
      `Unsupported provider kind "${providerKind}". ` +
        `Currently only openai-compatible (chat completions / responses) is supported.`,
    );
  }

  const modelId = input.modelId?.trim();
  if (!modelId) {
    throw new Error(missingModelMessage());
  }

  const baseUrl = input.baseUrl?.trim().replace(/\/$/, "") || undefined;
  const apiKeyRaw = input.apiKey?.trim() ?? "";
  // resolveProviderRuntime uses "local" when no key — treat as empty for checks.
  const apiKey = apiKeyRaw && apiKeyRaw !== "local" ? apiKeyRaw : "";

  if (!baseUrl && !apiKey) {
    throw new Error(missingCredentialsMessage());
  }

  const servedModelId = servedModelIdFromProfile(modelId);
  const providerId = okfProviderId(input.profileId);
  const api = piApiFromShape(input.apiShape);
  const budget = resolveContextBudget({
    maxContextTokens: input.maxContextTokens,
  });
  const contextWindow = budget.contextWindow;
  const maxTokens = Math.min(32_000, Math.max(1024, Math.floor(contextWindow / 4)));

  // Isolated runtime: no disk auth.json / models.json from the host pi install.
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });

  const displayName = input.profileName?.trim() || servedModelId;

  // Default UA for WAF-sensitive OpenAI-compatible gateways; settings headers win.
  const headers: Record<string, string> = {
    "User-Agent": "node",
    ...(input.headers ?? {}),
  };

  // Pi maps systemPrompt → role "developer" when reasoning=true and
  // compat.supportsDeveloperRole !== false. Official OpenAI accepts it;
  // most third-party gateways return 400 "invalid role developer".
  // Provider setting controls this; product default is false.
  const compat = {
    supportsDeveloperRole: input.supportsDeveloperRole === true,
  };

  modelRuntime.registerProvider(providerId, {
    name: displayName,
    ...(baseUrl ? { baseUrl } : {}),
    api,
    // Literal key in register config; also set runtime override for clarity.
    ...(apiKey ? { apiKey } : {}),
    models: [
      {
        id: servedModelId,
        name: displayName,
        api,
        ...(baseUrl ? { baseUrl } : {}),
        // Allow thinking/reasoning streams when the gateway/model supports them
        // (Pi emits thinking_delta; operator UI projects them). Non-thinking
        // models simply ignore the flag.
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
        headers,
        compat,
      },
    ],
  });

  if (apiKey) {
    await modelRuntime.setRuntimeApiKey(providerId, apiKey);
  }

  const model = modelRuntime.getModel(providerId, servedModelId);
  if (!model) {
    throw new Error(
      `Failed to register Pi model ${providerId}/${servedModelId} from provider profile`,
    );
  }

  // Ensure headers stick even if registerProvider drops unknown fields.
  const existingHeaders = model.headers && typeof model.headers === "object" ? model.headers : {};
  (model as { headers: Record<string, string> }).headers = {
    ...existingHeaders,
    ...headers,
  };

  // Synthetic runtime snapshot for callers that log source (not from store).
  const runtime: ResolvedProviderRuntime = {
    baseUrl,
    apiKey: apiKey || "local",
    apiShape: input.apiShape,
    providerKind,
    modelId,
    profileId: input.profileId,
    profileName: input.profileName,
    maxContextTokens: input.maxContextTokens,
    headers,
    supportsDeveloperRole: input.supportsDeveloperRole === true,
    source: {
      baseUrl: baseUrl ? "stored" : "none",
      apiKey: apiKey ? "stored" : "none",
    },
  };

  return {
    model,
    modelRuntime,
    providerId,
    servedModelId,
    providerKind,
    runtime,
  };
}

/**
 * Resolve workspace model selection against the machine-local provider catalog,
 * then build a Pi Model + ModelRuntime.
 */
export async function resolveWorkspacePiModel(input: {
  profileId?: string;
  modelId?: string;
  env?: NodeJS.ProcessEnv;
  providerPath?: string;
}): Promise<ResolvedPiModel> {
  const config = await loadProviderConfig(input.providerPath);
  const env = input.env ?? process.env;

  const flat = flattenModels(config);
  if (!hasProviderCredentials(config, env) && !flat.some((m) => Boolean(m.modelId?.trim()))) {
    throw new Error(missingCredentialsMessage());
  }

  const runtime = resolveProviderRuntime(config, {
    profileId: input.profileId,
    modelId: input.modelId,
    env,
  });

  if (!runtime.modelId?.trim()) {
    throw new Error(missingModelMessage());
  }

  // Env-only path: no baseUrl in profile but OPENAI_* set — still ok for
  // default OpenAI endpoint when only API key is present.
  if (
    !runtime.baseUrl &&
    runtime.source.apiKey === "none" &&
    !hasProviderCredentials(config, env)
  ) {
    throw new Error(missingCredentialsMessage());
  }

  return resolvePiModelFromProvider({
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
    apiShape: runtime.apiShape,
    modelId: runtime.modelId,
    profileId: runtime.profileId,
    profileName: runtime.profileName,
    maxContextTokens: runtime.maxContextTokens,
    providerKind: runtime.providerKind,
    headers: runtime.headers,
    supportsDeveloperRole: runtime.supportsDeveloperRole,
  });
}
