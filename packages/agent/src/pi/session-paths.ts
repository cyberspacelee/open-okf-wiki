/**
 * Workspace-scoped Pi Operator Session path (ADR 0032).
 *
 * Operator conversation truth lives under `{root}/.okf-wiki/pi-sessions/`.
 */

import path from "node:path";
import { WORKSPACE_DIR_NAME } from "@okf-wiki/core";

/** Pi JSONL session tree root for a workspace. */
export function piSessionsDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_DIR_NAME, "pi-sessions");
}
