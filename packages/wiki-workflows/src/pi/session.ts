import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync } from "node:fs";
import path from "node:path";
import { WikiTaskExecutionError } from "../delegate-contracts.js";
import { WikiBudgetExhaustedError } from "../failures.js";
import { PiSessionObserver, readSessionUsage, type PiSessionObserverOptions } from "./observer.js";
import type { WikiAgentTelemetry, WikiContextStats, WikiExecutionBudgets } from "../producer-types.js";

export const DEFAULT_SESSION_TIMEOUT_MS = 20 * 60_000;
const MAX_SESSION_TIMEOUT_MS = 2_147_483_647;
const PARALLEL_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface PiSessionOptions {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  language?: "zh" | "en";
  createSession?: (options: CreateAgentSessionOptions) => ReturnType<typeof createAgentSession>;
  sessionTimeoutMs?: number;
  skillRoot?: string;
  sessionDir?: string;
  sessionFile?: string;
  budgets?: WikiExecutionBudgets;
  skillPath?: string;
  transientRetries?: number;
}

export type ThinkingClock = {
  pause(): void;
  resume(): void;
  remainingMs(): number;
};

export type ObserverContext = {
  target: WikiAgentTelemetry["target"];
  attempt: number;
  now?: () => number;
  onHealth?: PiSessionObserverOptions["onHealth"];
  thinkingClock?: ThinkingClock;
};

export function withExecutionModes(tools: ToolDefinition<any, any, any>[]): ToolDefinition<any, any, any>[] {
  return tools.map((tool) => ({
    ...tool,
    executionMode: PARALLEL_READ_TOOLS.has(tool.name) ? "parallel" : "sequential",
  } as ToolDefinition<any, any, any>));
}

export function createThinkingClock(timeoutMs: number): ThinkingClock {
  return {
    pause() {},
    resume() {},
    remainingMs: () => timeoutMs,
  };
}

