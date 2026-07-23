/**
 * Workspace-scoped paths.
 * Agent Workspace (primary operate surface) lives at `/w/:id`.
 * Secondary config/audit pages stay under `/workspaces/:id/...`.
 */

function withQuery(
  base: string,
  rootPath?: string | null,
  extraQuery?: Record<string, string>,
): string {
  const params = new URLSearchParams();
  if (rootPath) {
    params.set("rootPath", rootPath);
  }
  if (extraQuery) {
    for (const [k, v] of Object.entries(extraQuery)) {
      if (v !== undefined && v !== "") {
        params.set(k, v);
      }
    }
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Primary operate surface — Agent Workspace (`/w/:id`). */
export function agentWorkspaceHref(
  workspaceId: string,
  rootPath?: string | null,
  extraQuery?: Record<string, string>,
): string {
  return withQuery(
    `/w/${encodeURIComponent(workspaceId)}`,
    rootPath,
    extraQuery,
  );
}

/**
 * Secondary workspace pages under `/workspaces/:id{suffix}`.
 * Prefer `agentWorkspaceHref` for the operate surface (not `/session` or bare id).
 */
export function workspaceHref(
  workspaceId: string,
  suffix = "",
  rootPath?: string | null,
  extraQuery?: Record<string, string>,
): string {
  // Legacy callers sometimes used "" or "/session" for the operate surface.
  if (suffix === "" || suffix === "/session") {
    return agentWorkspaceHref(workspaceId, rootPath, extraQuery);
  }
  return withQuery(
    `/workspaces/${encodeURIComponent(workspaceId)}${suffix}`,
    rootPath,
    extraQuery,
  );
}
