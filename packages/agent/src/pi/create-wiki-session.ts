/**
 * Factory for wiki Semantic Workflow Pi sessions (ADR 0030).
 *
 * Always passes a role allowlist from tool-policy (never bash).
 * Registers Operations-wrapped Pi tools via `customTools` so write scope and
 * Source Ignores are enforced at the FS layer (see tool-operations.ts).
 * Model is optional so offline/fixture tests work without API keys.
 *
 * Product Settings integration:
 * - compaction from maxContextTokens + contextTargetTokens
 * - skills via additionalSkillPaths (producer / workspace / home)
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type ContextBudget,
  compactionSettingsFromBudget,
  resolveContextBudget,
} from "./context-budget.js";
import { piSessionsDir } from "./session-paths.js";
import { buildWikiScopedToolDefinitions, type SourceIgnoreInput } from "./tool-operations.js";
import {
  assertSafeWikiToolList,
  type PiFsToolName,
  roleMayWrite,
  toolNamesForRole,
  type WikiAgentRole,
} from "./tool-policy.js";

export type CreateWikiSessionInput = {
  role: WikiAgentRole;
  /** Pi cwd = run workdir layout (sources/, skill/, wiki/, analysis/). */
  runWorkDir: string;
  /** Optional model; omit for offline session construction (no prompt). */
  model?: Model<any>;
  /** Optional system prompt override (via DefaultResourceLoader). */
  systemPrompt?: string;
  /**
   * Prefer in-memory for tests.
   * When omitted: if `workspaceRoot` is set, uses durable
   * `SessionManager.create(runWorkDir, piSessionsDir(workspaceRoot))` (JSONL);
   * otherwise `SessionManager.inMemory(runWorkDir)`.
   */
  sessionManager?: SessionManager;
  /**
   * Product / Pi session id. When creating a new durable JSONL, passed as
   * `SessionManager.create(..., { id })` so history lookup by product id works
   * (pi-web uses the same id for file + API).
   */
  sessionId?: string;
  /**
   * Resume an existing Pi JSONL (absolute path). When set with workspaceRoot,
   * opens that file instead of creating a new empty session.
   */
  sessionFile?: string;
  /**
   * Workspace root for durable Pi JSONL sessions under
   * `{workspaceRoot}/.okf-wiki/pi-sessions/`.
   */
  workspaceRoot?: string;
  /** Optional ModelRuntime for live enterprise gateways. */
  modelRuntime?: ModelRuntime;
  /**
   * Pi agentDir for settings/auth discovery.
   * Defaults to `{runWorkDir}/.okf-pi-agent` (isolated per run).
   */
  agentDir?: string;
  /**
   * Effective Source Ignores for Operations path guards
   * (sourceId → repo-relative globs, or a flat pattern list).
   */
  sourceIgnores?: SourceIgnoreInput;
  /**
   * When true (default), pass Operations-wrapped tools as `customTools`
   * (write → wiki/ + analysis/ only; reads honor sourceIgnores).
   * Set false to use stock Pi built-ins (allowlist only).
   */
  scopedTools?: boolean;
  /**
   * Provider hard context window (tokens). Used with contextTargetTokens
   * to configure Pi auto-compaction. Falls back to model.contextWindow.
   */
  maxContextTokens?: number;
  /**
   * Workspace operational context budget. When unset, 85% of maxContextTokens.
   */
  contextTargetTokens?: number;
  /**
   * Product skill directories for Pi (producer / workspace / home).
   * Injected as additionalSkillPaths with noSkills:true (skip Pi defaults).
   */
  additionalSkillPaths?: readonly string[];
};

export type WikiSessionHandle = {
  session: AgentSession;
  role: WikiAgentRole;
  /** Tool allowlist actually passed to createAgentSession. */
  tools: readonly PiFsToolName[];
  runWorkDir: string;
  /** True when Operations-scoped customTools were registered. */
  scopedTools: boolean;
  /** Resolved context budget applied to compaction (if any). */
  contextBudget?: ContextBudget;
  /** Absolute Pi JSONL path when durable (undefined for in-memory). */
  sessionFile?: string;
  dispose: () => void;
};

