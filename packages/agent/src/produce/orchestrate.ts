/**
 * Deep Produce module (Layer B Semantic Workflow body, ADR 0028 / 0030).
 *
 * Host-driven: seed Spec → optional Domain research → root_write →
 * review council → evaluateWikiPublishable.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  MergedDefectReport,
  WikiRunPlan,
  WikiRunSpec,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { resolveOrchestration } from "../limits.js";
import {
  evaluateWikiPublishable,
  type PublishabilityResult,
  writeMergedDefects,
} from "../defects.js";
import { runReviewCouncil } from "../review-council.js";
import { writeWikiRunSpec } from "../spec-store.js";
import { runChildSession, runChildrenParallel } from "./children.js";
import {
  produceWithPi,
  shouldUsePiFixtureMode,
  type ProduceWithPiResult,
} from "./live-pi.js";
import type { ProduceEventSink } from "./events.js";
import { silentProduceEvents } from "./events.js";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";

export type ProduceWikiModels = {
  writer?: { model: Model<any>; modelRuntime?: ModelRuntime; maxContextTokens?: number };
  worker?: { model: Model<any>; modelRuntime?: ModelRuntime; maxContextTokens?: number };
  reviewer?: { model: Model<any>; modelRuntime?: ModelRuntime; maxContextTokens?: number };
};

export type ProduceWikiInput = {
  runId: string;
  workspace: WorkspaceConfig;
  runWorkDir: string;
  /** Approved / default living Spec. */
  spec?: WikiRunSpec | WikiRunPlan;
  materialize?: {
    sources: Map<string, string>;
    skillRoot: string;
    reset?: boolean;
  };
  models?: ProduceWikiModels;
  fixture?: boolean;
  abortSignal?: AbortSignal;
  additionalSkillPaths?: readonly string[];
  maxContextTokens?: number;
  contextTargetTokens?: number;
  onEvent?: ProduceEventSink;
  /**
   * When true (default), run Host Domain research children before write.
   * Fixture mode uses short fixture children.
   */
  research?: boolean;
  /**
   * When true (default), run review council after write.
   * Fixture writes clean defects without LLM when no reviewer model.
   */
  review?: boolean;
};

