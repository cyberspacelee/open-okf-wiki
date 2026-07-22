import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { createCodeMode } from "@mastra/core/tools";
import { LocalFilesystem, LocalSandbox, Workspace } from "@mastra/core/workspace";
import type {
  WikiRunPlan,
  WikiRunRecordStatus,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import {
  WORKSPACE_DIR_NAME,
  buildSourceIgnoreMap,
  effectiveIgnoresForSource,
  hasProviderCredentials,
  loadProviderConfig,
  resolveProviderRuntime,
  writeAnalysisReceipt,
} from "@okf-wiki/core";
import { adaptiveLimitsInstruction } from "./limits.js";
import { listMarkdownPages, writeFileContained } from "./fs-ops.js";
import { resolveSkillPath } from "./skill-path.js";
import { createSubagents, subagentsAsAgentsMap } from "./subagents.js";
import { createWikiRunTools } from "./tools.js";
import { buildPlanProgressData } from "./ui-projection.js";
import { redactErrorMessage } from "./run-redact.js";

export { redactErrorMessage } from "./run-redact.js";

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

type StreamCustomWriter = WikiRunStreamWriter & {
  custom: (chunk: {
    type: `data-${string}`;
    data: unknown;
    id?: string;
    transient?: boolean;
  }) => Promise<void>;
};

function hasStreamCustom(
  writer: WikiRunStreamWriter,
): writer is StreamCustomWriter {
  return (
    typeof (writer as { custom?: unknown }).custom === "function"
  );
}

function normalizeWikiPath(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

/**
 * Emit a data-* UI part via writer.custom when available (framework path).
 * Falls back to write() only for non-ToolStream test doubles.
 */
async function writeCustomDataPart(
  writer: WikiRunStreamWriter | undefined,
  part: { type: `data-${string}`; data: unknown; id?: string },
): Promise<void> {
  if (!writer) {
    return;
  }
  if (hasStreamCustom(writer)) {
    await writer.custom(part);
    return;
  }
  await writer.write(part);
}

/** Emit plan page checklist from step writer (source of truth for Session UI). */
async function emitPlanProgressFromWriter(
  writer: WikiRunStreamWriter | undefined,
  input: {
    plan?: WikiRunPlan;
    writtenPaths: Iterable<string>;
    runId: string;
    phase?: string;
  },
): Promise<void> {
  if (!writer) {
    return;
  }
  const data = buildPlanProgressData({
    planPages: input.plan?.pages,
    writtenPaths: input.writtenPaths,
    runId: input.runId,
    phase: input.phase ?? "writing",
  });
  if (data.pages.length === 0) {
    return;
  }
  await writeCustomDataPart(writer, {
    type: "data-plan-progress",
    data,
  });
}

/**
 * Extract write_wiki path from a Mastra agent fullStream chunk (tool-result /
 * tool-call with path). Returns undefined when not a write completion.
 */
function writePathFromAgentChunk(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") {
    return undefined;
  }
  const c = chunk as {
    type?: string;
    payload?: {
      toolName?: string;
      args?: unknown;
      result?: unknown;
      output?: unknown;
    };
  };
  const type = c.type ?? "";
  if (
    type !== "tool-result" &&
    type !== "tool-call-result" &&
    type !== "tool-output"
  ) {
    return undefined;
  }
  const payload = c.payload;
  if (!payload) {
    return undefined;
  }
  const toolName = payload.toolName;
  if (toolName && toolName !== "write_wiki") {
    return undefined;
  }
  // When toolName is omitted, still accept path-shaped results (fixture).
  const result = payload.result ?? payload.output;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const path = (result as { path?: unknown }).path;
    if (typeof path === "string" && path) {
      return normalizeWikiPath(path);
    }
  }
  if (payload.args && typeof payload.args === "object") {
    const path = (payload.args as { path?: unknown }).path;
    if (typeof path === "string" && path) {
      return normalizeWikiPath(path);
    }
  }
  return undefined;
}

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

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|AbortError/i.test(message);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Wiki Run cancelled");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * True when we should skip the LLM and write a fixture page.
 * Checks process env and the machine-local provider profile.
 */
