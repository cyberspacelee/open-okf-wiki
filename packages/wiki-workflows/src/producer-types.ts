export type WikiRunStatus = "running" | "paused" | "succeeded" | "failed" | "cancelled";

export type WikiRunControl = "pause" | "resume" | "cancel";

export interface WikiProducerRequest {
  cwd: string;
  focus?: string;
}

interface WikiRunEventBase {
  version: 1;
  runId: string;
  at: string;
  message: string;
}

/** Lifecycle facts worth showing once. Live agent progress lives on the view. */
export type WikiRunEvent = WikiRunEventBase & (
  | { type: "started" }
  | { type: "stage"; stage: WikiRunStage; budgets?: WikiExecutionBudgets }
  | {
      type: "delegate";
      phase: "queued" | "settled";
      batch: number;
      completed: number;
      total: number;
      tasks?: WikiAgentSnapshot[];
      taskId?: string;
    }
  | { type: "paused"; reason?: WikiRunPause["reason"]; retryAt?: string }
  | { type: "resumed" }
  | { type: "cancelled" }
  | { type: "completed" }
  | { type: "failed" }
  | { type: "warning"; code: "cleanup_failed"; detail: string }
);

export type WikiRunStage = "prepare" | "lead" | "validate" | "publish";

export interface WikiContextStats {
  turns?: number;
  toolCalls?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  cost?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  model?: string;
}

export interface WikiActiveTool {
  id?: string;
  name: string;
  startedAt: string;
  summary?: string;
}

export type WikiAgentTarget =
  | { kind: "lead" }
  | { kind: "task"; batch: number; taskId: string };

export type WikiAgentStatus = "queued" | "running" | "retrying" | "complete" | "incomplete" | "failed" | "cancelled";

export type WikiAgentActivity =
  | "responding"
  | "tool"
  | "idle"
  | "compacting"
  | "starting"
  | "waiting_model"
  | "streaming"
  | "using_tool"
  | "delegating"
  | "synthesizing"
  | "retry_wait"
  | "finishing"
  | "settled";

export interface WikiAgentSnapshot {
  target: WikiAgentTarget;
  role: "lead" | "research" | "write" | "review";
  status: WikiAgentStatus;
  attempt: number;
  activity: WikiAgentActivity;
  activeTools: WikiActiveTool[];
  health: "healthy" | "degraded";
  startedAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  lastHeartbeatAt?: string;
  deadlineAt?: string;
  usage?: WikiContextStats;
  summary?: string;
  process?: WikiActivityEntry[];
}

export type WikiActivityKind = "agent" | "tool" | "retry" | "compaction" | "warning" | "failure";

export interface WikiActivityEntry {
  sequence: number;
  at: string;
  kind: WikiActivityKind;
  severity: "info" | "warning" | "error";
  target?: WikiAgentTarget;
  message: string;
  toolCallId?: string;
  toolName?: string;
  summary?: string;
  durationMs?: number;
  completed?: boolean;
}

export interface WikiDelegationBatchSummary {
  batch: number;
  status: "running" | "complete" | "partial" | "failed";
  completed: number;
  total: number;
  startedAt?: string;
  completedAt?: string;
  tasks: WikiAgentSnapshot[];
}

/** Normalized checkpoint emitted by a Pi session observer. */
export interface WikiAgentTelemetry {
  target: WikiAgentTarget;
  attempt: number;
  sampledAt: string;
  activity?: WikiAgentActivity;
  activeTools?: WikiActiveTool[];
  lastActivityAt?: string;
  lastHeartbeatAt?: string;
  deadlineAt?: string;
  usage?: WikiContextStats;
  process?: WikiActivityEntry[];
  /** Pi-managed persistent session file for exact resume. */
  sessionFile?: string;
}

export interface WikiExecutionBudgets {
  maxDelegatedTasks: number;
  maxDelegateBatches: number;
  maxTurnsPerSession: number;
  maxToolCallsPerSession: number;
}

export interface WikiRunProgress {
  stage: WikiRunStage;
  lead?: WikiAgentSnapshot;
  currentBatch?: WikiDelegationBatchSummary;
  batches?: WikiDelegationBatchSummary[];
  recentActivity?: WikiActivityEntry[];
  language?: "zh" | "en";
  lastMessage?: string;
  /** Aggregate terminal/current usage, deduplicated by Agent target and attempt. */
  usage?: WikiContextStats;
  budgets?: WikiExecutionBudgets;
}

export interface WikiAgentInspection {
  runId: string;
  agent: WikiAgentSnapshot;
  process: WikiActivityEntry[];
  messages?: ReadonlyArray<{ at: string; text: string }>;
  outcome?: WikiAgentOutcome;
  handoff?: string;
  handoffPath?: string;
}

/** Stable public projection of an Agent outcome; durable implementation references stay private. */
export interface WikiAgentOutcome {
  id: string;
  role: "research" | "write" | "review";
  status: "complete" | "incomplete" | "failed";
  summary: string;
  coverage: string[];
  gaps: Array<{ question: string; sourceScopeIds?: string[] }>;
  completedAssignmentIds?: string[];
  followups?: Array<{ id: string; kind: "unread_scope" | "evidence_gap" | "conflict" | "taxonomy_uncertain" | "tool_failure"; question: string; sourceScopeIds: string[] }>;
  domains?: Array<{ sourceScopeId: string; domainId: string; conceptIds: string[] }>;
  error?: { code: string; message: string; retryable: boolean; retryAfterMs?: number };
  attempts: number;
  review?: {
    verdict: "pass" | "changes_requested";
    reviewedPaths: string[];
    findings: Array<{ id: string; path: string; severity: "critical" | "major" | "minor" }>;
    profileCoverage: string[];
  };
}

export interface WikiRunView {
  id: string;
  cwd: string;
  focus?: string;
  status: WikiRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  pause?: WikiRunPause;
  warnings?: WikiRunWarning[];
  progress?: WikiRunProgress;
}

export interface WikiRunWarning {
  code: "cleanup_failed";
  message: string;
  at: string;
}

export interface WikiProducerResult {
  runId: string;
  status: "succeeded";
  pages: string[];
  sourceFingerprint: string;
  summary: string;
}

export interface WikiRunPause {
  reason: "quota" | "usage_limit";
  summary: string;
  retryAt?: string;
}

export interface WikiInspectOptions {
  /** Session transcript messages. Loaded only when `transcript === true`. */
  transcript?: boolean;
  /** Artifact handoff text. Loaded only when `handoff === true`. */
  handoff?: boolean;
}

export interface WikiRunHandle {
  readonly id: string;
  view(): Promise<WikiRunView>;
  updates(signal?: AbortSignal): AsyncIterable<WikiRunUpdate>;
  result(): Promise<WikiProducerResult>;
  control(action: WikiRunControl): Promise<WikiRunView>;
  inspectAgent(target: WikiAgentTarget, options?: WikiInspectOptions): Promise<WikiAgentInspection | undefined>;
}

/** Complete public producer interface. Implementations are intentionally opaque. */
export interface WikiProducer {
  start(request: WikiProducerRequest): Promise<WikiRunHandle>;
  open(runId: string, cwd: string): Promise<WikiRunHandle | undefined>;
  list(cwd: string): Promise<WikiRunView[]>;
}

export interface WikiRunUpdate {
  event: WikiRunEvent;
  view: WikiRunView;
}

export class WikiRunResultError extends Error {
  constructor(
    readonly runId: string,
    readonly status: Extract<WikiRunStatus, "failed" | "cancelled">,
    message: string,
  ) {
    super(message);
    this.name = "WikiRunResultError";
  }
}
