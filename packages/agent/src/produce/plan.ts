/**
 * Planner phase: build a living WikiRunSpec from sources (or fixture default).
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  WikiRunSpecSchema,
  defaultWikiRunSpec,
  type WikiRunSpec,
} from "@okf-wiki/contract";
import { runChildSession } from "./children.js";
import { parsePlanFromAgentText } from "./plan-parse.js";
import { plannerPrompt } from "./prompts.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";

export type PlanWikiSpecInput = {
  runWorkDir: string;
  layout: RunWorkdirLayout;
  workspaceName: string;
  wikiLanguage?: "en" | "zh";
  fixture?: boolean;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  workspaceRoot?: string;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  abortSignal?: AbortSignal;
  /** When true, skip LLM and return defaultWikiRunSpec. */
  useDefaultSpec?: boolean;
  /**
   * Forward planner Pi events for parent-visibility → work_unit.
   * Signature matches runChildSession.onPiEvent.
   */
  onPiEvent?: (kind: string, payload: unknown) => void;
  /** Operator-visible unit id (default: "planner"). */
  unitId?: string;
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
export async function planWikiSpec(
  input: PlanWikiSpecInput,
): Promise<PlanWikiSpecResult> {
  if (input.useDefaultSpec || input.fixture) {
    return {
      spec: defaultWikiRunSpec(input.workspaceName),
      mode: input.fixture ? "fixture" : "default",
    };
  }

  if (!input.model) {
    throw new Error(
      "Live plan phase requires a model, or pass fixture/useDefaultSpec",
    );
  }

  const child = await runChildSession({
    role: "plan",
    unitId: input.unitId ?? "planner",
    runWorkDir: input.runWorkDir,
    task: plannerPrompt({
      layout: input.layout,
      workspaceName: input.workspaceName,
      wikiLanguage: input.wikiLanguage,
    }),
    systemPrompt:
      "You are the Wiki planner. Read-only tools only. Return JSON WikiRunSpec. Never write files.",
    model: input.model,
    modelRuntime: input.modelRuntime,
    workspaceRoot: input.workspaceRoot,
    sourceIgnores: input.sourceIgnores,
    maxContextTokens: input.maxContextTokens,
    contextTargetTokens: input.contextTargetTokens,
    abortSignal: input.abortSignal,
    onPiEvent: input.onPiEvent,
  });

  // Prefer structured parse from plan-parse helpers / JSON extract.
  const fromJson = tryParseSpecJson(child.summary);
  if (fromJson) {
    return { spec: fromJson, mode: "live", rawSummary: child.summary };
  }

  const thin = parsePlanFromAgentText(child.summary, {
    workspaceName: input.workspaceName,
  });
  if (thin.pages?.length) {
    return { spec: thin, mode: "live", rawSummary: child.summary };
  }

  throw new Error(
    "Planner did not return a parseable WikiRunSpec (fail-closed)",
  );
}

function tryParseSpecJson(text: string): WikiRunSpec | null {
  const raw = text?.trim() ?? "";
  if (!raw) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = [fence?.[1]?.trim(), raw].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      // Find outermost object
      const start = c.indexOf("{");
      const end = c.lastIndexOf("}");
      if (start < 0 || end <= start) continue;
      const obj = JSON.parse(c.slice(start, end + 1)) as unknown;
      const parsed = WikiRunSpecSchema.safeParse(obj);
      if (parsed.success) return parsed.data;
    } catch {
      // try next
    }
  }
  return null;
}