export async function shouldUseFixtureMode(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env.OKF_WIKI_AGENT_MODE === "fixture") {
    return true;
  }
  if (env.OKF_WIKI_AGENT_MODE === "live") {
    return false;
  }
  // Default: fixture when no stored profile or OPENAI_* credentials exist.
  try {
    const provider = await loadProviderConfig();
    return !hasProviderCredentials(provider, env);
  } catch {
    const hasKey = Boolean(env.OPENAI_API_KEY?.trim());
    const hasUrl = Boolean(env.OPENAI_BASE_URL?.trim());
    return !hasKey && !hasUrl;
  }
}

export function stagingDirForRun(workspaceRoot: string, runId: string): string {
  return path.join(
    path.resolve(workspaceRoot),
    WORKSPACE_DIR_NAME,
    "staging",
    runId,
  );
}

/**
 * Terminal success status after agent work.
 *
 * Always `awaiting_publication`. Publication (staging → publicationPath) is
 * owned by the server: HITL approve/deny APIs, or automatic publish when the
 * run record has `autoApprove: true`. The agent must not claim `published`.
 */
function successStatus(_autoApprove: boolean | undefined): "awaiting_publication" {
  return "awaiting_publication";
}

function buildSourceMap(workspace: WorkspaceConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of workspace.sources) {
    map.set(source.id, path.resolve(source.path));
  }
  return map;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

function buildFixturePlan(input: WikiRunAgentInput): WikiRunPlan {
  const title = input.workspace.name || "Repository overview";
  const notes = input.plan?.notes?.trim();
  const revised = Boolean(notes && /operator revision feedback/i.test(notes));
  return {
    summary: revised
      ? `Revised fixture plan for ${title} after operator feedback.`
      : `Fixture plan for ${title}: one overview page grounded in registered sources.`,
    pages: [
      {
        path: "overview.md",
        purpose: `Explain ${title} purpose, sources, and where to continue.`,
      },
      ...(revised
        ? [
            {
              path: "concepts.md",
              purpose: "Key concepts requested via plan revision feedback.",
            },
          ]
        : []),
    ],
    ...(notes ? { notes } : {}),
  };
}

/**
 * Parse a model Markdown plan into structured WikiRunPlan pages.
 * Accepts common list forms:
 * - `path.md` — purpose
 * - path.md: purpose
 * - path.md - purpose
 * Falls back to prior plan pages or a single overview page.
 */
export function parsePlanFromAgentText(
  text: string,
  options: {
    workspaceName: string;
    prior?: WikiRunPlan;
  },
): WikiRunPlan {
  const raw = text?.trim() ?? "";
  const pages: Array<{ path: string; purpose: string }> = [];
  const seen = new Set<string>();

  // Prefer fenced JSON { summary, pages: [{path,purpose}] } when present.
  const jsonFence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (jsonFence?.[1]) {
    try {
      const parsed = JSON.parse(jsonFence[1]!) as {
        summary?: unknown;
        pages?: unknown;
        notes?: unknown;
      };
      if (Array.isArray(parsed.pages)) {
        for (const item of parsed.pages) {
          if (!item || typeof item !== "object") {
            continue;
          }
          const pathVal = String(
            (item as { path?: unknown }).path ?? "",
          ).trim();
          const purposeVal = String(
            (item as { purpose?: unknown }).purpose ?? "",
          ).trim();
          if (!pathVal || !purposeVal || seen.has(pathVal)) {
            continue;
          }
          seen.add(pathVal);
          pages.push({
            path: pathVal.slice(0, 200),
            purpose: purposeVal.slice(0, 500),
          });
        }
      }
      if (pages.length > 0) {
        const summary =
          (typeof parsed.summary === "string" && parsed.summary.trim()) ||
          raw.split("\n").find((l) => l.trim() && !l.trim().startsWith("```"))?.trim() ||
          `Proposed wiki plan for ${options.workspaceName}`;
        return {
          summary: summary.slice(0, 1500),
          pages,
          ...(options.prior?.notes
            ? { notes: options.prior.notes }
            : typeof parsed.notes === "string" && parsed.notes.trim()
              ? { notes: parsed.notes.trim().slice(0, 4000) }
              : {}),
        };
      }
    } catch {
      // fall through to list parsing
    }
  }

  const lineRe =
    /^[\s>*-]*\**`?([A-Za-z0-9_./-]+\.md)`?\**\s*[-—:–]\s+(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(raw)) !== null) {
    const pathVal = match[1]!.trim();
    const purposeVal = match[2]!.replace(/\*\*/g, "").trim();
    if (!pathVal || !purposeVal || seen.has(pathVal)) {
      continue;
    }
    seen.add(pathVal);
    pages.push({
      path: pathVal.slice(0, 200),
      purpose: purposeVal.slice(0, 500),
    });
  }

  // Summary: first non-empty non-list line, or first heading body.
  let summary = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("```") || t.startsWith("#")) {
      if (t.startsWith("#")) {
        const heading = t.replace(/^#+\s*/, "").trim();
        if (heading && !summary) {
          summary = heading;
        }
      }
      continue;
    }
    if (/^[-*+]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
      continue;
    }
    summary = t;
    break;
  }
  if (!summary) {
    summary =
      options.prior?.summary ||
      `Proposed wiki plan for ${options.workspaceName}`;
  }

  const resolvedPages =
    pages.length > 0
      ? pages
      : options.prior?.pages?.length
        ? options.prior.pages
        : [
            {
              path: "overview.md",
              purpose: "Repository purpose, audience, and navigation",
            },
          ];

  return {
    summary: summary.slice(0, 1500),
    pages: resolvedPages,
    ...(options.prior?.notes ? { notes: options.prior.notes } : {}),
  };
}

