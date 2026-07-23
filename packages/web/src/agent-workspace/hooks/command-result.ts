import type { AgentCommandResponse } from "@okf-wiki/contract";

/** Unified command failure check (server uses ok/status, not string heuristics). */
export function isCommandFailed(res: AgentCommandResponse | null | undefined): boolean {
  if (!res) return false;
  return res.ok === false || res.status === "failed";
}
