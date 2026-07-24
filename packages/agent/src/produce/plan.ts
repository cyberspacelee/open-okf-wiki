/**
 * Planner phase: build a living WikiRunSpec from sources (or fixture default).
 * Includes fail-closed JSON Spec parsing (formerly plan-parse.ts).
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  defaultWikiRunSpec,
  type WikiProduceChildSpan,
  type WikiRunSpec,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import { runChildSession } from "./children.js";
import { plannerPrompt } from "./prompts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompleteSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required = [
    "version",
    "summary",
    "audience",
    "domains",
    "pages",
    "openQuestions",
    "acceptance",
    "changelog",
  ];
  if (!required.every((key) => key in value)) return false;
  if (!Array.isArray(value.domains) || !Array.isArray(value.pages)) return false;
  if (
    !value.domains.every(
      (domain) =>
        isRecord(domain) &&
        ["id", "title", "scope", "critical", "questions"].every((key) => key in domain),
    )
  ) {
    return false;
  }
  if (
    !value.pages.every(
      (page) =>
        isRecord(page) &&
        ["path", "purpose", "domainIds", "questions", "critical"].every((key) => key in page),
    )
  ) {
    return false;
  }
  const acceptance = value.acceptance;
  return (
    isRecord(acceptance) &&
    ["reviewRequired", "maxRepairRounds", "blockingSeverities"].every((key) => key in acceptance)
  );
}

/**
 * Accept a complete WikiRunSpec as raw or fenced JSON.
 *
 * Markdown page lists and thin `{ summary, pages }` plans are intentionally
 * rejected: accepting them made the live Planner silently succeed with an
 * invented default Spec instead of failing closed.
 */
export function parsePlanFromAgentText(text: string): WikiRunSpec {
  const raw = text?.trim() ?? "";
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = [fence?.[1]?.trim(), raw].filter(
    (candidate, index, values): candidate is string =>
      Boolean(candidate) && values.indexOf(candidate) === index,
  );

  for (const candidate of candidates) {
    try {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start < 0 || end <= start) continue;
      const value = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (!isCompleteSpec(value)) continue;
      const parsed = WikiRunSpecSchema.safeParse(value);
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next representation before failing closed.
    }
  }

  throw new Error("Planner did not return a complete JSON WikiRunSpec");
}

export type PlanWikiSpecInput = {
  layout: RunWorkdirLayout;
  workspaceName: string;
  wikiLanguage?: "en" | "zh";
  fixture?: boolean;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  abortSignal?: AbortSignal;
  /** When true, skip LLM and return defaultWikiRunSpec. */
  useDefaultSpec?: boolean;
  /** Existing Spec and feedback when the operator requests a real re-plan. */
  operatorNotes?: string;
  priorSpec?: WikiRunSpec;
  revisionFeedback?: string;
  /** Parent wiki_produce details.children projection. */
  onProgress?: (span: WikiProduceChildSpan) => void;
};

export type PlanWikiSpecResult = {
  spec: WikiRunSpec;
  mode: "fixture" | "live" | "default";
  rawSummary?: string;
};

/**
 * Produce a WikiRunSpec via Planner child session (RO tools).
 * Fail-closed on live parse failure unless useDefaultSpec is set.
 */
export async function planWikiSpec(input: PlanWikiSpecInput): Promise<PlanWikiSpecResult> {
  if (input.useDefaultSpec || input.fixture) {
    const spec = input.priorSpec ?? defaultWikiRunSpec(input.workspaceName);
    input.onProgress?.({
      id: "plan",
      role: "plan",
      status: "done",
      summary: input.fixture ? "Fixture default WikiRunSpec" : "Default WikiRunSpec",
      items: [{ type: "text", text: `pages=${spec.pages.length}` }],
    });
    return {
      spec,
      mode: input.fixture ? "fixture" : "default",
    };
  }

  if (!input.model) {
    throw new Error("Live plan phase requires a model, or pass fixture/useDefaultSpec");
  }

  const basePrompt = plannerPrompt({
    layout: input.layout,
    workspaceName: input.workspaceName,
    wikiLanguage: input.wikiLanguage,
    operatorNotes: input.operatorNotes,
  });
  const revisionPrompt = input.priorSpec
    ? [
        "Revise the existing WikiRunSpec after re-reading the frozen sources.",
        `Operator feedback: ${input.revisionFeedback?.trim() || "Re-evaluate the Spec."}`,
        "Existing WikiRunSpec:",
        JSON.stringify(input.priorSpec),
      ].join("\n\n")
    : "";
  const child = await runChildSession({
    role: "plan",
    spanId: "plan",
    runWorkDir: input.layout.runWorkDir,
    task: [basePrompt, revisionPrompt].filter(Boolean).join("\n\n"),
    systemPrompt:
      "You are the Wiki planner. Read-only tools only. Return JSON WikiRunSpec. Never write files.",
    model: input.model,
    modelRuntime: input.modelRuntime,
    sourceIgnores: input.sourceIgnores,
    maxContextTokens: input.maxContextTokens,
    contextTargetTokens: input.contextTargetTokens,
    abortSignal: input.abortSignal,
    onProgress: input.onProgress,
  });
  return {
    spec: parsePlanFromAgentText(child.summary),
    mode: "live",
    rawSummary: child.summary,
  };
}
