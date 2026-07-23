/**
 * Deep Produce module (Layer B Semantic Workflow body, ADR 0028 / 0030).
 *
 * Host-driven: materialize → plan → Domain/Leaf research + receipts →
 * root_write → review council → repair* → evaluateWikiPublishable.
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
  listWikiMarkdown,
  produceWithPi,
  shouldUsePiFixtureMode,
  type ProduceWithPiResult,
} from "./live-pi.js";
import type { ProduceEventSink } from "./events.js";
import { silentProduceEvents } from "./events.js";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import { planWikiSpec } from "./plan.js";
import { buildReceiptIndex, persistResearchReceipt } from "./receipts.js";
import {
  domainResearchPrompt,
  leafResearchPrompt,
  reviewerPrompt,
  rootWritePrompt,
  rootWriteSystemPrompt,
} from "./prompts.js";

export type ProduceWikiModels = {
  planner?: {
    model: Model<any>;
    modelRuntime?: ModelRuntime;
    maxContextTokens?: number;
  };
  writer?: {
    model: Model<any>;
    modelRuntime?: ModelRuntime;
    maxContextTokens?: number;
  };
  worker?: {
    model: Model<any>;
    modelRuntime?: ModelRuntime;
    maxContextTokens?: number;
  };
  reviewer?: {
    model: Model<any>;
    modelRuntime?: ModelRuntime;
    maxContextTokens?: number;
  };
};

export type ProduceWikiInput = {
  runId: string;
  workspace: WorkspaceConfig;
  runWorkDir: string;
  /** Approved / default living Spec. When omit and live, planner may run. */
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
  research?: boolean;
  review?: boolean;
  /** Skip LLM planner; use provided/default Spec. */
  skipPlan?: boolean;
  sourceIgnores?: SourceIgnoreInput;
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

