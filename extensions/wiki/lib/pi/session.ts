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
  onSessionReady?: (sessionFile: string | undefined) => void;
  onCompaction?: () => string | Promise<string>;
  onActivity?: (event: WikiSessionActivity) => void;
}

export async function runWikiSession(
  cwd: string,
  tools: ToolDefinition<any, any, any>[],
  prompt: string,
  signal: AbortSignal,
  options: RunWikiSessionOptions = {},
): Promise<string> {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3, provider: { maxRetries: 3 } },
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
    ...(!options.sessionFile ? { model: options.model, thinkingLevel: options.thinkingLevel } : {}),
  });
  session = created.session;
  if (created.modelFallbackMessage) {
    session.dispose();
    throw new Error(`Could not restore the persisted Wiki model: ${created.modelFallbackMessage}`);
  }
  options.onSessionReady?.(session.sessionFile);
  if (options.onActivity || options.onCompaction) {
    const onActivity = options.onActivity;
    const onCompaction = options.onCompaction;
    const argsById = new Map<string, unknown>();
    const usage = (): WikiAgentUsage | undefined => {
      if (typeof session?.getSessionStats !== "function") return undefined;
      const tokens = session.getSessionStats().tokens;
      return { input: tokens.input, output: tokens.output, total: tokens.total };
    };
    session.subscribe((event) => {
      if (onActivity && event.type === "tool_execution_start") {
        argsById.set(event.toolCallId, event.args);
        const stats = usage();
        onActivity({ id: event.toolCallId, tool: event.toolName, args: event.args, status: "running", ...(stats ? { usage: stats } : {}) });
      }
      if (onActivity && event.type === "tool_execution_update") {
        argsById.set(event.toolCallId, event.args);
        onActivity({ id: event.toolCallId, tool: event.toolName, args: event.args, status: "running" });
      }
      if (onActivity && event.type === "tool_execution_end") {
        const args = argsById.get(event.toolCallId) ?? {};
        argsById.delete(event.toolCallId);
        const stats = usage();
        onActivity({
          id: event.toolCallId,
          tool: event.toolName,
          args,
          status: event.isError ? "failed" : "complete",
          ...(stats ? { usage: stats } : {}),
        });
      }
      if (!onCompaction || event.type !== "compaction_end" || event.aborted) return;
      void Promise.resolve(onCompaction()).then((text) => {
        if (!text || !session) return;
        return session.sendCustomMessage(
          { customType: "wiki-board", content: text, display: false },
          { deliverAs: "nextTurn" },
        );
      });
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
    await Promise.race([session.prompt(prompt), deadline]);
    await Promise.race([session.waitForIdle(), deadline]);
    return session.getLastAssistantText() ?? "";
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    session.dispose();
  }
}
