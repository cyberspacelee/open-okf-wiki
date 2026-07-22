/**
 * Resolve Mastra model config for Wiki Run (workspace + Settings catalog).
 * Role-specific models stay in role-models.ts; this owns the single-model path.
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import {
  loadProviderConfig,
  resolveProviderRuntime,
} from "@okf-wiki/core";

/** Model + optional provider hard window for Wiki Run context compaction. */
export type ResolvedWikiModel = {
  model: MastraModelConfig;
  maxContextTokens?: number;
};

/**
 * Resolve Mastra model config and context window from workspace + Settings catalog.
 * Supports OpenAI-compatible chat completions and the Responses API shape.
 */
export async function resolveWikiModel(
  workspace: WorkspaceConfig,
): Promise<ResolvedWikiModel> {
  const provider = await loadProviderConfig();
  const runtime = resolveProviderRuntime(provider, {
    profileId: workspace.model?.profileId,
    modelId: workspace.model?.id,
  });

  const rawId =
    runtime.modelId?.trim() ||
    workspace.model?.id?.trim() ||
    process.env.OKF_WIKI_MODEL_ID?.trim() ||
    "openai/default";
  // Mastra OpenAICompatibleConfig requires provider/model form.
  const id = (rawId.includes("/") ? rawId : `openai/${rawId}`) as `${string}/${string}`;
  const modelIdOnly = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;

  let model: MastraModelConfig;
  if (runtime.apiShape === "responses") {
    // Official / compatible Responses API via AI SDK OpenAI provider.
    const openai = createOpenAI({
      apiKey: runtime.apiKey,
      ...(runtime.baseUrl ? { baseURL: runtime.baseUrl } : {}),
    });
    model = openai.responses(modelIdOnly);
  } else {
    // Default: OpenAI-compatible chat completions (…/v1/chat/completions).
    model = {
      id,
      url: runtime.baseUrl,
      apiKey: runtime.apiKey,
    };
  }

  return {
    model,
    ...(runtime.maxContextTokens !== undefined
      ? { maxContextTokens: runtime.maxContextTokens }
      : {}),
  };
}

/**
 * Resolve Mastra model config from workspace model selection + Settings catalog.
 * Supports OpenAI-compatible chat completions and the Responses API shape.
 */
export async function resolveModelConfig(
  workspace: WorkspaceConfig,
): Promise<MastraModelConfig> {
  return (await resolveWikiModel(workspace)).model;
}