async function emitPlanProgressFromDisk(
  events: ProduceEventSink,
  wikiDir: string,
  spec: WikiRunSpec,
  writingPath?: string,
): Promise<void> {
  const existing = new Set(await listWikiMarkdown(wikiDir));
  events.planProgress?.({
    pages: (spec.pages ?? []).map((p) => {
      const norm = p.path.replace(/^\.?\//, "");
      if (existing.has(norm)) {
        return { path: p.path, status: "done" as const };
      }
      if (writingPath && writingPath === norm) {
        return { path: p.path, status: "writing" as const };
      }
      return { path: p.path, status: "pending" as const };
    }),
  });
}

/**
 * Layer B Produce: plan → research → write → council → repair → hard score.
 */
export async function produceWiki(
  input: ProduceWikiInput,
): Promise<ProduceWikiResult> {
  throwIfAborted(input.abortSignal);
  const events = input.onEvent ?? silentProduceEvents;
  const orch = resolveOrchestration(input.workspace);
  const fixture = shouldUsePiFixtureMode({ fixture: input.fixture });
  const metrics = { domainStarts: 0, leafStarts: 0, repairRounds: 0 };
  const multiSource = (input.workspace.sources?.length ?? 0) > 1;
  const wikiLanguage = input.workspace.wikiLanguage ?? "en";
  const contextTargetTokens =
    input.contextTargetTokens ?? input.workspace.limits?.contextTargetTokens;

  events.progress?.({ phase: "planning", label: "materialize workdir" });

  // 1) Materialize workdir (fixture materialize; no wiki write yet).
  let layout: ProduceWithPiResult["layout"];
  try {
    const seeded = await produceWithPi({
      runWorkDir: input.runWorkDir,
      role: "root_research",
      materialize: input.materialize,
      fixture: true,
      title: input.workspace.name ?? "Wiki",
      abortSignal: input.abortSignal,
      sourceIgnores: input.sourceIgnores,
      workspaceRoot: input.workspace.rootPath,
    });
    layout = seeded.layout;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return cancelledResult(
        input.spec
          ? (input.spec as WikiRunSpec)
          : defaultWikiRunSpec(input.workspace.name),
        fixture,
        metrics,
      );
    }
    throw err;
  }

  // 2) Spec: use provided, or planner, or default (fixture).
  let spec: WikiRunSpec;
  try {
    if (input.spec) {
      spec = input.spec as WikiRunSpec;
    } else if (fixture || input.skipPlan) {
      spec = defaultWikiRunSpec(input.workspace.name);
    } else {
      events.progress?.({ phase: "planning", label: "planner session" });
      const planned = await planWikiSpec({
        runWorkDir: input.runWorkDir,
        layout,
        workspaceName: input.workspace.name,
        wikiLanguage,
        fixture: false,
        model: input.models?.planner?.model ?? input.models?.writer?.model,
        modelRuntime:
          input.models?.planner?.modelRuntime ??
          input.models?.writer?.modelRuntime,
        maxContextTokens:
          input.models?.planner?.maxContextTokens ??
          input.models?.writer?.maxContextTokens ??
          input.maxContextTokens,
        contextTargetTokens,
        workspaceRoot: input.workspace.rootPath,
        sourceIgnores: input.sourceIgnores,
        abortSignal: input.abortSignal,
        agentId: "planner",
        onPiEvent: events.childPiEvent,
      });
      spec = planned.spec;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return cancelledResult(
        defaultWikiRunSpec(input.workspace.name),
        fixture,
        metrics,
      );
    }
    events.progress?.({
      phase: "failed",
      label: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "failed",
      pages: [],
      summary: `Plan failed: ${err instanceof Error ? err.message : String(err)}`,
      spec: defaultWikiRunSpec(input.workspace.name),
      defects: null,
      publishability: {
        publishable: false,
        reasons: [err instanceof Error ? err.message : String(err)],
        pages: [],
        defects: null,
      },
      layout,
      mode: fixture ? "fixture" : "live",
      metrics,
    };
  }

  await writeWikiRunSpec(input.workspace.rootPath, input.runId, spec);
  await emitPlanProgressFromDisk(events, layout.wikiDir, spec);

  // 3) Domain + Leaf research with receipts.
  const criticalDomainFailures: string[] = [];
  if (input.research !== false) {
    events.progress?.({ phase: "researching", label: "domain + leaf research" });
    const domains = (spec.domains ?? []).slice(0, orch.maxDomainFanOut);
    const workerModel = input.models?.worker ?? input.models?.writer;

    for (const d of domains) {
      throwIfAborted(input.abortSignal);
      metrics.domainStarts += 1;
      const domainNodeId = `domain-${d.id}`;
      events.agentSpan?.({
        spanId: `${input.runId}-${domainNodeId}`,
        agentId: domainNodeId,
        role: "domain",
        status: "running",
        promptSummary: d.title ?? d.id,
        parentId: "root",
        runId: input.runId,
      });

      const leafQuestions = (d.questions ?? []).slice(0, orch.maxLeafFanOut);
      const childReceiptPaths: string[] = [];

      if (leafQuestions.length > 0 && orch.maxDepth >= 2) {
        const leafTasks = leafQuestions.map((q, li) => {
          metrics.leafStarts += 1;
          const leafNodeId = `leaf-${d.id}-${li + 1}`;
          events.agentSpan?.({
            spanId: `${input.runId}-${leafNodeId}`,
            agentId: leafNodeId,
            role: "leaf",
            status: "running",
            promptSummary: q.slice(0, 120),
            parentId: domainNodeId,
            runId: input.runId,
          });
          return {
            leafNodeId,
            input: {
              role: "leaf" as const,
              agentId: leafNodeId,
              runWorkDir: input.runWorkDir,
              task: leafResearchPrompt({
                domainId: d.id,
                question: q,
                scope: d.scope ?? "",
                nodeId: leafNodeId,
                runId: input.runId,
              }),
              fixture,
              model: workerModel?.model,
              modelRuntime: workerModel?.modelRuntime,
              maxContextTokens: workerModel?.maxContextTokens,
              contextTargetTokens,
              workspaceRoot: input.workspace.rootPath,
              sourceIgnores: input.sourceIgnores,
              abortSignal: input.abortSignal,
              onPiEvent: events.childPiEvent,
            },
          };
        });

        try {
          const leafResults = await runChildrenParallel(
            leafTasks.map((t) => t.input),
            { concurrency: Math.min(2, leafTasks.length) },
          );
          for (let i = 0; i < leafResults.length; i++) {
            const leafNodeId = leafTasks[i]!.leafNodeId;
            const lr = leafResults[i]!;
            const persisted = await persistResearchReceipt({
              workspaceRoot: input.workspace.rootPath,
              runWorkDir: input.runWorkDir,
              runId: input.runId,
              nodeId: leafNodeId,
              parentId: domainNodeId,
              scope: `${d.id}: ${leafQuestions[i]}`,
              summary: lr.summary,
              status: "complete",
            });
            childReceiptPaths.push(persisted.relativePath);
            events.agentSpan?.({
              spanId: `${input.runId}-${leafNodeId}`,
              agentId: leafNodeId,
              role: "leaf",
              status: "complete",
              promptSummary: lr.summary.slice(0, 120),
              detail: lr.summary.slice(0, 12_000),
              task: leafQuestions[i],
              parentId: domainNodeId,
              runId: input.runId,
              receiptPath: persisted.relativePath,
            });
          }
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            return cancelledResult(spec, fixture, metrics);
          }
          for (const t of leafTasks) {
            events.agentSpan?.({
              spanId: `${input.runId}-${t.leafNodeId}`,
              agentId: t.leafNodeId,
              role: "leaf",
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
              parentId: domainNodeId,
              runId: input.runId,
            });
          }
        }
      }

      try {
        const domainResult = await runChildSession({
          role: "domain",
          agentId: domainNodeId,
          runWorkDir: input.runWorkDir,
          task: domainResearchPrompt({
            domainId: d.id,
            title: d.title ?? d.id,
            scope: d.scope ?? "",
            questions: d.questions ?? [],
            nodeId: domainNodeId,
            runId: input.runId,
          }),
          fixture,
          model: workerModel?.model,
          modelRuntime: workerModel?.modelRuntime,
          maxContextTokens: workerModel?.maxContextTokens,
          contextTargetTokens,
          workspaceRoot: input.workspace.rootPath,
          sourceIgnores: input.sourceIgnores,
          abortSignal: input.abortSignal,
          onPiEvent: events.childPiEvent,
        });
        const persisted = await persistResearchReceipt({
          workspaceRoot: input.workspace.rootPath,
          runWorkDir: input.runWorkDir,
          runId: input.runId,
          nodeId: domainNodeId,
          parentId: "root",
          scope: d.scope ?? d.title ?? d.id,
          summary: domainResult.summary,
          status: "complete",
          childReceipts: childReceiptPaths,
        });
        events.agentSpan?.({
          spanId: `${input.runId}-${domainNodeId}`,
          agentId: domainNodeId,
          role: "domain",
          status: "complete",
          promptSummary: domainResult.summary.slice(0, 120),
          detail: domainResult.summary.slice(0, 12_000),
          task: `Domain research: ${d.title ?? d.id}`,
          parentId: "root",
          runId: input.runId,
          receiptPath: persisted.relativePath,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return cancelledResult(spec, fixture, metrics);
        }
        const msg = err instanceof Error ? err.message : String(err);
        events.agentSpan?.({
          spanId: `${input.runId}-${domainNodeId}`,
          agentId: domainNodeId,
          role: "domain",
          status: "failed",
          error: msg,
          parentId: "root",
          runId: input.runId,
        });
        await persistResearchReceipt({
          workspaceRoot: input.workspace.rootPath,
          runWorkDir: input.runWorkDir,
          runId: input.runId,
          nodeId: domainNodeId,
          parentId: "root",
          scope: d.scope ?? d.title ?? d.id,
          summary: `FAILED: ${msg}`,
          status: "failed",
          childReceipts: childReceiptPaths,
        });
        if (d.critical !== false) {
          criticalDomainFailures.push(`${d.id}: ${msg}`);
        }
      }
    }
  }

  if (criticalDomainFailures.length > 0 && !fixture) {
    events.progress?.({
      phase: "failed",
      label: `critical domain research failed: ${criticalDomainFailures[0]}`,
    });
    return {
      status: "failed",
      pages: [],
      summary: `Critical domain research failed: ${criticalDomainFailures.join("; ")}`,
      spec,
      defects: null,
      publishability: {
        publishable: false,
        reasons: criticalDomainFailures.map((f) => `domain: ${f}`),
        pages: [],
        defects: null,
      },
      layout,
      mode: "live",
      metrics,
    };
  }

  // 4) Root write
  throwIfAborted(input.abortSignal);
  events.progress?.({ phase: "writing", label: "root_write" });
  const receiptIndex = await buildReceiptIndex(input.runWorkDir);
  let produced: ProduceWithPiResult;
  try {
    produced = await produceWithPi({
      runWorkDir: input.runWorkDir,
      role: "root_write",
      fixture,
      title: spec.summary ?? input.workspace.name ?? "Wiki",
      abortSignal: input.abortSignal,
      model: input.models?.writer?.model,
      modelRuntime: input.models?.writer?.modelRuntime,
      maxContextTokens:
        input.maxContextTokens ?? input.models?.writer?.maxContextTokens,
      contextTargetTokens,
      additionalSkillPaths: input.additionalSkillPaths,
      sourceIgnores: input.sourceIgnores,
      workspaceRoot: input.workspace.rootPath,
      spec,
      wikiLanguage,
      multiSource,
      receiptIndex,
      systemPrompt: rootWriteSystemPrompt(),
      prompt: rootWritePrompt({
        layout,
        spec,
        wikiLanguage,
        multiSource,
        receiptIndex,
      }),
    });
    if (!produced.layout?.runWorkDir && layout) {
      produced = { ...produced, layout };
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return cancelledResult(spec, fixture, metrics);
    }
    throw err;
  }

  await emitPlanProgressFromDisk(events, produced.layout.wikiDir, spec);
  events.progress?.({
    phase: "writing",
    label: "root_write complete",
    written: produced.pages.length,
    total: spec.pages?.length,
  });

  // 5) Review + repair loop
  let defects: MergedDefectReport | null = null;
  const maxRepair = Math.max(0, spec.acceptance?.maxRepairRounds ?? 2);
  const councilSize = Math.max(1, orch.reviewCouncilSize ?? 1);
  const lenses = ["grounding", "coverage", "consistency", "general"] as const;

  if (input.review !== false) {
    for (let round = 1; round <= maxRepair + 1; round++) {
      throwIfAborted(input.abortSignal);
      events.progress?.({
        phase: "reviewing",
        label: `review council round ${round}`,
      });

      const reviewers: Array<{ id: string; text: string }> = [];
      if (fixture || !input.models?.reviewer?.model) {
        for (let i = 0; i < councilSize; i++) {
          const spanId = `${input.runId}-reviewer-${i + 1}-r${round}`;
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
          const spanId = `${input.runId}-reviewer-${i + 1}-r${round}`;
          const lens = lenses[i % lenses.length]!;
          events.agentSpan?.({
            spanId,
            agentId: `reviewer-${i + 1}`,
            role: "reviewer",
            status: "running",
            promptSummary: lens,
            runId: input.runId,
            parentId: "root",
          });
          try {
            const child = await runChildSession({
              role: "reviewer",
              agentId: `reviewer-${i + 1}`,
              runWorkDir: input.runWorkDir,
              task: reviewerPrompt({ pages: produced.pages, lens }),
              model: input.models.reviewer.model,
              modelRuntime: input.models.reviewer.modelRuntime,
              maxContextTokens: input.models.reviewer.maxContextTokens,
              contextTargetTokens,
              workspaceRoot: input.workspace.rootPath,
              sourceIgnores: input.sourceIgnores,
              abortSignal: input.abortSignal,
              onPiEvent: events.childPiEvent,
            });
            reviewers.push({ id: `reviewer-${i + 1}`, text: child.summary });
            events.agentSpan?.({
              spanId,
              agentId: `reviewer-${i + 1}`,
              role: "reviewer",
              status: "complete",
              promptSummary: child.summary.slice(0, 120),
              detail: child.summary.slice(0, 12_000),
              task: `Review lens: ${lens}`,
              runId: input.runId,
              parentId: "root",
            });
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
              return cancelledResult(spec, fixture, metrics, produced);
            }
            // Fail-closed: reviewer error is a blocking defect, not clean.
            const msg = err instanceof Error ? err.message : String(err);
            reviewers.push({
              id: `reviewer-${i + 1}`,
              text: JSON.stringify({
                clean: false,
                defects: [
                  {
                    severity: "blocking",
                    code: "reviewer_error",
                    issue: `Reviewer failed: ${msg}`,
                  },
                ],
                summary: `reviewer error: ${msg}`,
              }),
            });
            events.agentSpan?.({
              spanId,
              agentId: `reviewer-${i + 1}`,
              role: "reviewer",
              status: "failed",
              error: msg,
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
        round,
      });
      events.defects?.({
        round,
        clean: defects.clean,
        defectCount: defects.defects.length,
        summary: defects.summary,
      });

      const blocking = (spec.acceptance?.blockingSeverities ?? [
        "blocking",
      ]) as string[];
      const hasBlocking = defects.defects.some((d) =>
        blocking.includes(d.severity),
      );
      if (defects.clean || !hasBlocking) {
        break;
      }
      if (round > maxRepair) {
        break;
      }

      // Repair round
      metrics.repairRounds += 1;
      events.progress?.({
        phase: "repairing",
        label: `repair round ${metrics.repairRounds}`,
        defectCount: defects.defects.length,
      });
      const defectText = defects.defects
        .map(
          (d) =>
            `- [${d.severity}] ${d.path ?? "?"} ${d.code ?? ""}: ${d.issue}`,
        )
        .join("\n");
      try {
        produced = await produceWithPi({
          runWorkDir: input.runWorkDir,
          role: "root_write",
          fixture,
          title: spec.summary ?? input.workspace.name ?? "Wiki",
          abortSignal: input.abortSignal,
          model: input.models?.writer?.model,
          modelRuntime: input.models?.writer?.modelRuntime,
          maxContextTokens:
            input.maxContextTokens ?? input.models?.writer?.maxContextTokens,
          contextTargetTokens,
          additionalSkillPaths: input.additionalSkillPaths,
          sourceIgnores: input.sourceIgnores,
          workspaceRoot: input.workspace.rootPath,
          spec,
          wikiLanguage,
          multiSource,
          receiptIndex,
          repairDefects: defectText,
          systemPrompt: rootWriteSystemPrompt(),
          prompt: rootWritePrompt({
            layout: produced.layout,
            spec,
            wikiLanguage,
            multiSource,
            receiptIndex,
            repairDefects: defectText,
          }),
        });
        await emitPlanProgressFromDisk(events, produced.layout.wikiDir, spec);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return cancelledResult(spec, fixture, metrics, produced);
        }
        throw err;
      }
    }
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

  // 6) Hard score
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
