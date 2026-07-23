/**
 * Resolve which Settings model profile a Wiki role should use.
 *
 * Workspace.model is the default. roleModels maps planner/worker/writer/reviewers
 * for hybrid economics. Callers may also pass an explicit profileId override
 * (e.g. operator picks a model when starting a Wiki Run).
 */

import type { ModelRef, WorkspaceConfig } from "@okf-wiki/contract";

/** Semantic roles that can select a model profile. */
export type WikiModelRole = "default" | "planner" | "worker" | "writer" | "reviewer";

export type ResolvedModelRef = {
  /** Served model id (denormalized). */
  id: string;
  profileId?: string;
  /** Which role mapping produced this ref. */
  role: WikiModelRole;
  /** True when an explicit override (e.g. start_wiki_run.modelProfileId) won. */
  overridden: boolean;
};

/**
 * Pick the ModelRef for a role, falling back to workspace.model.
 */
export function modelRefForRole(
  workspace: WorkspaceConfig,
  role: WikiModelRole = "default",
): ModelRef {
  const roles = workspace.roleModels;
  if (role === "planner" && roles?.planner) {
    return roles.planner;
  }
  if (role === "worker" && roles?.worker) {
    return roles.worker;
  }
  if (role === "writer") {
    if (roles?.writer) return roles.writer;
    if (roles?.planner) return roles.planner;
  }
  if (role === "reviewer") {
    const first = roles?.reviewers?.[0];
    if (first) return first;
  }
  return workspace.model;
}

/**
 * Resolve model selection for a live call.
 * `overrideProfileId` wins when set (operator run-time choice).
 */
export function resolveModelSelection(input: {
  workspace: WorkspaceConfig;
  role?: WikiModelRole;
  /** Explicit profile id from start_wiki_run / UI. */
  overrideProfileId?: string;
  /** Explicit free-text model id (legacy). */
  overrideModelId?: string;
}): ResolvedModelRef {
  const role = input.role ?? "default";

  if (input.overrideProfileId?.trim()) {
    return {
      id: input.overrideModelId?.trim() || input.workspace.model.id,
      profileId: input.overrideProfileId.trim(),
      role,
      overridden: true,
    };
  }

  if (input.overrideModelId?.trim() && !input.overrideProfileId) {
    // Free-text model only (no profile) — still honor as override of id.
    const base = modelRefForRole(input.workspace, role);
    return {
      id: input.overrideModelId.trim(),
      profileId: base.profileId,
      role,
      overridden: true,
    };
  }

  const ref = modelRefForRole(input.workspace, role);
  return {
    id: ref.id,
    profileId: ref.profileId,
    role,
    overridden: false,
  };
}
