import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { WikiBudgetExhaustedError } from "../failures.js";
import { exists } from "../files.js";
import type { WikiAgentUsage, WikiSessionActivity } from "../producer-types.js";

export const DEFAULT_SESSION_TIMEOUT_MS = 20 * 60_000;

export interface RunWikiSessionOptions {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  createSession?: (options: CreateAgentSessionOptions) => ReturnType<typeof createAgentSession>;
  sessionTimeoutMs?: number;
  sessionDir?: string;
  sessionFile?: string;
  maxToolCalls?: number;
  transientRetries?: number;
  baseRetryDelayMs?: number;
  onSessionReady?: (sessionFile: string | undefined) => void | Promise<void>;
  /** Must be synchronous so the recovery frame is queued before Pi checks for follow-up work. */
  onCompaction?: () => string;
  onActivity?: (event: WikiSessionActivity) => void;
  /** Validate the latest output and return a prompt to continue the same session after it becomes idle. */
  nextPrompt?: (output: string) => Promise<string | undefined>;
}

export interface RunWikiSessionResult {
  text: string;
  usage?: WikiAgentUsage;
}

export async function runWikiSession(
  cwd: string,
  tools: ToolDefinition<any, any, any>[],
  prompt: string,
  signal: AbortSignal,
  options: RunWikiSessionOptions = {},
): Promise<RunWikiSessionResult> {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: {
      enabled: true,
      maxRetries: options.transientRetries ?? 1,
      baseDelayMs: options.baseRetryDelayMs ?? 1_000,
      provider: { maxRetries: options.transientRetries ?? 1 },
    },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const resumeFile = options.sessionFile && await exists(options.sessionFile) ? options.sessionFile : undefined;
  const sessionManager = resumeFile
    ? SessionManager.open(resumeFile, options.sessionDir, cwd)
    : SessionManager.create(cwd, options.sessionDir);
  let session: AgentSession | undefined;
  let toolCalls = 0;
  let compactions = 0;
  let compactionDelivery = Promise.resolve();
  let compactionDeliveryError: unknown;
  const guarded = tools.map((tool) => {
    const execute = tool.execute;
    return {
      ...tool,
      async execute(toolCallId, params, toolSignal, onUpdate, context) {
        if (options.maxToolCalls !== undefined && toolCalls >= options.maxToolCalls) {
          throw new WikiBudgetExhaustedError("Wiki session tool-call budget exhausted", "session_tool_calls_exhausted");
        }
        toolCalls += 1;
        return await execute(toolCallId, params, toolSignal, onUpdate, context);
      },
    } as ToolDefinition<any, any, any>;
  });
  const created = await (options.createSession ?? createAgentSession)({
    cwd,
    sessionManager,
    settingsManager: settings,
    resourceLoader: loader,
    noTools: "builtin",
    tools: guarded.map((tool) => tool.name),
    customTools: guarded,
    ...(!resumeFile ? { model: options.model, thinkingLevel: options.thinkingLevel } : {}),
  });
  session = created.session;
  if (created.modelFallbackMessage) {
    session.dispose();
    throw new Error(`Could not restore the persisted Wiki model: ${created.modelFallbackMessage}`);
  }
  await options.onSessionReady?.(session.sessionFile);
  if (options.onActivity || options.onCompaction) {
    const onActivity = options.onActivity;
    const onCompaction = options.onCompaction;
    const argsById = new Map<string, unknown>();
    let assistant: { id: string; at: string } | undefined;
    const usage = (): WikiAgentUsage | undefined => readSessionUsage(session);
    session.subscribe((event) => {
      if (onActivity && event.type === "message_start" && event.message.role === "user") {
        const text = displayText(event.message.content);
        if (text) onActivity({ kind: "input", id: randomUUID(), at: messageTime(event.message), text });
      }
      if (onActivity && event.type === "message_start" && event.message.role === "assistant") {
        assistant = { id: randomUUID(), at: messageTime(event.message) };
      }
      if (onActivity && event.type === "message_update" && event.message.role === "assistant") {
        assistant ??= { id: randomUUID(), at: messageTime(event.message) };
        const text = displayText(event.message.content);
        if (text) onActivity({ kind: "output", ...assistant, text, status: "running" });
      }
      if (onActivity && event.type === "message_end" && event.message.role === "assistant") {
        assistant ??= { id: randomUUID(), at: messageTime(event.message) };
        const text = displayText(event.message.content);
        if (text) {
          const failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
          const stats = usage();
          onActivity({
            kind: "output",
            ...assistant,
            text,
            status: failed ? "failed" : "complete",
            ...(stats ? { usage: stats } : {}),
          });
        }
        assistant = undefined;
      }
      if (onActivity && event.type === "tool_execution_start") {
        argsById.set(event.toolCallId, event.args);
        const stats = usage();
        onActivity({ kind: "tool", id: event.toolCallId, at: new Date().toISOString(), tool: event.toolName, args: event.args, status: "running", ...(stats ? { usage: stats } : {}) });
      }
      if (onActivity && event.type === "tool_execution_update") {
        argsById.set(event.toolCallId, event.args);
        const stats = usage();
        onActivity({ kind: "tool", id: event.toolCallId, at: new Date().toISOString(), tool: event.toolName, args: event.args, status: "running", ...(stats ? { usage: stats } : {}) });
      }
      if (onActivity && event.type === "tool_execution_end") {
        const args = argsById.get(event.toolCallId) ?? {};
        argsById.delete(event.toolCallId);
        const stats = usage();
        const result = displayToolResult(event.result);
        onActivity({
          kind: "tool",
          id: event.toolCallId,
          at: new Date().toISOString(),
          tool: event.toolName,
          args,
          status: event.isError ? "failed" : "complete",
          ...(result ? { result } : {}),
          ...(stats ? { usage: stats } : {}),
        });
      }
      if (!onCompaction || event.type !== "compaction_end" || event.aborted || !event.result) return;
      compactions += 1;
      try {
        const text = onCompaction();
        if (!text || !session) return;
        const delivery = session.sendCustomMessage(
          { customType: "wiki-checkpoint", content: text, display: false },
          { deliverAs: "followUp" },
        ).catch((error) => {
          compactionDeliveryError = error;
          void session?.abort();
        });
        compactionDelivery = Promise.all([compactionDelivery, delivery]).then(() => undefined);
      } catch (error) {
        compactionDeliveryError = error;
        void session?.abort();
      }
    });
  }
  const abort = () => {
    void session?.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  const timeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (signal.aborted) throw new Error("Wiki agent session cancelled");
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void session?.abort();
        reject(new Error(`Wiki agent session timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    let currentPrompt: string | undefined = prompt;
    while (currentPrompt !== undefined) {
      await Promise.race([session.prompt(currentPrompt), deadline]);
      await Promise.race([session.waitForIdle(), deadline]);
      await compactionDelivery;
      if (compactionDeliveryError) throw compactionDeliveryError;
      currentPrompt = await options.nextPrompt?.(session.getLastAssistantText() ?? "");
    }
    const usage = readSessionUsage(session, compactions);
    return {
      text: session.getLastAssistantText() ?? "",
      ...(usage ? { usage } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    session.dispose();
  }
}

function messageTime(message: { timestamp?: unknown }): string {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : new Date().toISOString();
}

function displayText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((entry): entry is { type: "text"; text: string } => (
      Boolean(entry) && typeof entry === "object" && (entry as { type?: unknown }).type === "text"
      && typeof (entry as { text?: unknown }).text === "string"
    ))
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function displayToolResult(result: unknown): string | undefined {
  if (typeof result === "string") return result.trim() || undefined;
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const text = displayText((result as { content?: unknown }).content);
  return text || undefined;
}

function readSessionUsage(session: AgentSession | undefined, compactions = 0): WikiAgentUsage | undefined {
  if (typeof session?.getSessionStats !== "function") return undefined;
  const stats = session.getSessionStats();
  const context = stats.contextUsage ?? (typeof session.getContextUsage === "function" ? session.getContextUsage() : undefined);
  const usage: WikiAgentUsage = {
    input: stats.tokens.input,
    output: stats.tokens.output,
    total: stats.tokens.total,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    cost: stats.cost,
    compactions,
    turns: stats.assistantMessages,
    toolCalls: stats.toolCalls,
  };
  if (typeof context?.tokens === "number") usage.contextTokens = context.tokens;
  if (typeof context?.contextWindow === "number") usage.contextWindow = context.contextWindow;
  if (typeof context?.percent === "number") usage.contextPercent = context.percent;
  return usage;
}
