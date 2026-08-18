import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type {
  WikiActiveTool,
  WikiActivityEntry,
  WikiAgentActivity,
  WikiAgentTarget,
  WikiAgentTelemetry,
  WikiContextStats,
} from "./producer-types.js";

const HEARTBEAT_MS = 5_000;
const UPDATE_COALESCE_MS = 250;
const MAX_SUMMARY_CHARS = 240;
const MAX_PATH_CHARS = 300;
const MAX_PROCESS_ENTRIES = 200;
const MAX_DELIVERY_QUEUE = 48;

type DeliveryClass = "coalesce" | "lifecycle";

interface QueuedTelemetry {
  class: DeliveryClass;
  telemetry: WikiAgentTelemetry;
}

export interface PiSessionObserverOptions {
  target: WikiAgentTarget;
  attempt: number;
  timeoutMs: number;
  remainingTimeoutMs?: () => number;
  workspaceRoot: string;
  report: (telemetry: WikiAgentTelemetry) => void | Promise<void>;
  onHealth?: (input: { target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string }) => void | Promise<void>;
  now?: () => number;
  heartbeatMs?: number;
}

/** Wiki-specific projection of Pi lifecycle events. It never retains message or tool result bodies. */
export class PiSessionObserver {
  private readonly activeTools = new Map<string, WikiActiveTool>();
  private readonly process: WikiActivityEntry[] = [];
  private readonly startedAt: number;
  private readonly deadlineAt: string;
  private activity: WikiAgentActivity = "starting";
  private lastActivityAt: string;
  private lastHeartbeatAt: string;
  private sequence = 0;
  private dirty = false;
  private updateTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly queue: QueuedTelemetry[] = [];
  private pumping = false;
  private deliveryIdle = Promise.resolve();
  private failedDelivery?: QueuedTelemetry;
  private lastQueuedProcessSignature?: string;
  private lastQueuedFingerprint?: string;
  private healthDelivery = Promise.resolve();
  private unsubscribe?: () => void;
  private degraded = false;

  constructor(
    private readonly session: AgentSession,
    private readonly options: PiSessionObserverOptions,
  ) {
    this.startedAt = this.now();
    this.lastActivityAt = this.iso(this.startedAt);
    this.lastHeartbeatAt = this.lastActivityAt;
    this.deadlineAt = this.iso(this.startedAt + options.timeoutMs);
  }