/**
 * Emit Mastra-shaped stream chunks for fixture mode so Session e2e can assert
 * tool + text parts without a live model (same seam as live fullStream).
 * Write phase also emits data-plan-progress via writer.custom (Phase 2).
 */
async function emitFixtureTrajectory(
  writer: WikiRunStreamWriter | undefined,
  phase: WikiRunAgentPhase,
  abortSignal?: AbortSignal,
  options?: {
    plan?: WikiRunPlan;
    runId?: string;
    writePath?: string;
  },
): Promise<void> {
  if (!writer) {
    return;
  }
  const textId = `fixture-text-${phase}`;
  const toolCallId = `fixture-tool-${phase}`;
  const toolName = phase === "plan" ? "list_source" : "write_wiki";
  const writePath = options?.writePath ?? "overview.md";
  const chunks: unknown[] = [
    { type: "text-start", payload: { id: textId } },
    {
      type: "text-delta",
      payload: {
        id: textId,
        text:
          phase === "plan"
            ? "Inspecting sources and drafting a wiki plan…"
            : "Writing staged wiki pages…",
      },
    },
    { type: "text-end", payload: { id: textId } },
    {
      type: "tool-call",
      payload: {
        toolCallId,
        toolName,
        args:
          phase === "plan"
            ? { sourceId: "fixture", path: "." }
            : { path: writePath },
      },
    },
    {
      type: "tool-result",
      payload: {
        toolCallId,
        toolName,
        args:
          phase === "plan"
            ? { sourceId: "fixture", path: "." }
            : { path: writePath },
        result:
          phase === "plan"
            ? {
                sourceId: "fixture",
                entries: [
                  { name: "README.md", path: "README.md", type: "file" },
                  { name: "src", path: "src", type: "directory" },
                ],
              }
            : { path: writePath, bytes: 128 },
      },
    },
  ];
  for (const chunk of chunks) {
    throwIfAborted(abortSignal);
    await writer.write(chunk);
  }
  if (phase === "write" && options?.runId) {
    await emitPlanProgressFromWriter(writer, {
      plan: options.plan,
      writtenPaths: [writePath],
      runId: options.runId,
      phase: "writing",
    });
  }
}