/** Resolve and assert the tool allowlist for a role (unit-testable). */
export function resolveWikiSessionTools(role: WikiAgentRole): readonly PiFsToolName[] {
  const tools = toolNamesForRole(role);
  assertSafeWikiToolList(tools);
  return tools;
}

/**
 * Build customTools that override Pi built-ins with write-scope / ignore ops.
 * createAgentSession accepts `customTools?: ToolDefinition[]` and merges them
 * over built-ins by name — this is the supported Operations injection path.
 */
export function buildWikiSessionCustomTools(input: {
  role: WikiAgentRole;
  runWorkDir: string;
  sourceIgnores?: SourceIgnoreInput;
}): ToolDefinition<any, any>[] {
  return buildWikiScopedToolDefinitions({
    runWorkDir: input.runWorkDir,
    mayWrite: roleMayWrite(input.role),
    sourceIgnores: input.sourceIgnores,
  });
}

/**
 * Create an AgentSession bound to a run workdir with role tool policy.
 * Does not call prompt — safe offline when model is omitted.
 */
export async function createWikiSession(input: CreateWikiSessionInput): Promise<WikiSessionHandle> {
  const tools = resolveWikiSessionTools(input.role);
  // Defensive copy for the SDK (mutable string[]).
  const toolList = [...tools];
  assertSafeWikiToolList(toolList);

  const runWorkDir = path.resolve(input.runWorkDir);
  await mkdir(runWorkDir, { recursive: true });

  const agentDir = path.resolve(input.agentDir ?? path.join(runWorkDir, ".okf-pi-agent"));
  await mkdir(agentDir, { recursive: true });

  let sessionManager = input.sessionManager;
  if (!sessionManager) {
    if (input.workspaceRoot) {
      const sessionDir = piSessionsDir(input.workspaceRoot);
      await mkdir(sessionDir, { recursive: true });
      // Durable JSONL under workspace (ADR 0030). Resume existing file when
      // known; otherwise create with product sessionId (Pi names the file
      // `{timestamp}_{id}.jsonl` — see findPiSessionFile).
      if (input.sessionFile) {
        sessionManager = SessionManager.open(input.sessionFile, sessionDir, runWorkDir);
      } else {
        sessionManager = SessionManager.create(
          runWorkDir,
          sessionDir,
          input.sessionId ? { id: input.sessionId } : undefined,
        );
      }
    } else {
      sessionManager = SessionManager.inMemory(runWorkDir);
    }
  }

  const maxFromModel =
    typeof input.model?.contextWindow === "number" && input.model.contextWindow > 0
      ? input.model.contextWindow
      : undefined;
  const budget = resolveContextBudget({
    maxContextTokens: input.maxContextTokens ?? maxFromModel,
    contextTargetTokens: input.contextTargetTokens,
  });

  // Align model.contextWindow with product max when we own a mutable copy.
  // Pi Model is typically a plain object from registerProvider.
  if (input.model && input.model.contextWindow !== budget.contextWindow) {
    (input.model as { contextWindow: number }).contextWindow = budget.contextWindow;
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: compactionSettingsFromBudget(budget),
  });

  const skillPaths = (input.additionalSkillPaths ?? []).map((p) => p.trim()).filter(Boolean);

  const resourceLoader = new DefaultResourceLoader({
    cwd: runWorkDir,
    agentDir,
    settingsManager,
    systemPrompt: input.systemPrompt,
    noExtensions: true,
    // Skip Pi built-in skills; inject product skill paths only.
    noSkills: true,
    additionalSkillPaths: skillPaths.length > 0 ? skillPaths : undefined,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const useScoped = input.scopedTools !== false;
  const customTools = useScoped
    ? buildWikiSessionCustomTools({
        role: input.role,
        runWorkDir,
        sourceIgnores: input.sourceIgnores,
      })
    : undefined;

  const { session } = await createAgentSession({
    cwd: runWorkDir,
    agentDir,
    tools: toolList,
    customTools,
    sessionManager,
    settingsManager,
    resourceLoader,
    model: input.model,
    modelRuntime: input.modelRuntime,
  });

  return {
    session,
    role: input.role,
    tools,
    runWorkDir,
    scopedTools: useScoped,
    contextBudget: budget,
    sessionFile: session.sessionFile,
    dispose: () => {
      session.dispose();
    },
  };
}
