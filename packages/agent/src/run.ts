import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import {
  WikiRunSpecSchema,
  defaultWikiRunSpec,
  type WikiRunPlan,
  type WikiRunRecordStatus,
  type WikiRunSpec,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import {
  WORKSPACE_DIR_NAME,
  analysisScratchDir,
  buildSourceIgnoreMap,
  effectiveIgnoresForSource,
  hasProviderCredentials,
  loadProviderConfig,
  resolveProviderRuntime,
  validateWikiTree,
} from "@okf-wiki/core";
import {
  buildContextInputProcessors,
  resolveContextTargetForWorkspace,
} from "./context-limits.js";
import {
  orchestrationLimitsInstruction,
  resolveOrchestration,
} from "./limits.js";
import {
  buildRootDelegationOptions,
  createDelegationCounters,
} from "./delegation.js";
import {
  evaluateWikiPublishable,
  hasBlockingDefects,
  writeMergedDefects,
} from "./defects.js";
import { runReviewCouncil } from "./review-council.js";
import { resolveRoleModels } from "./role-models.js";
import { writeWikiRunSpec } from "./spec-store.js";
import { listMarkdownPages, writeFileContained } from "./fs-ops.js";
import { resolveSkillPath } from "./skill-path.js";
import { createSubagents, subagentsAsAgentsMap } from "./subagents.js";
import { createWikiRunTools } from "./tools.js";
import { buildPlanProgressData } from "./ui-projection.js";
import { redactErrorMessage } from "./run-redact.js";
import {
  createWikiRunMemory,
  wikiRunMemoryOption,
} from "./wiki-memory.js";
import type { MergedDefectReport } from "@okf-wiki/contract";

/** Default repair rounds when Spec.acceptance.maxRepairRounds is unset. */
const DEFAULT_ORCHESTRATION_REPAIR_ROUNDS = 2;

/** Emit review council summary to Session timeline. */
async function emitDefectsFromWriter(
  writer: WikiRunStreamWriter | undefined,
  input: {
    runId: string;
    round: number;
    merged: MergedDefectReport;
  },
): Promise<void> {
  await writeCustomDataPart(writer, {
    type: "data-defects",
    data: {
      runId: input.runId,
      round: input.round,
      clean: input.merged.clean,
      defectCount: input.merged.defects.length,
      blockingCount: input.merged.defects.filter(
        (d) => d.severity === "blocking",
      ).length,
      majorCount: input.merged.defects.filter((d) => d.severity === "major")
        .length,
      reviewerIds: input.merged.reviewerIds,
      summary: input.merged.summary,
      defects: input.merged.defects.slice(0, 12).map((d) => ({
        severity: d.severity,
        code: d.code,
        path: d.path,
        issue: d.issue.slice(0, 280),
      })),
    },
    id: `defects-${input.runId}-r${input.round}`,
  });
}

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

/** Best-effort tool name from a Mastra agent fullStream chunk. */
function toolNameFromAgentChunk(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") {
    return undefined;
  }
  const c = chunk as {
    type?: string;
    payload?: { toolName?: string; name?: string };
  };
  const type = c.type ?? "";
  if (
    !type.includes("tool") &&
    type !== "tool-call" &&
    type !== "tool-result" &&
    type !== "tool-call-result"
  ) {
    return undefined;
  }
  const name = c.payload?.toolName ?? c.payload?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
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

function buildFixturePlan(input: WikiRunAgentInput): WikiRunSpec {
  const title = input.workspace.name || "Repository overview";
  const notes = input.plan?.notes?.trim();
  const revised = Boolean(notes && /operator revision feedback/i.test(notes));
  return WikiRunSpecSchema.parse({
    summary: revised
      ? `Revised fixture plan for ${title} after operator feedback.`
      : `Fixture plan for ${title}: one overview page grounded in registered sources.`,
    audience: "Engineers and operators reading this repository",
    domains: [
      {
        id: "core",
        title: "Core",
        scope: "Registered sources and primary modules",
        critical: true,
        questions: [`What is ${title}?`],
      },
    ],
    pages: [
      {
        path: "overview.md",
        purpose: `Explain ${title} purpose, sources, and where to continue.`,
        domainIds: ["core"],
        questions: [`What is ${title}?`],
        template: "overview",
        critical: true,
      },
      ...(revised
        ? [
            {
              path: "concepts.md",
              purpose: "Key concepts requested via plan revision feedback.",
              domainIds: ["core"],
              questions: ["What domain terms matter?"],
              template: "concept" as const,
              critical: false,
            },
          ]
        : []),
    ],
    openQuestions: [],
    acceptance: {
      reviewRequired: true,
      maxRepairRounds: 2,
      blockingSeverities: ["blocking"],
    },
    changelog: revised ? ["Operator revision applied in fixture plan"] : [],
    ...(notes ? { notes } : {}),
  });
}

/**
 * Parse a model plan into a WikiRunSpec.
 * Accepts fenced JSON Spec/plan shapes or Markdown page lists.
 * Falls back to prior Spec pages or defaultWikiRunSpec.
 */
export function parsePlanFromAgentText(
  text: string,
  options: {
    workspaceName: string;
    prior?: WikiRunSpec;
  },
): WikiRunSpec {
  const raw = text?.trim() ?? "";
  const pages: Array<{ path: string; purpose: string }> = [];
  const seen = new Set<string>();

  // Prefer fenced JSON Spec (or legacy { summary, pages }) when present.
  const jsonFence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (jsonFence?.[1]) {
    try {
      const parsed = JSON.parse(jsonFence[1]!) as Record<string, unknown>;
      const asSpec = WikiRunSpecSchema.safeParse({
        ...parsed,
        ...(options.prior?.notes && !parsed.notes
          ? { notes: options.prior.notes }
          : {}),
      });
      if (asSpec.success && asSpec.data.pages.length > 0) {
        return asSpec.data;
      }
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
          raw
            .split("\n")
            .find((l) => l.trim() && !l.trim().startsWith("```"))
            ?.trim() ||
          `Proposed wiki plan for ${options.workspaceName}`;
        return WikiRunSpecSchema.parse({
          summary: summary.slice(0, 1500),
          pages: pages.map((p) => ({
            ...p,
            domainIds: ["core"],
            questions: [p.purpose],
            critical: true,
          })),
          domains: [
            {
              id: "core",
              title: "Core",
              scope: "Primary repository scope",
              critical: true,
              questions: pages.map((p) => p.purpose).slice(0, 8),
            },
          ],
          ...(options.prior?.notes
            ? { notes: options.prior.notes }
            : typeof parsed.notes === "string" && parsed.notes.trim()
              ? { notes: parsed.notes.trim().slice(0, 4000) }
              : {}),
        });
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

  if (pages.length === 0 && options.prior?.pages?.length) {
    return WikiRunSpecSchema.parse({
      ...options.prior,
      summary: summary.slice(0, 1500),
      ...(options.prior.notes ? { notes: options.prior.notes } : {}),
    });
  }

  if (pages.length === 0) {
    return defaultWikiRunSpec(options.workspaceName);
  }

  return WikiRunSpecSchema.parse({
    summary: summary.slice(0, 1500),
    pages: pages.map((p) => ({
      ...p,
      domainIds: ["core"],
      questions: [p.purpose],
      critical: true,
    })),
    domains: [
      {
        id: "core",
        title: "Core",
        scope: "Primary repository scope",
        critical: true,
        questions: pages.map((p) => p.purpose).slice(0, 8),
      },
    ],
    ...(options.prior?.notes ? { notes: options.prior.notes } : {}),
  });
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
  // Extra planned pages in fixture mode (simple copies with distinct titles).
  if (input.plan?.pages && input.plan.pages.length > 1) {
    for (const page of input.plan.pages.slice(1)) {
      const extra = content.replace(
        `title: ${JSON.stringify(title)}`,
        `title: ${JSON.stringify(page.purpose.slice(0, 80))}`,
      );
      await writeFileContained(wikiRoot, page.path, extra);
    }
  }
  throwIfAborted(input.abortSignal);
  const pages = await listMarkdownPages(wikiRoot);
  // Final checklist after disk write (all staged pages visible).
  await emitPlanProgressFromWriter(input.writer, {
    plan: input.plan,
    writtenPaths: pages,
    runId: input.runId,
    phase: "writing",
  });
  // Clean review receipt so Host publishability scorer can pass in fixture mode.
  try {
    const plan = input.plan ?? buildFixturePlan(input);
    await writeWikiRunSpec(input.workspace.rootPath, input.runId, plan);
    const cleanReport = {
      version: 1 as const,
      clean: true,
      defects: [] as [],
      reviewerIds: ["fixture"],
      summary: "NO_DEFECTS",
    };
    await writeMergedDefects(input.workspace.rootPath, input.runId, cleanReport);
    await emitDefectsFromWriter(input.writer, {
      runId: input.runId,
      round: 1,
      merged: cleanReport,
    });
  } catch {
    // best-effort
  }
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
    "These patterns are applied by the Run Boundary on every list_source, read_source, glob_source, and search_source call.",
    "Ignored paths are omitted from listings and cannot be read. Do not invent a second exclusion policy.",
    "Do not use shell or raw filesystem APIs to bypass these filters.",
    ...blocks,
  ].join("\n");
}

/** Default tool-step budget for plan phase (overridden by orchestration.planMaxSteps). */
export const DEFAULT_PLAN_MAX_STEPS = 24;
/** Base tool-step budget for write/produce phase (before plan page scaling). */
export const DEFAULT_WRITE_MAX_STEPS_BASE = 48;
/** Extra write steps per planned page. */
export const WRITE_MAX_STEPS_PER_PLAN_PAGE = 6;
/** Hard ceiling for write maxSteps. */
export const WRITE_MAX_STEPS_CAP = 120;

/** Resolve host-enforced maxSteps for a Wiki Run phase. */
export function resolvePhaseMaxSteps(
  workspace: WorkspaceConfig,
  phase: WikiRunAgentPhase,
  plan?: WikiRunPlan,
): number {
  if (workspace.limits?.maxSteps && workspace.limits.maxSteps > 0) {
    return workspace.limits.maxSteps;
  }
  const orch = resolveOrchestration(workspace);
  if (phase === "plan") {
    return orch.planMaxSteps || DEFAULT_PLAN_MAX_STEPS;
  }
  const pageCount = plan?.pages?.length ?? 0;
  return Math.min(
    Math.max(orch.rootMaxSteps, WRITE_MAX_STEPS_CAP),
    DEFAULT_WRITE_MAX_STEPS_BASE + pageCount * WRITE_MAX_STEPS_PER_PLAN_PAGE,
  );
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
    "2. Explore sources with list_source, glob_source, search_source, and read_source (read-only, multi-root by sourceId).",
    "   - glob_source: find files by name pattern (e.g. **/*Listener.java)",
    "   - search_source: content regex; results include true 1-based line numbers",
    "   - read_source: returns numbered lines `N| text` plus lineCount — cite only within lineCount",
    "   Source paths may live outside the workspace root; never assume sources are under cwd.",
    "   Effective Source Ignores are host-enforced on those tools (see section below).",
    "3. Write final Markdown pages under the wiki staging area with write_wiki.",
    "   Prefer writing planned pages as soon as you have enough evidence; do not only explore.",
    "4. Every page MUST start with YAML frontmatter containing a non-empty `title`.",
    "5. Prefer a small coherent page set (e.g. overview.md plus architecture/module as needed).",
    "6. When finished, reply with a short plain-text summary listing the wiki-relative page paths you wrote.",
    "",
    "## Source Citations",
    "- Format: [Source](repo:path#Lstart-Lend) or multi-repo [Source](repo:sourceId/path#Lstart-Lend).",
    "- Line numbers are 1-based inclusive and MUST be ≤ read_source lineCount (or a search_source hit line).",
    "- The `N|` prefix in read_source content is metadata only — never copy it into wiki prose or citations.",
    "- Do not invent or estimate line ranges. Re-read if unsure.",
    "",
    wikiLanguageInstruction(workspace),
    "",
    formatEffectiveIgnoresSection(workspace),
    "",
    "Do not use shell/git clone/fetch. Use only the provided tools.",
    "Do not invent source citations without reading or searching the cited files.",
    "Do not cite or describe paths that tools never returned or that were rejected as ignored.",
    "",
    `Workspace root (agent cwd): ${workspace.rootPath}`,
    `Workspace: ${workspace.name} (${workspace.id})`,
    `Wiki language: ${workspace.wikiLanguage ?? "en"}`,
    "Sources:",
    sourceList || "- (none)",
  ].join("\n");
}

/** Model + optional provider hard window for Wiki Run context compaction. */
export type ResolvedWikiModel = {
  model: MastraModelConfig;
  maxContextTokens?: number;
};

/**
 * Resolve Mastra model config and context window from workspace + Settings catalog.
 * Supports OpenAI-compatible chat completions and the Responses API shape.
 */
export async function resolveWikiModel(
  workspace: WorkspaceConfig,
): Promise<ResolvedWikiModel> {
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

  let model: MastraModelConfig;
  if (runtime.apiShape === "responses") {
    // Official / compatible Responses API via AI SDK OpenAI provider.
    const openai = createOpenAI({
      apiKey: runtime.apiKey,
      ...(runtime.baseUrl ? { baseURL: runtime.baseUrl } : {}),
    });
    model = openai.responses(modelIdOnly);
  } else {
    // Default: OpenAI-compatible chat completions (…/v1/chat/completions).
    model = {
      id,
      url: runtime.baseUrl,
      apiKey: runtime.apiKey,
    };
  }

  return {
    model,
    ...(runtime.maxContextTokens !== undefined
      ? { maxContextTokens: runtime.maxContextTokens }
      : {}),
  };
}

/**
 * Resolve Mastra model config from workspace model selection + Settings catalog.
 * Supports OpenAI-compatible chat completions and the Responses API shape.
 */
export async function resolveModelConfig(
  workspace: WorkspaceConfig,
): Promise<MastraModelConfig> {
  return (await resolveWikiModel(workspace)).model;
}

async function runLive(input: WikiRunAgentInput, wikiRoot: string, skillRoot: string): Promise<WikiRunAgentResult> {
  const sources = buildSourceMap(input.workspace);
  // Freeze Effective Source Ignores at run start (defaults + per-source user ignore).
  // Source tools enforce this map for the whole Wiki generation loop.
  const sourceIgnores = buildSourceIgnoreMap(input.workspace.sources);
  const analysisRoot = analysisScratchDir(
    input.workspace.rootPath,
    input.runId,
  );
  // Discrete path-policy tools only (no CodeMode / no shell).
  const tools = createWikiRunTools({
    sources,
    sourceIgnores,
    skillRoot,
    wikiRoot,
    analysisRoot,
  });

  // Mastra Workspace: product workspace root as agent cwd + Producer Skill discovery.
  // Sources stay multi-root via product tools (may live outside rootPath).
  // No sandbox/shell — ADR 0002 untrusted snapshot as data.
  const mastraWorkspace = new Workspace({
    id: `okf-wiki-run-${input.runId}`,
    name: input.workspace.name,
    filesystem: new LocalFilesystem({
      basePath: input.workspace.rootPath,
    }),
    skills: [skillRoot],
  });
  await mastraWorkspace.init();

  const roles = await resolveRoleModels(input.workspace);
  const model = roles.planner;
  const maxContextTokens = roles.plannerMaxContextTokens;
  const contextTarget = resolveContextTargetForWorkspace(
    input.workspace,
    maxContextTokens,
  );
  const contextProcessors =
    contextTarget !== undefined
      ? buildContextInputProcessors(contextTarget)
      : [];
  // Semantic compaction (OM) when budget known; hard TokenLimiter still on all agents.
  const runMemory =
    contextTarget !== undefined
      ? createWikiRunMemory({ model, contextTargetTokens: contextTarget })
      : undefined;

  const orch = resolveOrchestration(input.workspace);
  // Pad reviewer models to council size (same model + decorrelated prompts when only one).
  const councilSize = Math.max(1, Math.min(orch.reviewCouncilSize, 4));
  const baseReviewers =
    roles.reviewers.length > 0 ? roles.reviewers : [roles.planner];
  const paddedReviewers = Array.from(
    { length: councilSize },
    (_, i) => baseReviewers[i % baseReviewers.length]!,
  );
  const subagents = createSubagents({
    model: roles.planner,
    workerModel: roles.worker,
    reviewerModels: paddedReviewers,
    tools,
    orchestration: orch,
    inputProcessors: contextProcessors,
    // Domain/Leaf: TokenLimiter only (short scopes). Reviewer gets OM via explicit generate.
    memory: runMemory,
  });
  const childAgents = subagentsAsAgentsMap(subagents);
  const delegationCounters = createDelegationCounters();
  const delegation = buildRootDelegationOptions({
    orchestration: orch,
    counters: delegationCounters,
  });

  // Persist initial Spec when produce starts with a confirmed plan.
  if (input.phase !== "plan" && input.plan) {
    try {
      await writeWikiRunSpec(
        input.workspace.rootPath,
        input.runId,
        input.plan,
      );
    } catch {
      // best-effort
    }
  }

  const supervisorHint =
    `\nSupervisor tree: always available. Delegate domainResearcher / leafResearcher for large or independent scopes; reduce their receipts yourself. You alone write wiki pages.\n` +
    `${orchestrationLimitsInstruction(orch)}\n` +
    "Maintain a living Spec via read_spec/write_spec (domains, pages, questions, changelog). Replan when discovery demands it.\n" +
    "Before finishing produce: ensure critical pages exist with Source Citations. Host will run an independent review council.";
  const contextHint =
    contextTarget !== undefined
      ? `\nContext budget: operational target ${contextTarget} tokens` +
        (maxContextTokens !== undefined
          ? ` (model max ${maxContextTokens}).`
          : ".") +
        (runMemory
          ? " Observational Memory summarizes long tool history; TokenLimiter is the hard cap."
          : " Prefer receipts and concise tool use; older tool results may be pruned automatically.")
      : "";

  const agent = new Agent({
    id: "okf-wiki-root",
    name: "OKF Wiki Root",
    instructions:
      buildInstructions(input.workspace) + supervisorHint + contextHint,
    model,
    workspace: mastraWorkspace,
    agents: childAgents,
    ...(contextProcessors.length > 0
      ? { inputProcessors: contextProcessors }
      : {}),
    ...(runMemory ? { memory: runMemory } : {}),
    tools,
  });

  throwIfAborted(input.abortSignal);

  const phase: WikiRunAgentPhase = input.phase ?? "write";
  const maxSteps = resolvePhaseMaxSteps(input.workspace, phase, input.plan);
  const planHint = input.plan
    ? `\nConfirmed WikiRunSpec (follow and replan via write_spec when needed):\n${JSON.stringify(input.plan, null, 2)}\n`
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
        "Load the producer skill, briefly inspect sources (list/glob/search/read), then reply with a short summary and a Markdown bullet list of " +
        "intended pages using exactly: `- \\`path.md\\` — purpose` (one page per line). " +
        "Prefer also a fenced JSON WikiRunSpec with domains and page questions when possible. " +
        "Do NOT call write_wiki yet." +
        revisionHint
      : "Produce a source-grounded Wiki for this workspace. " +
        "Priority order: (1) load skill, (2) brief source inspection, (3) write_wiki for planned pages ASAP, " +
        "(4) only then deepen with domainResearcher/leafResearcher if a page is blocked on evidence. " +
        "Do not spend the whole budget exploring. Prefer writing incomplete-but-grounded pages over zero pages. " +
        "Maintain Spec with read_spec/write_spec when the page set changes. " +
        "Source Citations must use line ranges from tool output (lineCount / search hits), never guesses." +
        planHint;

  // Stream so tool side-effects run; forward fullStream to workflow writer for Session UI.
  // On write phase, emit data-plan-progress via writer.custom after each write_wiki.
  const rootMemoryOpt = runMemory
    ? { memory: wikiRunMemoryOption(input.runId, "root") }
    : {};
  /**
   * Soft write nudge only — never isTaskComplete-score-0 forced loops.
   * isTaskComplete was causing meaningless research thrash when no pages
   * existed yet (score 0 → inject feedback → another iteration forever).
   */
  const writeNudgeState = { lastNudgeAt: 0 };
  const onIterationComplete =
    phase === "write"
      ? async (context: {
          iteration: number;
          text?: string;
          finishReason?: string;
        }) => {
          try {
            const pages = await listMarkdownPages(wikiRoot);
            if (pages.length > 0) {
              return { continue: true as const };
            }
            // Nudge at most every 4 iterations after iteration 3, max 3 nudges.
            const iter = context.iteration ?? 0;
            if (
              iter >= 3 &&
              iter - writeNudgeState.lastNudgeAt >= 4 &&
              writeNudgeState.lastNudgeAt < 12
            ) {
              writeNudgeState.lastNudgeAt = iter;
              return {
                continue: true as const,
                feedback:
                  "Host: still no staged wiki pages. Prefer write_wiki for planned critical pages now; stop endless exploration. Use Source Citations from tools only.",
              };
            }
          } catch {
            // ignore
          }
          return { continue: true as const };
        }
      : undefined;
  let text: string;
  const writtenPaths = new Set<string>();
  const toolNamesSeen: string[] = [];
  try {
    const stream = await agent.stream(
      [{ role: "user", content: userMessage }],
      {
        maxSteps,
        ...rootMemoryOpt,
        // Cast: Mastra DelegationConfig message types are framework-internal.
        delegation: delegation as never,
        ...(onIterationComplete ? { onIterationComplete } : {}),
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
        const toolName = toolNameFromAgentChunk(chunk);
        if (toolName) {
          toolNamesSeen.push(toolName);
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
        ...rootMemoryOpt,
        delegation: delegation as never,
        ...(onIterationComplete ? { onIterationComplete } : {}),
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
    try {
      await writeWikiRunSpec(input.workspace.rootPath, input.runId, plan);
    } catch {
      // best-effort
    }
    return {
      status: "awaiting_plan",
      plan,
      summary: "Awaiting operator plan confirmation",
    };
  }

  let pages = await listMarkdownPages(wikiRoot);
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
    const planPages = input.plan?.pages?.length ?? 0;
    const lastTools = toolNamesSeen.slice(-8).join(", ") || "(none observed)";
    const toolCalls = toolNamesSeen.length;
    return {
      status: "failed",
      error:
        `agent finished without writing any wiki pages ` +
        `(maxSteps=${maxSteps}, toolCalls=${toolCalls}, lastTools=[${lastTools}], ` +
        `planPages=${planPages}, writtenPaths=0)`,
      summary: text?.slice(0, 400) || undefined,
    };
  }

  // Mechanical staging validation before review (citations, frontmatter).
  const validation = await validateWikiTree(wikiRoot, {
    sources: input.workspace.sources.map((s) => ({ id: s.id, path: s.path })),
  });
  if (!validation.ok) {
    const detail = validation.errors.slice(0, 20).join("; ");
    return {
      status: "failed",
      error: `staging failed wiki validation: ${detail}`,
      pages,
      summary: text?.slice(0, 400) || undefined,
      plan: input.plan,
    };
  }

  // Host-owned review council + repair loop (fail-closed).
  const maxRepairRounds =
    input.plan?.acceptance?.maxRepairRounds ??
    DEFAULT_ORCHESTRATION_REPAIR_ROUNDS;
  const blockingSeverities =
    input.plan?.acceptance?.blockingSeverities ?? ["blocking"];
  let reviewRound = 0;
  let reviewClean = false;
  let lastDefectSummary = "";

  while (reviewRound <= maxRepairRounds) {
    reviewRound += 1;
    throwIfAborted(input.abortSignal);
    let merged;
    try {
      merged = await runReviewCouncil({
        reviewers: subagents.reviewers,
        pages,
        maxSteps: subagents.reviewerMaxSteps,
        workspaceRoot: input.workspace.rootPath,
        runId: input.runId,
        abortSignal: input.abortSignal,
        memoryOption: runMemory
          ? {
              thread: input.runId,
              resource: input.workspace.id,
            }
          : undefined,
        round: reviewRound,
      });
    } catch (reviewError) {
      if (isAbortError(reviewError) || input.abortSignal?.aborted) {
        throw reviewError;
      }
      return {
        status: "failed",
        error: `review council failed: ${redactErrorMessage(reviewError)}`,
        pages,
        summary: text?.slice(0, 400) || undefined,
        plan: input.plan,
      };
    }

    lastDefectSummary = merged.summary ?? "";
    reviewClean =
      merged.clean ||
      !hasBlockingDefects(merged, blockingSeverities as ("blocking" | "major" | "minor")[]);

    await emitDefectsFromWriter(input.writer, {
      runId: input.runId,
      round: reviewRound,
      merged,
    });
    await writeCustomDataPart(input.writer, {
      type: "data-progress",
      data: {
        phase: reviewClean ? "review_clean" : "review_defects",
        label: reviewClean
          ? `Review council clean (round ${reviewRound})`
          : `Review council: ${merged.defects.length} defect(s) (round ${reviewRound})`,
        runId: input.runId,
        failed: !reviewClean && reviewRound > maxRepairRounds,
      },
      id: `progress-review-${input.runId}-r${reviewRound}`,
    });

    if (reviewClean) {
      break;
    }
    if (reviewRound > maxRepairRounds) {
      break;
    }

    const defectText = merged.defects
      .map(
        (d) =>
          `- [${d.severity}] ${d.path ?? "?"}: ${d.issue}` +
          (d.suggestedFix ? ` (fix: ${d.suggestedFix})` : ""),
      )
      .join("\n");

    try {
      const repairStream = await agent.stream(
        [
          {
            role: "user",
            content:
              "Repair the staged wiki based on this independent review council. " +
              "Use write_wiki to fix pages; re-read sources when citations are wrong.\n\n" +
              `Defects:\n${defectText || lastDefectSummary}\n\n` +
              "When done, list the paths you updated.",
          },
        ],
        {
          maxSteps: Math.min(24, maxSteps),
          ...rootMemoryOpt,
          delegation: delegation as never,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        },
      );
      if (
        repairStream.fullStream &&
        typeof repairStream.fullStream[Symbol.asyncIterator] === "function"
      ) {
        for await (const chunk of repairStream.fullStream) {
          throwIfAborted(input.abortSignal);
          if (input.writer) {
            await input.writer.write(chunk);
          }
        }
      }
      await repairStream.text;
    } catch (repairError) {
      if (isAbortError(repairError) || input.abortSignal?.aborted) {
        throw repairError;
      }
      return {
        status: "failed",
        error: `repair failed: ${redactErrorMessage(repairError)}`,
        pages,
        plan: input.plan,
      };
    }

    pages = await listMarkdownPages(wikiRoot);
    if (pages.length === 0) {
      return {
        status: "failed",
        error: "repair removed all wiki pages",
        plan: input.plan,
      };
    }
    const revalidation = await validateWikiTree(wikiRoot, {
      sources: input.workspace.sources.map((s) => ({ id: s.id, path: s.path })),
    });
    if (!revalidation.ok) {
      return {
        status: "failed",
        error: `staging failed wiki validation after repair: ${revalidation.errors.slice(0, 20).join("; ")}`,
        pages,
        plan: input.plan,
      };
    }
  }

  const scored = await evaluateWikiPublishable({
    wikiRoot,
    workspaceRoot: input.workspace.rootPath,
    runId: input.runId,
    sources: input.workspace.sources.map((s) => ({ id: s.id, path: s.path })),
    spec: input.plan,
    requireReviewReceipt: true,
  });
  if (!scored.publishable) {
    return {
      status: "failed",
      error: `host publishability gate failed: ${scored.reasons.join("; ")}`,
      pages: scored.pages,
      summary: text?.slice(0, 400) || undefined,
      plan: input.plan,
    };
  }

  return {
    status: successStatus(input.autoApprove),
    pages: scored.pages,
    summary: (text?.trim() || `Wrote ${scored.pages.length} page(s)`).slice(
      0,
      1000,
    ),
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
