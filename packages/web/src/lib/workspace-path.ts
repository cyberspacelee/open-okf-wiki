/**
 * Build a workspace-scoped path, preserving optional rootPath query when present.
 * Extra query params (e.g. kickoff=1) are merged after rootPath.
 */
export function workspaceHref(
  workspaceId: string,
  suffix = "",
  rootPath?: string | null,
  extraQuery?: Record<string, string>,
): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
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