  start(): void {
    if (typeof this.session.subscribe === "function") {
      this.unsubscribe = this.session.subscribe((event) => this.onEvent(event));
    }
    this.emit(true);
    this.heartbeatTimer = setInterval(() => {
      this.lastHeartbeatAt = this.iso();
      this.emit(true, false, true);
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  async failed(error: unknown): Promise<void> {
    const at = this.markActivity();
    this.addProcess({
      at,
      kind: "failure",
      severity: "error",
      message: `Pi session failed (${failureCode(error)})`,
      completed: true,
    });
    this.emit(true, true);
    await this.flush();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    if (this.dirty) this.emit(true);
    await this.flush();
  }

  private onEvent(event: AgentSessionEvent): void {
    const at = this.markActivity();
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        this.activity = "waiting_model";
        this.emit(true);
        return;
      case "message_start":
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.activity = this.activeTools.size > 0 ? "using_tool" : "streaming";
        this.emit(false);
        return;
      case "message_end":
        if (event.message.role !== "assistant") return;
        this.activity = this.activeTools.size > 0 ? "using_tool" : "waiting_model";
        this.emit(false);
        return;
      case "tool_execution_start": {
        const tool: WikiActiveTool = {
          id: event.toolCallId,
          name: event.toolName,
          startedAt: at,
          summary: safeToolSummary(event.toolName, event.args, this.options.workspaceRoot),
        };
        this.activeTools.set(event.toolCallId, tool);
        this.activity = toolActivity(event.toolName);
        this.addProcess({
          at,
          kind: "tool",
          severity: "info",
          message: "",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          summary: tool.summary,
          completed: false,
        });
        this.emit(true);
        return;
      }
      case "tool_execution_update": {
        const summary = safeToolSummary(event.toolName, event.args, this.options.workspaceRoot);
        const tool = this.activeTools.get(event.toolCallId);
        if (tool) tool.summary = summary;
        this.patchProcess(
          (entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId && !entry.completed,
          { summary },
        );
        this.emit(false);
        return;
      }
      case "tool_execution_end": {
        const tool = this.activeTools.get(event.toolCallId);
        this.activeTools.delete(event.toolCallId);
        this.activity = this.activeTools.size > 0
          ? "using_tool"
          : isDelegateTool(event.toolName) ? "synthesizing"
          : event.toolName === "wiki_finish" ? "finishing"
          : "waiting_model";
        const existing = this.findProcess((entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId && !entry.completed);
        const startedAt = tool?.startedAt ?? existing?.at;
        const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
        const completed = {
          kind: "tool" as const,
          severity: event.isError ? "error" as const : "info" as const,
          message: event.isError ? toolErrorMessage(event.toolName, event.result) : "",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          summary: tool?.summary ?? existing?.summary,
          durationMs: Number.isFinite(startedMs) ? Math.max(0, this.now() - startedMs) : undefined,
          completed: true,
        };
        if (existing) Object.assign(existing, completed);
        else this.addProcess({ at, ...completed });
        this.emit(true);
        return;
      }
      case "compaction_start":
        this.activity = "compacting";
        this.addProcess({ at, kind: "compaction", severity: "info", message: `Context compaction started (${event.reason})`, completed: false });
        this.emit(true);
        return;
      case "compaction_end": {
        this.activity = this.activeTools.size > 0 ? "using_tool" : "waiting_model";
        const completed = {
          kind: "compaction" as const,
          severity: event.aborted || event.errorMessage ? "warning" as const : "info" as const,
          message: event.aborted ? "Context compaction aborted" : event.errorMessage ? "Context compaction failed" : "Context compaction completed",
          completed: true,
        };
        if (!this.patchProcess((entry) => entry.kind === "compaction" && !entry.completed, completed)) {
          this.addProcess({ at, ...completed });
        }
        this.emit(true);
        return;
      }
      case "turn_end":
        this.activity = "waiting_model";
        this.emit(true, true);
        return;
      case "agent_end":
        // Pi may still compact, retry, or continue after agent_end.
        this.activity = event.willRetry ? "retry_wait" : this.activeTools.size > 0 ? "using_tool" : "waiting_model";
        this.emit(true, true);
        return;
      case "agent_settled":
        this.activeTools.clear();
        this.activity = "settled";
        this.addProcess({ at, kind: "agent", severity: "info", message: "Pi session settled", completed: true });
        this.emit(true, true);
        return;
      case "auto_retry_start":
        this.activity = "retry_wait";
        this.addProcess({ at, kind: "warning", severity: "warning", message: `Unexpected Pi auto retry ${event.attempt}/${event.maxAttempts}`, completed: false });
        this.emit(true);
        return;
      case "auto_retry_end":
        this.activity = event.success ? "waiting_model" : "settled";
        this.addProcess({ at, kind: "warning", severity: "warning", message: `Unexpected Pi auto retry ${event.success ? "completed" : "failed"}`, completed: true });
        this.emit(true);
        return;
      default:
        return;
    }
  }

  private emit(immediate: boolean, includeUsage = false, coalesce = !immediate): void {
    this.dirty = true;
    if (!immediate) {
      if (!this.updateTimer) {
        this.updateTimer = setTimeout(() => {
          this.updateTimer = undefined;
          this.emit(true, false, true);
        }, UPDATE_COALESCE_MS);
        this.updateTimer.unref?.();
      }
      return;
    }
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.dirty = false;
    const processSignature = processUiSignature(this.process);
    const includeProcess = processSignature !== this.lastQueuedProcessSignature;
    const telemetry: WikiAgentTelemetry = {
      target: this.options.target,
      attempt: this.options.attempt,
      sampledAt: this.iso(),
      activity: this.activity,
      activeTools: [...this.activeTools.values()],
      lastActivityAt: this.lastActivityAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      deadlineAt: this.options.remainingTimeoutMs
        ? this.iso(this.now() + this.options.remainingTimeoutMs())
        : this.deadlineAt,
      ...(includeProcess ? { process: this.process.map((entry) => ({ ...entry })) } : {}),
      ...(includeUsage ? { usage: readSessionUsage(this.session) } : {}),
      ...(this.session.sessionFile ? { sessionFile: this.session.sessionFile } : {}),
    };
    const fingerprint = telemetryUiFingerprint(telemetry, processSignature);
    if (coalesce && fingerprint === this.lastQueuedFingerprint) return;
    if (!this.enqueue(telemetry, coalesce ? "coalesce" : "lifecycle")) return;
    this.lastQueuedFingerprint = fingerprint;
    if (includeProcess) this.lastQueuedProcessSignature = processSignature;
  }

  private enqueue(telemetry: WikiAgentTelemetry, deliveryClass: DeliveryClass): boolean {
    if (this.failedDelivery && (deliveryClass === "lifecycle" || this.failedDelivery.class === "coalesce")) {
      // Lifecycle checkpoints outrank replaceable UI frames. A heartbeat may
      // update a failed coalesce, but cannot erase a failed terminal snapshot.
      this.failedDelivery = { class: deliveryClass, telemetry };
    }
    if (deliveryClass === "coalesce") {
      const existing = this.queue.findIndex((item) => item.class === "coalesce");
      if (existing >= 0) this.queue.splice(existing, 1);
    }
    if (this.queue.length >= MAX_DELIVERY_QUEUE) {
      const replaceable = this.queue.findIndex((item) => item.class === "coalesce");
      if (replaceable >= 0) this.queue.splice(replaceable, 1);
      else if (deliveryClass === "lifecycle") {
        // Lifecycle snapshots are state checkpoints, not an append-only log.
        // Replacing the oldest one preserves the newest terminal state while
        // keeping the in-memory queue bounded under a blocked reporter.
        this.queue.shift();
      } else {
        this.saturateQueue();
        return false;
      }
      this.saturateQueue();
    }
    this.queue.push({ class: deliveryClass, telemetry });
    void this.pump();
    return true;
  }

  private saturateQueue(): void {
    if (this.degraded) return;
    this.degraded = true;
    this.reportHealth({
      target: this.options.target,
      status: "degraded",
      at: this.iso(),
      message: "Telemetry delivery queue saturated",
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    let settle!: () => void;
    this.deliveryIdle = new Promise<void>((resolve) => { settle = resolve; });
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;
        const delivered = await this.deliver(item.telemetry);
        if (delivered) {
          // A coalesce cannot make a failed lifecycle checkpoint obsolete.
          if (!this.failedDelivery || item.class === "lifecycle" || this.failedDelivery.class === "coalesce") {
            this.failedDelivery = undefined;
          }
        } else {
          this.failedDelivery = item;
        }
      }
      if (this.queue.length === 0 && !this.failedDelivery && this.degraded) {
        this.degraded = false;
        this.reportHealth({ target: this.options.target, status: "healthy", at: this.iso() });
      }
    } finally {
      this.pumping = false;
      settle();
      if (this.queue.length > 0) void this.pump();
    }
  }

  private async flush(): Promise<void> {
    for (;;) {
      await this.deliveryIdle;
      if (this.queue.length === 0 && !this.pumping) {
        if (this.failedDelivery) {
          const retry = this.failedDelivery;
          this.failedDelivery = undefined;
          if (!(await this.deliver(retry.telemetry))) this.failedDelivery = retry;
          if (this.failedDelivery) break;
          if (this.degraded && this.queue.length === 0) {
            this.degraded = false;
            this.reportHealth({ target: this.options.target, status: "healthy", at: this.iso() });
          }
          continue;
        }
        break;
      }
      if (!this.pumping) void this.pump();
    }
    await this.healthDelivery;
  }

  private async deliver(telemetry: WikiAgentTelemetry): Promise<boolean> {
    try {
      await this.options.report(telemetry);
      return true;
    } catch (error) {
      if (!this.degraded) {
        this.degraded = true;
        this.reportHealth({
          target: this.options.target,
          status: "degraded",
          at: this.iso(),
          message: healthError(error),
        });
      }
      return false;
    }
  }

  private reportHealth(input: { target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string }): void {
    this.healthDelivery = this.healthDelivery.then(async () => {
      try {
        await this.options.onHealth?.(input);
      } catch {
        // Health reporting is deliberately outside the telemetry delivery path.
      }
    });
  }

  private addProcess(entry: Omit<WikiActivityEntry, "sequence" | "target">): void {
    this.process.push({ ...entry, sequence: ++this.sequence, target: this.options.target });
    if (this.process.length > MAX_PROCESS_ENTRIES) this.process.splice(0, this.process.length - MAX_PROCESS_ENTRIES);
  }

  private findProcess(match: (entry: WikiActivityEntry) => boolean): WikiActivityEntry | undefined {
    return this.process.findLast(match);
  }

  private patchProcess(match: (entry: WikiActivityEntry) => boolean, patch: Partial<WikiActivityEntry>): boolean {
    const entry = this.findProcess(match);
    if (!entry) return false;
    Object.assign(entry, patch);
    return true;
  }

  private markActivity(): string {
    this.lastActivityAt = this.iso();
    return this.lastActivityAt;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private iso(value = this.now()): string {
    return new Date(value).toISOString();
  }
}

function processUiSignature(process: readonly WikiActivityEntry[]): string {
  return process.map((entry) => `${entry.sequence}\0${entry.completed ?? ""}\0${entry.summary ?? ""}\0${entry.message}`).join("\n");
}

function telemetryUiFingerprint(telemetry: WikiAgentTelemetry, processSignature: string): string {
  const tools = (telemetry.activeTools ?? [])
    .map((tool) => `${tool.id ?? ""}\0${tool.name}\0${tool.summary ?? ""}`)
    .join("\n");
  return [
    telemetry.activity ?? "",
    tools,
    telemetry.lastActivityAt ?? "",
    telemetry.lastHeartbeatAt ?? "",
    processSignature,
    telemetry.usage ? "u" : "",
    telemetry.sessionFile ?? "",
  ].join("\0");
}

function toolActivity(name: string): WikiAgentActivity {
  if (isDelegateTool(name)) return "delegating";
  if (name === "wiki_finish") return "finishing";
  return "using_tool";
}

/** First-line error snippet only. Never persist tool result bodies. */
function toolErrorReason(result: unknown): string | undefined {
  const content = record(result)?.content;
  const text = record(Array.isArray(content) ? content[0] : undefined)?.text;
  return typeof text === "string" ? shortString(text.split(/\r?\n/, 1)[0] ?? "", MAX_SUMMARY_CHARS) : undefined;
}

/**
 * Process-log error for one tool call. Wiki result bodies stay suppressed
 * unless the host labeled the error (`<tool> rejected: …` or input exactness),
 * which wikiToolRejected already collapses to one safe line; the redundant
 * tool-name prefix is stripped because the row already labels the tool.
 */
function toolErrorMessage(name: string, result: unknown): string {
  const reason = toolErrorReason(result);
  if (!reason) return "failed";
  if (!isWikiTool(name)) return reason;
  if (!reason.startsWith(`${name} `)) return "failed";
  return reason.slice(name.length + 1).replace(/^rejected: /, "").trim() || "failed";
}

function safeToolSummary(name: string, rawArgs: unknown, workspaceRoot: string): string | undefined {
  if (name === "wiki_delegate_start") return "start ready wave";
  if (name === "wiki_taxonomy") return "accept taxonomy";
  if (name === "wiki_plan") return "accept Wiki plan";
  if (name === "wiki_finish") return "finish Wiki";
  const args = record(rawArgs);
  if (!args) return wikiControlSummary(name, {});
  const relativePath = safePath(args.path, workspaceRoot);
  if (name === "read" || name === "ls" || name === "write" || name === "edit") return relativePath;
  if (name === "grep" || name === "find") return joinSummary(shortString(args.pattern, 80), relativePath);
  return wikiControlSummary(name, args);
}

function isDelegateTool(name: string): boolean {
  return name === "wiki_delegate_start" || name === "wiki_delegate_collect" || name === "wiki_delegate_cancel";
}

function wikiControlSummary(name: string, args: Record<string, unknown>): string | undefined {
  if (name === "wiki_delegate_collect") {
    const until = args.until === "any" || args.until === "all" ? args.until : undefined;
    const timeout = Number.isInteger(args.timeoutSeconds) && (args.timeoutSeconds as number) >= 0
      ? `${args.timeoutSeconds}s`
      : undefined;
    return joinSummary("collect", until, timeout);
  }
  if (name === "wiki_delegate_cancel") {
    const reason = args.reasonCode === "blocked" || args.reasonCode === "superseded" || args.reasonCode === "user_requested"
      ? args.reasonCode.replace("_", " ")
      : undefined;
    return joinSummary("cancel wave", reason);
  }
  if (name === "wiki_research_finish") {
    const status = args.status === "complete" || args.status === "incomplete" ? args.status : undefined;
    return joinSummary("finish research", status);
  }
  if (name === "wiki_review_finish") {
    const verdict = args.verdict === "pass" ? "pass" : args.verdict === "changes_requested" ? "changes requested" : undefined;
    return joinSummary("finish review", verdict);
  }
  if (name === "wiki_write_finish") return "finish write";
  return undefined;
}

function isWikiTool(name: string): boolean { return name.startsWith("wiki_"); }

function joinSummary(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part));
  if (present.length === 0) return undefined;
  const text = present.join("  ");
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS - 15)}...[truncated]`;
}

function safePath(value: unknown, workspaceRoot: string): string | undefined {
  const raw = shortString(value, MAX_PATH_CHARS * 2);
  if (!raw) return undefined;
  const absolute = path.resolve(workspaceRoot, raw);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "[outside-workspace]";
  return shortString(relative.replaceAll(path.sep, "/") || ".", MAX_PATH_CHARS);
}

function shortString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 15))}...[truncated]`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function failureCode(error: unknown): string {
  const value = record(error);
  if (typeof value?.code === "string" && /^[a-z0-9_]{1,40}$/i.test(value.code)) return value.code;
  if (typeof value?.status === "number") return `http_${value.status}`;
  return "session_error";
}

function healthError(error: unknown): string {
  return error instanceof Error ? shortString(error.message, MAX_SUMMARY_CHARS) ?? "Telemetry delivery failed" : "Telemetry delivery failed";
}

export function readSessionUsage(session: AgentSession): WikiContextStats | undefined {
  let stats;
  try {
    stats = session.getSessionStats();
  } catch {
    return undefined;
  }
  let context = stats.contextUsage;
  if (!context) {
    try {
      context = session.getContextUsage();
    } catch {
      context = undefined;
    }
  }
  return {
    turns: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    total: stats.tokens.total,
    cost: stats.cost,
    ...(finite(context?.tokens) !== undefined ? { contextTokens: finite(context?.tokens) } : {}),
    ...(finite(context?.contextWindow) !== undefined ? { contextWindow: finite(context?.contextWindow) } : {}),
    ...(finite(context?.percent) !== undefined ? { contextPercent: finite(context?.percent) } : {}),
  };
}
