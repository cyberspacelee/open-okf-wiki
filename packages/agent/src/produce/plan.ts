/**
 * Planner phase: build a living WikiRunSpec from sources (or fixture default).
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defaultWikiRunSpec, type WikiRunSpec } from "@okf-wiki/contract";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import { runChildSession } from "./children.js";
import { parsePlanFromAgentText } from "./plan-parse.js";
import { plannerPrompt } from "./prompts.js";

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
    return {
      spec: input.priorSpec ?? defaultWikiRunSpec(input.workspaceName),
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
  });
  return {
    spec: parsePlanFromAgentText(child.summary),
    mode: "live",
    rawSummary: child.summary,
  };
}