export function validatedSessionTimeoutMs(timeoutMs = DEFAULT_SESSION_TIMEOUT_MS): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_SESSION_TIMEOUT_MS) {
    throw new Error(`sessionTimeoutMs must be an integer from 1000 to ${MAX_SESSION_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

export function validatedTransientRetries(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error("transientRetries must be a non-negative integer");
  return value;
}

export function roleSkill(skillRoot: string, role: "researcher" | "writer" | "reviewer"): Skill {
  const filePath = path.join(skillRoot, "briefs", `${role}.md`);
  if (!existsSync(filePath)) throw new Error(`Wiki ${role} brief is unavailable: briefs/${role}.md`);
  return {
    name: `wiki-${role}`,
    description: `Complete the assigned Wiki ${role} task. Load this skill, then read references relative to its directory.`,
    filePath,
    baseDir: skillRoot,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "sdk", baseDir: skillRoot }),
    disableModelInvocation: false,
  };
}

export async function runPiSession(
  cwd: string,
  tools: ToolDefinition<any, any, any>[],
  prompt: string,
  signal: AbortSignal,
  options: PiSessionOptions,
  onTelemetry?: (telemetry: WikiAgentTelemetry) => void | Promise<void>,
  observer?: ObserverContext,
  onReady?: (session: AgentSession) => void,
  role?: "researcher" | "writer" | "reviewer",
): Promise<{ text: string; usage?: WikiContextStats }> {
  const transientRetries = validatedTransientRetries(options.transientRetries ?? 1);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: transientRetries, provider: { maxRetries: transientRetries } },
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
    additionalSkillPaths: options.skillPath ? [options.skillPath] : [],
    ...(role && options.skillPath ? { skillsOverride: () => ({ skills: [roleSkill(options.skillPath!, role)], diagnostics: [] }) } : {}),
  });
  await loader.reload();
  const sessionFile = options.sessionFile;
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, options.sessionDir, cwd)
    : SessionManager.create(cwd, options.sessionDir);
  let session: AgentSession | undefined;
  let budgetError: WikiBudgetExhaustedError | undefined;
  let toolCalls = 0;
  const guardedTools = tools.map((tool) => {
    const execute = tool.execute;
    return {
      ...tool,
      async execute(toolCallId, params, toolSignal, onUpdate, context) {
        const limit = options.budgets?.maxToolCallsPerSession;
        if (limit !== undefined && toolCalls >= limit) {
          budgetError = sessionToolBudgetError(limit, toolCalls);
          void session?.abort();
          throw budgetError;
        }
        toolCalls += 1;
        return await execute(toolCallId, params, toolSignal, onUpdate, context);
      },
    } as ToolDefinition<any, any, any>;
  });
  const createOptions: CreateAgentSessionOptions = {
    cwd,
    sessionManager,
    settingsManager: settings,
    resourceLoader: loader,
    noTools: "builtin",
    tools: guardedTools.map((tool) => tool.name),
    customTools: guardedTools,
    ...(!sessionFile ? { model: options.model, thinkingLevel: options.thinkingLevel } : {}),
  };
  const created = await (options.createSession ?? createAgentSession)(createOptions);
  session = created.session;
  onReady?.(session);
  if (created.modelFallbackMessage) {
    session.dispose();
    throw new Error(`Could not restore the persisted Wiki model: ${created.modelFallbackMessage}`);
  }
  const sessionObserver = onTelemetry && observer
    ? new PiSessionObserver(session, {
      ...observer,
      timeoutMs: options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      remainingTimeoutMs: observer.thinkingClock ? () => observer.thinkingClock!.remainingMs() : undefined,
      workspaceRoot: cwd,
      report: onTelemetry,
      onHealth: observer.onHealth,
    })
    : undefined;
  const abort = () => { void session.abort(); };
  const initialUsage = readSessionUsage(session);
  let turns = initialUsage?.turns ?? 0;
  toolCalls = initialUsage?.toolCalls ?? 0;
  if (options.budgets && turns >= options.budgets.maxTurnsPerSession) {
    session.dispose();
    throw sessionTurnBudgetError(options.budgets.maxTurnsPerSession, turns);
  }
  if (options.budgets && toolCalls >= options.budgets.maxToolCallsPerSession) {
    session.dispose();
    throw sessionToolBudgetError(options.budgets.maxToolCallsPerSession, toolCalls);
  }
  const stopBudgetMonitor = typeof session.subscribe === "function"
    ? session.subscribe((event) => {
      if (event.type === "turn_end") turns += 1;
      if (event.type === "turn_start" && !budgetError && options.budgets && turns >= options.budgets.maxTurnsPerSession) {
        budgetError = sessionTurnBudgetError(options.budgets.maxTurnsPerSession, turns);
      }
      if (budgetError) void session.abort();
    })
    : undefined;
  signal.addEventListener("abort", abort, { once: true });
  try {
    sessionObserver?.start();
    try {
      await runSessionWithDeadline(session, prompt, signal, options.sessionTimeoutMs, observer?.thinkingClock);
    } catch (error) {
      const failure = budgetError ?? (signal.aborted ? sessionAbortReason(signal) : error);
      await sessionObserver?.failed(failure);
      throw failure;
    }
    if (budgetError) throw budgetError;
    if (signal.aborted) throw sessionAbortReason(signal);
    const stateError = typeof session.state.errorMessage === "string" ? session.state.errorMessage : undefined;
    if (stateError) throw new Error(stateError);
    const text = session.getLastAssistantText() ?? "";
    return { text, usage: readSessionUsage(session) };
  } finally {
    signal.removeEventListener("abort", abort);
    stopBudgetMonitor?.();
    await sessionObserver?.stop();
    session.dispose();
  }
}

async function runSessionWithDeadline(
  session: AgentSession,
  prompt: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  thinkingClock?: ThinkingClock,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let remaining = timeoutMs;
  let startedAt = Date.now();
  let paused = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    const fire = () => {
      void session.abort();
      reject(new WikiTaskExecutionError(`Wiki agent session timed out after ${timeoutMs}ms`, "timeout"));
    };
    const arm = () => {
      timer = setTimeout(fire, remaining);
    };
    if (thinkingClock) {
      thinkingClock.pause = () => {
        if (paused || timer === undefined) return;
        paused = true;
        clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      };
      thinkingClock.resume = () => {
        if (!paused) return;
        paused = false;
        startedAt = Date.now();
        arm();
      };
      thinkingClock.remainingMs = () => paused || timer === undefined
        ? remaining
        : Math.max(0, remaining - (Date.now() - startedAt));
    }
    arm();
  });
  try {
    if (signal.aborted) throw new WikiTaskExecutionError("Wiki agent session cancelled", "cancelled");
    await Promise.race([session.prompt(prompt), deadline]);
    await Promise.race([session.waitForIdle(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (thinkingClock) {
      thinkingClock.pause = () => {};
      thinkingClock.resume = () => {};
      thinkingClock.remainingMs = () => timeoutMs;
    }
  }
}

function sessionAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const message = typeof signal.reason === "string" && signal.reason.trim()
    ? signal.reason
    : "Wiki agent session cancelled";
  return new WikiTaskExecutionError(message, "cancelled", { cause: signal.reason });
}

function sessionTurnBudgetError(limit: number, turns: number): WikiBudgetExhaustedError {
  return new WikiBudgetExhaustedError(
    `Pi session turn limit exhausted (${limit})`,
    "session_turns_exhausted",
    { limit, turns },
  );
}

function sessionToolBudgetError(limit: number, toolCalls: number): WikiBudgetExhaustedError {
  return new WikiBudgetExhaustedError(
    `Pi session tool-call limit exhausted (${limit})`,
    "session_tool_calls_exhausted",
    { limit, toolCalls },
  );
}