async function runFixture(input: WikiRunAgentInput, wikiRoot: string): Promise<WikiRunAgentResult> {
  throwIfAborted(input.abortSignal);

  // Optional delay so cancel can win a race in tests (OKF_WIKI_FIXTURE_DELAY_MS).
  const delayRaw = process.env.OKF_WIKI_FIXTURE_DELAY_MS;
  const delayMs = delayRaw ? Number(delayRaw) : 0;
  if (Number.isFinite(delayMs) && delayMs > 0) {
    // Check abort in small slices so cancel is responsive.
    const slice = Math.min(50, delayMs);
    let waited = 0;
    while (waited < delayMs) {
      throwIfAborted(input.abortSignal);
      const step = Math.min(slice, delayMs - waited);
      await sleep(step, input.abortSignal);
      waited += step;
    }
  }

  throwIfAborted(input.abortSignal);

  const phase: WikiRunAgentPhase = input.phase ?? "write";
  const pagePath = input.plan?.pages[0]?.path ?? "overview.md";
  await emitFixtureTrajectory(input.writer, phase, input.abortSignal, {
    plan: input.plan,
    runId: input.runId,
    writePath: pagePath,
  });

  if (phase === "plan") {
    const plan = buildFixturePlan(input);
    return {
      status: "awaiting_plan",
      plan,
      summary: "Awaiting operator plan confirmation",
    };
  }

  const sourceIds = input.workspace.sources.map((s) => s.id).join(", ");
  const title = input.workspace.name || "Repository overview";
  const planNote = input.plan
    ? `\n\nConfirmed plan: ${input.plan.summary}\n`
    : "";
  // Ground fixture pages with a resolvable Source Citation (ADR 0008 / Phase 6).
  // Prefer README.md under the first source when present; path is repo-relative.
  const primarySource = input.workspace.sources[0];
  const citationTarget = primarySource
    ? input.workspace.sources.length > 1
      ? `${primarySource.id}/README.md`
      : "README.md"
    : "README.md";
  const content = [
    "---",
    `title: ${JSON.stringify(title)}`,
    "---",
    "",
    `# ${title}`,
    "",
    "This page was produced in **fixture mode** (no LLM call).",
    "",
    `- Workspace: \`${input.workspace.id}\``,
    `- Sources: ${sourceIds || "(none)"}`,
    `- Run: \`${input.runId}\``,
    planNote,
    `Source-grounded note: the repository root README is the fixture anchor ([Source](repo:${citationTarget}#L1-L1)).`,
    "",
    "Replace fixture mode with a live model by setting `OPENAI_API_KEY` and/or",
    "`OPENAI_BASE_URL`, or force live with `OKF_WIKI_AGENT_MODE=live`.",
    "",
  ].join("\n");

  await writeFileContained(wikiRoot, pagePath, content);
  throwIfAborted(input.abortSignal);
  const pages = await listMarkdownPages(wikiRoot);
  // Final checklist after disk write (all staged pages visible).
  await emitPlanProgressFromWriter(input.writer, {
    plan: input.plan,
    writtenPaths: pages,
    runId: input.runId,
    phase: "writing",
  });
  return {
    status: successStatus(input.autoApprove),
    pages,
    summary: "Fixture Wiki Run wrote overview.md",
    plan: input.plan,
  };
}

function wikiLanguageInstruction(workspace: WorkspaceConfig): string {
  const lang = workspace.wikiLanguage ?? "en";
  if (lang === "zh") {
    return [
      "## Output language",
      "Write all Wiki page content in Simplified Chinese (简体中文).",
      "Frontmatter `title` values and body prose must be Chinese.",
      "Keep Source Citations, file paths, code identifiers, and relative `.md` links unchanged (do not translate paths).",
    ].join("\n");
  }
  return [
    "## Output language",
    "Write all Wiki page content in English.",
    "Frontmatter `title` values and body prose must be English.",
    "Keep Source Citations, file paths, code identifiers, and relative `.md` links unchanged.",
  ].join("\n");
}

function formatEffectiveIgnoresSection(workspace: WorkspaceConfig): string {
  if (workspace.sources.length === 0) {
    return "## Effective Source Ignores\n(no sources)";
  }
  const blocks = workspace.sources.map((s) => {
    const ignores = effectiveIgnoresForSource(s);
    const flag =
      s.applyDefaultIgnores === false
        ? "applyDefaultIgnores=false (user patterns only)"
        : "applyDefaultIgnores=true (defaults + user)";
    const list =
      ignores.length === 0
        ? "  (none)"
        : ignores.map((p) => `  - ${p}`).join("\n");
    return [`### source \`${s.id}\` (${flag})`, list].join("\n");
  });
  return [
    "## Effective Source Ignores (host-enforced)",
    "These patterns are applied by the Run Boundary on every list_source and read_source call.",
    "Ignored paths are omitted from listings and cannot be read. Do not invent a second exclusion policy.",
    "Do not use shell, raw filesystem APIs, or CodeMode to bypass these filters.",
    ...blocks,
  ].join("\n");
}

