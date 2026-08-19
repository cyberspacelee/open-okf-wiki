import type { WikiArtifactRef } from "./artifact-store.js";
import type { WikiDelegateContract, WikiDelegateError, WikiDelegateGap, WikiDelegateReceipt } from "./delegate-contracts.js";
import type {
  WikiActivityEntry,
  WikiAgentSnapshot,
  WikiAgentTarget,
  WikiAgentTelemetry,
  WikiExecutionBudgets,
  WikiRunPause,
} from "./producer-types.js";
import type { WikiGenerationProfile, WikiRoleModelConfig } from "./workspace.js";

export const WIKI_MANUAL_PAUSE = Symbol.for("okf-wiki.manual-pause");

export interface WikiTaskRuntimePartial {
  outputs: WikiArtifactRef[];
  coverage: string[];
  gaps: WikiDelegateGap[];
}

export interface WikiTaskRuntimeTaskState {
  task: WikiDelegateContract;
  phase: "queued" | "running" | "paused" | "terminal";
  attempt: number;
  collected: boolean;
  pause?: WikiDelegateError;
  partial?: WikiTaskRuntimePartial;
  sessionFile?: string;
  receipt?: WikiDelegateReceipt;
}

export interface WikiTaskRuntimeBatchState {
  batchId: number;
  tasks: WikiTaskRuntimeTaskState[];
}

export interface WikiTaskRuntimeState {
  batches: WikiTaskRuntimeBatchState[];
}

export interface WikiAgentRecord {
  agent: WikiAgentSnapshot;
  process: WikiActivityEntry[];
  sessionFile?: string;
}

export interface WikiPinnedSource {
  scopeId: string;
  logicalPath: string;
  absolutePath: string;
  realPath: string;
  repositoryRoot: string;
  repositoryIdentity: string;
  origin: { type: "link"; localPath: string } | { type: "clone"; remoteUrl: string; ref?: string };
  head: string;
  dirtyFingerprint: string;
}

export interface WikiPinnedSourcePlan {
  workspaceRoot: string;
  workspaceRealPath: string;
  configPath: string;
  defaultSourceIgnores: boolean;
  excludes: string[];
  sources: WikiPinnedSource[];
  fingerprint: string;
}

export interface WikiProductionPlan {
  sourcePlan: WikiPinnedSourcePlan;
  candidateWikiRoot: string;
  skillRoot: string;
  skillTreeDigest: string;
  language: "zh" | "en";
  generation: WikiGenerationProfile;
  maxConcurrentAgents: number;
  budgets: WikiExecutionBudgets;
  models: WikiRoleModelConfig;
  runSessionDirectory: string;
  leadSessionFile?: string;
  leadSessionAttempt?: number;
  transientRetries: number;
  sessionTimeoutMs: number;
  baseRetryDelayMs: number;
  prompt: string;
}

export type WikiLeadObservation =
  | { kind: "progress"; message: string }
  | { kind: "batch"; phase: "queued" | "started" | "completed"; batch: number; taskId?: string }
  | { kind: "telemetry"; target: WikiAgentTarget; telemetry: WikiAgentTelemetry }
  | { kind: "health"; target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string };

export type WikiLeadOutcome =
  | { kind: "complete"; summary: string }
  | { kind: "pause"; reason: WikiRunPause["reason"]; summary: string; retryAt?: string };
