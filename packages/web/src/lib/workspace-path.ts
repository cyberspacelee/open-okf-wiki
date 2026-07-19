/**
 * Build a workspace-scoped path, preserving optional rootPath query when present.
 */
export function workspaceHref(
  workspaceId: string,
  suffix = "",
  rootPath?: string | null,
): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
  if (!rootPath) {
    return base;
  }
  const params = new URLSearchParams({ rootPath });
  return `${base}?${params.toString()}`;
}