function buildInstructions(workspace: WorkspaceConfig): string {
  const sourceList = workspace.sources
    .map((s) => `- ${s.id}: ${s.path}`)
    .join("\n");
  return [
    "You are the OKF Wiki Root Agent for a single Wiki Run.",
    "Follow the producer skill strictly.",
    "",
    "## Run instructions",
    "1. Activate/load the Producer Skill (Mastra skill tools and/or read_skill). Start with SKILL.md, then references/templates as needed.",
    "2. Explore sources with list_source / read_source only (read-only, multi-root by sourceId).",
    "   Source paths may live outside the workspace root; never assume sources are under cwd.",
    "   Effective Source Ignores are host-enforced on those tools (see section below).",
    "3. Write final Markdown pages under the wiki staging area with write_wiki.",
    "4. Every page MUST start with YAML frontmatter containing a non-empty `title`.",
    "5. Prefer a small coherent page set (e.g. overview.md plus architecture/module as needed).",
    "6. When finished, reply with a short plain-text summary listing the wiki-relative page paths you wrote.",
    "",
    wikiLanguageInstruction(workspace),
    "",
    formatEffectiveIgnoresSection(workspace),
    "",
    "Do not use shell/git clone/fetch. Use only the provided tools.",
    "Do not invent source citations without reading the cited files.",
    "Do not cite or describe paths that list_source never returned or that read_source rejected as ignored.",
    "",
    `Workspace root (agent cwd): ${workspace.rootPath}`,
    `Workspace: ${workspace.name} (${workspace.id})`,
    `Wiki language: ${workspace.wikiLanguage ?? "en"}`,
    "Sources:",
    sourceList || "- (none)",
  ].join("\n");
}

/**
 * Resolve Mastra model config from workspace model selection + Settings catalog.
 * Supports OpenAI-compatible chat completions and the Responses API shape.
 */
export async function resolveModelConfig(
  workspace: WorkspaceConfig,
): Promise<MastraModelConfig> {
  const provider = await loadProviderConfig();
  const runtime = resolveProviderRuntime(provider, {
    profileId: workspace.model?.profileId,
    modelId: workspace.model?.id,
  });

  const rawId =
    runtime.modelId?.trim() ||
    workspace.model?.id?.trim() ||
    process.env.OKF_WIKI_MODEL_ID?.trim() ||
    "openai/default";
  // Mastra OpenAICompatibleConfig requires provider/model form.
  const id = (rawId.includes("/") ? rawId : `openai/${rawId}`) as `${string}/${string}`;
  const modelIdOnly = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;

  if (runtime.apiShape === "responses") {
    // Official / compatible Responses API via AI SDK OpenAI provider.
    const openai = createOpenAI({
      apiKey: runtime.apiKey,
      ...(runtime.baseUrl ? { baseURL: runtime.baseUrl } : {}),
    });
    return openai.responses(modelIdOnly);
  }

  // Default: OpenAI-compatible chat completions (…/v1/chat/completions).
  return {
    id,
    url: runtime.baseUrl,
    apiKey: runtime.apiKey,
  };
}

