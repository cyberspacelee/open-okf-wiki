/**
 * Workspace-scoped Pi session / run path helpers (ADR 0030).
 *
 * Operator conversation truth lives under `{root}/.okf-wiki/pi-sessions/`.
 */

import path from "node:path";
import { WORKSPACE_DIR_NAME } from "@okf-wiki/core";

/** Pi JSONL session tree root for a workspace. */
export function piSessionsDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_DIR_NAME, "pi-sessions");
}

/**
 * Product run-record / workdir parent under the workspace meta dir.
 * Useful for materialising run workdirs next to Pi sessions.
 */
export function piRunsDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_DIR_NAME, "runs");
}

/** Absolute path for one Pi session file/dir under pi-sessions. */
export function piSessionPath(workspaceRoot: string, sessionId: string): string {
  const safe = sessionId.replace(/[/\\]/g, "_");
  return path.join(piSessionsDir(workspaceRoot), safe);
}

/** Absolute path for one run workdir under `.okf-wiki/runs/<runId>`. */
export function piRunWorkDir(workspaceRoot: string, runId: string): string {
  const safe = runId.replace(/[/\\]/g, "_");
  return path.join(piRunsDir(workspaceRoot), safe);
}