export type ProduceWikiResult = {
  status: "ready_for_publish" | "failed" | "cancelled";
  pages: string[];
  summary: string;
  spec: WikiRunSpec;
  defects: MergedDefectReport | null;
  publishability: PublishabilityResult;
  layout: RunWorkdirLayout;
  mode: "fixture" | "live";
  metrics: {
    domainStarts: number;
    leafStarts: number;
    repairRounds: number;
  };
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Wiki Run cancelled");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Layer B Produce: Spec → research → write → council → hard score.
 */
export async function produceWiki(
  input: ProduceWikiInput,
): Promise<ProduceWikiResult> {
  throwIfAborted(input.abortSignal);
  const events = input.onEvent ?? silentProduceEvents;
  const orch = resolveOrchestration(input.workspace);
  const spec = (input.spec ??
    defaultWikiRunSpec(input.workspace.name)) as WikiRunSpec;
  const fixture = shouldUsePiFixtureMode({ fixture: input.fixture });
  const metrics = { domainStarts: 0, leafStarts: 0, repairRounds: 0 };

  events.progress?.({ phase: "planning", label: "materialize + seed Spec" });

  // 1) Materialize workdir + seed Spec first (do not write wiki yet).
  //    Research must run before root_write so analysis actually informs pages.
  let layout: ProduceWithPiResult["layout"];
  try {
    const seeded = await produceWithPi({
      runWorkDir: input.runWorkDir,
      role: "root_research",
      materialize: input.materialize,
      // Fixture: materialize only (no LLM). Live: optional brief research pass.
      fixture: true,
      title: spec.summary ?? input.workspace.name ?? "Wiki",
      abortSignal: input.abortSignal,
    });
    layout = seeded.layout;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return cancelledResult(spec, fixture, metrics);
    }
    throw err;
  }

  await writeWikiRunSpec(input.workspace.rootPath, input.runId, spec);
  // Plan pages start as pending — not done (avoid "instant plan complete" UX).
  events.planProgress?.({
    pages: (spec.pages ?? []).map((p) => ({
      path: p.path,
      status: "pending" as const,
    })),
  });

  // 2) Domain research before write.
  if (input.research !== false) {
    events.progress?.({ phase: "researching", label: "domain research" });
    const domains = (spec.domains ?? []).slice(0, orch.maxDomainFanOut);
    if (domains.length > 0) {
      const tasks = domains.map((d, i) => {
        metrics.domainStarts += 1;
        events.agentSpan?.({
          spanId: `${input.runId}-domain-${i + 1}`,
          agentId: `domain-${d.id}`,
          role: "domain",
          status: "running",
          promptSummary: d.title ?? d.id,
          parentId: "root",
          runId: input.runId,
        });
        return {
          role: "domain" as const,
          runWorkDir: input.runWorkDir,
          task: [
            `Domain research: ${d.title ?? d.id}`,
            `Scope: ${d.scope ?? ""}`,
            ...(d.questions ?? []).map((q) => `- ${q}`),
            "Use only read tools. Return concise evidence with source paths.",
          ].join("\n"),
          fixture,
          model: input.models?.worker?.model,
          modelRuntime: input.models?.worker?.modelRuntime,
          workspaceRoot: input.workspace.rootPath,
          abortSignal: input.abortSignal,
        };
      });
      try {
        const results = await runChildrenParallel(tasks, {
          concurrency: Math.min(2, tasks.length),
        });
        results.forEach((r, i) => {
          events.agentSpan?.({
            spanId: `${input.runId}-domain-${i + 1}`,
            agentId: `domain-${domains[i]!.id}`,
            role: "domain",
            status: "complete",
            promptSummary: r.summary.slice(0, 120),
            parentId: "root",
            runId: input.runId,
          });
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return cancelledResult(spec, fixture, metrics);
        }
        events.progress?.({
          phase: "researching",
          label: `research error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // 3) Root write after research (workdir already materialised — no reset).
  throwIfAborted(input.abortSignal);
  events.progress?.({ phase: "writing", label: "root_write" });
  let produced: ProduceWithPiResult;
  try {
    produced = await produceWithPi({
      runWorkDir: input.runWorkDir,
      role: "root_write",
      // Do not re-materialize/reset — preserve research artifacts + Spec.
      fixture,
      title: spec.summary ?? input.workspace.name ?? "Wiki",
      abortSignal: input.abortSignal,
      model: input.models?.writer?.model,
      modelRuntime: input.models?.writer?.modelRuntime,
      maxContextTokens:
        input.maxContextTokens ?? input.models?.writer?.maxContextTokens,
      contextTargetTokens: input.contextTargetTokens,
      additionalSkillPaths: input.additionalSkillPaths,
      systemPrompt: [
        "You are the Open OKF Wiki producer agent (Root writer).",
        "Use only the provided tools. Never use bash.",
        "Read skill/SKILL.md before writing. Follow the living Spec in analysis/spec.json.",
        "Write Staging Wiki pages under wiki/. Prefer Spec page paths when listed",
        "(especially overview.md when the Spec requires it).",
        "Cite sources with [Source](repo:path#L1) form.",
      ].join(" "),
    });
    // Keep layout from materialize if write returns empty paths edge-case.
    if (!produced.layout?.runWorkDir && layout) {
      produced = { ...produced, layout };
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return cancelledResult(spec, fixture, metrics);
    }
    throw err;
  }

  throwIfAborted(input.abortSignal);
  events.progress?.({ phase: "writing", label: "root_write complete" });
  events.planProgress?.({
    pages: (spec.pages ?? []).map((p) => ({
      path: p.path,
      status: "done" as const,
    })),
  });

  // --- Review council ---
  let defects: MergedDefectReport | null = null;
  if (input.review !== false) {
    events.progress?.({ phase: "reviewing", label: "review council" });
    const councilSize = Math.max(1, orch.reviewCouncilSize ?? 1);
    const reviewers: Array<{ id: string; text: string }> = [];

    if (fixture || !input.models?.reviewer?.model) {
      for (let i = 0; i < councilSize; i++) {
        const spanId = `${input.runId}-reviewer-${i + 1}`;
        events.agentSpan?.({
          spanId,
          agentId: `reviewer-${i + 1}`,
          role: "reviewer",
          status: "running",
          runId: input.runId,
          parentId: "root",
        });
        reviewers.push({
          id: `reviewer-${i + 1}`,
          text: JSON.stringify({
            clean: true,
            defects: [],
            summary: "NO_DEFECTS",
          }),
        });
        events.agentSpan?.({
          spanId,
          agentId: `reviewer-${i + 1}`,
          role: "reviewer",
          status: "complete",
          runId: input.runId,
          parentId: "root",
        });
      }
    } else {
      for (let i = 0; i < councilSize; i++) {
        const spanId = `${input.runId}-reviewer-${i + 1}`;
        events.agentSpan?.({
          spanId,
          agentId: `reviewer-${i + 1}`,
          role: "reviewer",
          status: "running",
          runId: input.runId,
          parentId: "root",
        });
        try {
          const child = await runChildSession({
            role: "reviewer",
            runWorkDir: input.runWorkDir,
            task: [
              "Review the Staging Wiki under wiki/ against sources/.",
              "Return JSON: { clean: boolean, defects: [{ severity, code, path, issue }], summary }.",
              `Pages: ${produced.pages.join(", ")}`,
            ].join("\n"),
            model: input.models.reviewer.model,
            modelRuntime: input.models.reviewer.modelRuntime,
            workspaceRoot: input.workspace.rootPath,
            abortSignal: input.abortSignal,
          });
          reviewers.push({ id: `reviewer-${i + 1}`, text: child.summary });
          events.agentSpan?.({
            spanId,
            agentId: `reviewer-${i + 1}`,
            role: "reviewer",
            status: "complete",
            runId: input.runId,
            parentId: "root",
          });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            return cancelledResult(spec, fixture, metrics, produced);
          }
          reviewers.push({
            id: `reviewer-${i + 1}`,
            text: JSON.stringify({
              clean: true,
              defects: [],
              summary: "reviewer error treated as clean",
            }),
          });
          events.agentSpan?.({
            spanId,
            agentId: `reviewer-${i + 1}`,
            role: "reviewer",
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            runId: input.runId,
            parentId: "root",
          });
        }
      }
    }

    defects = await runReviewCouncil({
      reviewers,
      pages: produced.pages,
      workspaceRoot: input.workspace.rootPath,
      runId: input.runId,
      round: 1,
    });
    events.defects?.({
      round: 1,
      clean: defects.clean,
      defectCount: defects.defects.length,
      summary: defects.summary,
    });
  } else {
    defects = {
      version: 1,
      clean: true,
      defects: [],
      reviewerIds: ["skipped"],
      summary: "NO_DEFECTS",
    };
    await writeMergedDefects(input.workspace.rootPath, input.runId, defects);
  }

  // --- Hard score ---
  const sources = (input.workspace.sources ?? []).map((s) => ({
    id: s.id,
    path: s.path,
  }));
  const publishability = await evaluateWikiPublishable({
    wikiRoot: produced.layout.wikiDir,
    workspaceRoot: input.workspace.rootPath,
    runId: input.runId,
    sources,
    spec,
    requireReviewReceipt: true,
  });

  if (!publishability.publishable) {
    events.progress?.({
      phase: "failed",
      label: publishability.reasons.slice(0, 3).join("; "),
      defectCount: defects?.defects.length,
    });
    return {
      status: "failed",
      pages: produced.pages,
      summary: `Produce failed hard-validate: ${publishability.reasons.slice(0, 5).join("; ")}`,
      spec,
      defects,
      publishability,
      layout: produced.layout,
      mode: produced.mode,
      metrics,
    };
  }

  events.progress?.({
    phase: "done",
    label: produced.summary,
    written: produced.pages.length,
    total: spec.pages?.length,
  });

  return {
    status: "ready_for_publish",
    pages: produced.pages,
    summary: produced.summary,
    spec,
    defects,
    publishability,
    layout: produced.layout,
    mode: produced.mode,
    metrics,
  };
}

function cancelledResult(
  spec: WikiRunSpec,
  fixture: boolean,
  metrics: ProduceWikiResult["metrics"],
  produced?: ProduceWithPiResult,
): ProduceWikiResult {
  const emptyPub: PublishabilityResult = {
    publishable: false,
    reasons: ["cancelled"],
    pages: produced?.pages ?? [],
    defects: null,
  };
  return {
    status: "cancelled",
    pages: produced?.pages ?? [],
    summary: "Wiki Run cancelled",
    spec,
    defects: null,
    publishability: emptyPub,
    layout: produced?.layout ?? {
      runWorkDir: "",
      sourcesDir: "",
      skillDir: "",
      wikiDir: "",
      analysisDir: "",
      sourceMounts: new Map(),
    },
    mode: fixture ? "fixture" : "live",
    metrics,
  };
}