async function runLive(input: WikiRunAgentInput, wikiRoot: string, skillRoot: string): Promise<WikiRunAgentResult> {
  const sources = buildSourceMap(input.workspace);
  // Freeze Effective Source Ignores at run start (defaults + per-source user ignore).
  // list_source / read_source enforce this map for the whole Wiki generation loop.
  const sourceIgnores = buildSourceIgnoreMap(input.workspace.sources);
  // Discrete path-policy tools always registered; CodeMode only orchestrates them
  // via host-side RPC (validation/tracing/path containment stay on the host).
  const tools = createWikiRunTools({
    sources,
    sourceIgnores,
    skillRoot,
    wikiRoot,
  });

  // Mastra Workspace: product workspace root as agent cwd + Producer Skill discovery.
  // Sources stay multi-root via product tools (may live outside rootPath).
  // No unrestricted shell for clone/fetch — CodeMode sandbox has no free shell tools.
  const mastraWorkspace = new Workspace({
    id: `okf-wiki-run-${input.runId}`,
    name: input.workspace.name,
    filesystem: new LocalFilesystem({
      basePath: input.workspace.rootPath,
    }),
    skills: [skillRoot],
  });
  await mastraWorkspace.init();

  // Optional Mastra Code Mode (live only): orchestration TS runs in LocalSandbox;
  // external_* calls still hit the same contained tools above.
  const { tool: execute_typescript, instructions: codeModeInstructions } = createCodeMode({
    tools,
    sandbox: new LocalSandbox({
      isolation: "none",
      workingDirectory: input.workspace.rootPath,
    }),
  });

  const model = await resolveModelConfig(input.workspace);
  const subagents = createSubagents({
    model,
    tools,
    adaptive: Boolean(input.workspace.adaptive),
    reviewer: Boolean(input.workspace.reviewer),
  });
  const childAgents = subagentsAsAgentsMap(subagents);

  const adaptiveHint = input.workspace.adaptive
    ? `\nAdaptive mode: you may delegate domainResearcher / leafResearcher for large scopes; reduce their receipts yourself. You alone write wiki pages.\n${adaptiveLimitsInstruction()}`
    : "";

  const agent = new Agent({
    id: "okf-wiki-root",
    name: "OKF Wiki Root",
    instructions: [
      buildInstructions(input.workspace) + adaptiveHint,
      codeModeInstructions,
    ],
    model,
    workspace: mastraWorkspace,
    ...(Object.keys(childAgents).length > 0 ? { agents: childAgents } : {}),
    tools: {
      ...tools,
      execute_typescript,
    },
  });

  throwIfAborted(input.abortSignal);

  const maxSteps = input.workspace.limits?.maxSteps ?? 24;
  const phase: WikiRunAgentPhase = input.phase ?? "write";
  const planHint = input.plan
    ? `\nConfirmed page plan (follow it):\n${JSON.stringify(input.plan, null, 2)}\n`
    : "";
  const revisionHint =
    phase === "plan" && input.plan?.notes
      ? `\nOperator revision notes (must incorporate):\n${input.plan.notes}\n` +
        (input.plan.pages?.length
          ? `Previous proposed pages:\n${JSON.stringify(input.plan.pages, null, 2)}\n`
          : "")
      : "";
  const userMessage =
    phase === "plan"
      ? "Plan a source-grounded Wiki for this workspace. " +
        "Load the producer skill, briefly inspect sources, then reply with a short summary and a Markdown bullet list of " +
        "intended pages using exactly: `- \\`path.md\\` — purpose` (one page per line). " +
        "Do NOT call write_wiki yet." +
        revisionHint
      : "Produce a source-grounded Wiki for this workspace. " +
        "Load the producer skill first, inspect sources, write markdown pages with write_wiki, then summarize." +
        planHint;

  // Stream so tool side-effects run; forward fullStream to workflow writer for Session UI.
  // On write phase, emit data-plan-progress via writer.custom after each write_wiki.
  let text: string;
  const writtenPaths = new Set<string>();
  try {
    const stream = await agent.stream(
      [{ role: "user", content: userMessage }],
      {
        maxSteps,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      },
    );

    const fullStream = stream.fullStream;
    if (fullStream && typeof fullStream[Symbol.asyncIterator] === "function") {
      for await (const chunk of fullStream) {
        throwIfAborted(input.abortSignal);
        if (input.writer) {
          await input.writer.write(chunk);
        }
        if (phase === "write") {
          const path = writePathFromAgentChunk(chunk);
          if (path && !writtenPaths.has(path)) {
            writtenPaths.add(path);
            await emitPlanProgressFromWriter(input.writer, {
              plan: input.plan,
              writtenPaths,
              runId: input.runId,
              phase: "writing",
            });
          }
        }
      }
    } else if (
      stream.textStream &&
      typeof stream.textStream[Symbol.asyncIterator] === "function"
    ) {
      const textId = `agent-text-${input.runId}`;
      if (input.writer) {
        await input.writer.write({ type: "text-start", payload: { id: textId } });
      }
      for await (const delta of stream.textStream) {
        throwIfAborted(input.abortSignal);
        if (input.writer && typeof delta === "string" && delta) {
          await input.writer.write({
            type: "text-delta",
            payload: { id: textId, text: delta },
          });
        }
      }
      if (input.writer) {
        await input.writer.write({ type: "text-end", payload: { id: textId } });
      }
    }

    text = (await stream.text) ?? "";
    if (stream.error) {
      throw stream.error;
    }
  } catch (streamError) {
    if (isAbortError(streamError) || input.abortSignal?.aborted) {
      throw streamError;
    }
    const result = await agent.generate(
      [{ role: "user", content: userMessage }],
      {
        maxSteps,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      },
    );
    if (result.error) {
      throw result.error;
    }
    text = result.text ?? "";
  }

  throwIfAborted(input.abortSignal);

  if (phase === "plan") {
    const plan = parsePlanFromAgentText(text ?? "", {
      workspaceName: input.workspace.name,
      prior: input.plan,
    });
    return {
      status: "awaiting_plan",
      plan,
      summary: "Awaiting operator plan confirmation",
    };
  }

  const pages = await listMarkdownPages(wikiRoot);
  // Final progress from disk inventory (covers generate-fallback path too).
  for (const p of pages) {
    writtenPaths.add(normalizeWikiPath(p));
  }
  await emitPlanProgressFromWriter(input.writer, {
    plan: input.plan,
    writtenPaths,
    runId: input.runId,
    phase: "writing",
  });
  if (pages.length === 0) {
    return {
      status: "failed",
      error: "agent finished without writing any wiki pages",
      summary: text?.slice(0, 400) || undefined,
    };
  }

  // Optional independent reviewer pass (read-only); Root remains responsible for repairs.
  if (input.workspace.reviewer && subagents.reviewer && phase === "write") {
    try {
      const review = await subagents.reviewer.generate(
        [
          {
            role: "user",
            content:
              `Review staged wiki pages: ${pages.join(", ")}. ` +
              "List defects only (severity, issue, path). If clean, say NO_DEFECTS.",
          },
        ],
        {
          maxSteps: subagents.reviewerMaxSteps,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        },
      );
      const reviewText = (review.text ?? "").slice(0, 2000);
      const clean = /NO_DEFECTS/i.test(reviewText);
      try {
        await writeAnalysisReceipt(input.workspace.rootPath, {
          version: 1,
          runId: input.runId,
          nodeId: "reviewer",
          parentId: "root",
          attempt: 1,
          status: "complete",
          scope: `staged pages: ${pages.join(", ")}`,
          summary: clean ? "NO_DEFECTS" : reviewText.slice(0, 500),
          findings: clean
            ? ["NO_DEFECTS"]
            : reviewText
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
                .slice(0, 40),
          evidence: [],
          childReceipts: [],
          openQuestions: [],
        });
      } catch {
        // Receipt persistence is best-effort; do not fail the run.
      }
    } catch (reviewError) {
      if (isAbortError(reviewError) || input.abortSignal?.aborted) {
        throw reviewError;
      }
    }
  }

  return {
    status: successStatus(input.autoApprove),
    pages,
    summary: (text?.trim() || `Wrote ${pages.length} page(s)`).slice(0, 1000),
    plan: input.plan,
  };
}

/**
 * Execute a Wiki Run against workspace sources and staging.
 * Does not persist the StoredRunRecord — the server registry owns that.
 */
export async function runWikiAgent(input: WikiRunAgentInput): Promise<WikiRunAgentResult> {
  if (!input.workspace.sources || input.workspace.sources.length === 0) {
    return {
      status: "failed",
      error: "workspace must have at least one source",
    };
  }

  const wikiRoot = stagingDirForRun(input.workspace.rootPath, input.runId);
  await mkdir(wikiRoot, { recursive: true });

  try {
    throwIfAborted(input.abortSignal);

    if (await shouldUseFixtureMode()) {
      return await runFixture(input, wikiRoot);
    }

    const skillRoot = await resolveSkillPath({
      skillPath: input.workspace.skillPath,
      workspaceRoot: input.workspace.rootPath,
    });
    return await runLive(input, wikiRoot, skillRoot);
  } catch (error) {
    if (isAbortError(error) || input.abortSignal?.aborted) {
      return {
        status: "cancelled",
        error: "cancelled",
        summary: "Wiki Run cancelled",
      };
    }
    return {
      status: "failed",
      error: redactErrorMessage(error),
    };
  }
}
