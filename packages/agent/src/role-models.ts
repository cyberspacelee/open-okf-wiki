/**
 * Resolve planner / worker / reviewer models from workspace.roleModels.
 * Falls back to workspace.model when a role is omitted (Cursor hybrid economics).
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { ModelRef, WorkspaceConfig } from "@okf-wiki/contract";
import {
  loadProviderConfig,
  resolveProviderRuntime,
} from "@okf-wiki/core";

export type ResolvedRoleModels = {
  planner: MastraModelConfig;
  worker: MastraModelConfig;
  writer: MastraModelConfig;
  /** Primary reviewer (first council member). */
  reviewer: MastraModelConfig;
  /** Full council list (at least one). */
  reviewers: MastraModelConfig[];
  plannerMaxContextTokens?: number;
};

function toMastraModel(
  runtime: {
    modelId?: string;
    apiKey?: string;
    baseUrl?: string;
    apiShape?: string;
  },
  fallbackId: string,
): MastraModelConfig {
  const rawId =
    runtime.modelId?.trim() ||
    fallbackId ||
    process.env.OKF_WIKI_MODEL_ID?.trim() ||
    "openai/default";
  const id = (rawId.includes("/") ? rawId : `openai/${rawId}`) as `${string}/${string}`;
  const modelIdOnly = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;

  if (runtime.apiShape === "responses") {
    const openai = createOpenAI({
      apiKey: runtime.apiKey,
      ...(runtime.baseUrl ? { baseURL: runtime.baseUrl } : {}),
    });
    return openai.responses(modelIdOnly);
  }
  return {
    id,
    url: runtime.baseUrl,
    apiKey: runtime.apiKey,
  };
}

async function resolveRef(
  ref: ModelRef | undefined,
  fallback: ModelRef,
): Promise<{ model: MastraModelConfig; maxContextTokens?: number }> {
  const provider = await loadProviderConfig();
  const use = ref ?? fallback;
  const runtime = resolveProviderRuntime(provider, {
    profileId: use.profileId,
    modelId: use.id,
  });
  return {
    model: toMastraModel(runtime, use.id),
    ...(runtime.maxContextTokens !== undefined
      ? { maxContextTokens: runtime.maxContextTokens }
      : {}),
  };
}

export async function resolveRoleModels(
  workspace: WorkspaceConfig,
): Promise<ResolvedRoleModels> {
  const base = workspace.model;
  const roles = workspace.roleModels ?? { reviewers: [] };

  const plannerRes = await resolveRef(roles.planner, base);
  const workerRes = await resolveRef(roles.worker ?? roles.planner, base);
  const writerRes = await resolveRef(
    roles.writer ?? roles.planner,
    base,
  );

  const reviewerRefs =
    roles.reviewers && roles.reviewers.length > 0
      ? roles.reviewers
      : [roles.planner ?? base];

  const reviewers: MastraModelConfig[] = [];
  for (const ref of reviewerRefs.slice(0, 4)) {
    const r = await resolveRef(ref, base);
    reviewers.push(r.model);
  }
  if (reviewers.length === 0) {
    reviewers.push(plannerRes.model);
  }

  return {
    planner: plannerRes.model,
    worker: workerRes.model,
    writer: writerRes.model,
    reviewer: reviewers[0]!,
    reviewers,
    ...(plannerRes.maxContextTokens !== undefined
      ? { plannerMaxContextTokens: plannerRes.maxContextTokens }
      : {}),
  };
}
