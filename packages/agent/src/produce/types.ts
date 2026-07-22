/**
 * Shared Produce types and small host helpers.
 */

import path from "node:path";
import type {
  WikiRunPlan,
  WikiRunRecordStatus,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { WORKSPACE_DIR_NAME } from "@okf-wiki/core";

export type WikiRunAgentPhase = "plan" | "write";

/**
 * Mastra workflow step writer — agent tool/text chunks use write() (wrapped as
 * workflow-step-output); product data-* parts must use custom() so they pass
 * through toAISdkStream as UI data parts (ADR 0026 / 0027 Phase 2).
 *
 * `custom` is intentionally not declared on this type: Mastra ToolStream.custom
 * is a generic overload that is not assignable to a simple `(unknown) => …`.
 * Runtime detection via hasStreamCustom() keeps ToolStream assignable.
 */
export type WikiRunStreamWriter = {
  write: (chunk: unknown) => Promise<void>;
};

export type StreamCustomWriter = WikiRunStreamWriter & {
  custom: (chunk: {
    type: `data-${string}`;
    data: unknown;
    id?: string;
    transient?: boolean;
  }) => Promise<void>;
};

export type WikiRunAgentInput = {
  runId: string;
  workspace: WorkspaceConfig;
  autoApprove?: boolean;
  /**
   * plan: propose page set and stop for operator confirmation.
   * write: produce wiki pages (optionally guided by confirmed plan).
   */
  phase?: WikiRunAgentPhase;
  /** Confirmed plan from plan-confirm HITL (write phase). */
  plan?: WikiRunPlan;
  /** Best-effort cancellation; fixture checks periodically, live passes to Mastra. */
  abortSignal?: AbortSignal;
  /**
   * When set (Session / workflow step), forward agent fullStream chunks so
   * operators see text / tools / reasoning live. Never discard without writer.
   */
  writer?: WikiRunStreamWriter;
};

export type WikiRunAgentResult = {
  status: Extract<
    WikiRunRecordStatus,
    | "awaiting_publication"
    | "awaiting_plan"
    | "published"
    | "failed"
    | "cancelled"
  >;
  pages?: string[];
  summary?: string;
  error?: string;
  plan?: WikiRunPlan;
};

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Wiki Run cancelled");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Terminal success status after agent work.
 *
 * Always `awaiting_publication`. Publication (staging → publicationPath) is
 * owned by the server: HITL approve/deny APIs, or automatic publish when the
 * run record has `autoApprove: true`. The agent must not claim `published`.
 */
export function successStatus(
  _autoApprove: boolean | undefined,
): "awaiting_publication" {
  return "awaiting_publication";
}

export function stagingDirForRun(workspaceRoot: string, runId: string): string {
  return path.join(
    path.resolve(workspaceRoot),
    WORKSPACE_DIR_NAME,
    "staging",
    runId,
  );
}

export function buildSourceMap(workspace: WorkspaceConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of workspace.sources) {
    map.set(source.id, path.resolve(source.path));
  }
  return map;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("Wiki Run cancelled");
      err.name = "AbortError";
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("Wiki Run cancelled");
      err.name = "AbortError";
      reject(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function normalizeWikiPath(pathValue: string): string {
  return pathValue.replace(/^\.\/+/, "").replace(/^\/+/, "");
}
