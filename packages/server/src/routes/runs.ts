/**
 * Read-only Wiki Run projection for the Agent Workspace.
 *
 * Wiki Run mutation belongs to the Operator Session's real Pi wiki_produce
 * tool. The server intentionally exposes no independent Run command surface.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { listRuns, loadWorkspaceById } from "@okf-wiki/core";
import { sendError, sendJson } from "../http-util.ts";

async function loadWorkspaceOr404(res: ServerResponse, id: string, url: URL) {
  const workspace = await loadWorkspaceById(id, {
    rootPath: url.searchParams.get("rootPath") ?? undefined,
  });
  if (!workspace) {
    sendError(res, 404, "workspace not found: " + id);
    return null;
  }
  return workspace;
}

/** Agent Workspace read model; old/pre-v2 Run Records are filtered by Core. */
export async function handleListRuns(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  const runs = await listRuns(workspace.rootPath);
  sendJson(res, 200, { workspaceId: workspace.id, runs });
}
