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
import {
  evaluateWikiPublishable,
  type PublishabilityResult,
  writeMergedDefects,
} from "../defects.js";
import { resolveOrchestration } from "../limits.js";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import { runReviewCouncil } from "../review-council.js";
import { writeWikiRunSpec } from "../spec-store.js";
import { runChildrenParallel, runChildSession } from "./children.js";
import type { ProduceEventSink } from "./events.js";
import { silentProduceEvents } from "./events.js";
import {
  listWikiMarkdown,
  type ProduceWithPiResult,
  produceWithPi,
  shouldUsePiFixtureMode,
} from "./live-pi.js";
import { attachWorkUnitSink } from "./parent-visibility.js";
import { planWikiSpec } from "./plan.js";
import {
  domainResearchPrompt,
  leafResearchPrompt,
  reviewerPrompt,
  rootWritePrompt,
  rootWriteSystemPrompt,
} from "./prompts.js";
import { buildReceiptIndex, persistResearchReceipt } from "./receipts.js";

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
export async function produceWiki(input: ProduceWikiInput): Promise<ProduceWikiResult> {
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
        input.spec ? (input.spec as WikiRunSpec) : defaultWikiRunSpec(input.workspace.name),
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
      const plannerUnit = attachWorkUnitSink(events, {
        unitId: "planner",
        role: "planner",
        task: "Draft WikiRunSpec from sources",
        parentId: "root",
        runId: input.runId,
      });
      plannerUnit.open();
      try {
        const planned = await planWikiSpec({
          runWorkDir: input.runWorkDir,
          layout,
          workspaceName: input.workspace.name,
          wikiLanguage,
          fixture: false,
          model: input.models?.planner?.model ?? input.models?.writer?.model,
          modelRuntime: input.models?.planner?.modelRuntime ?? input.models?.writer?.modelRuntime,
          maxContextTokens:
            input.models?.planner?.maxContextTokens ??
            input.models?.writer?.maxContextTokens ??
            input.maxContextTokens,
          contextTargetTokens,
          workspaceRoot: input.workspace.rootPath,
          sourceIgnores: input.sourceIgnores,
          abortSignal: input.abortSignal,
          unitId: "planner",
          onPiEvent: plannerUnit.onPiEvent,
        });
        plannerUnit.settle(
          planned.spec.summary?.slice(0, 4000) ||
            `Planned ${planned.spec.pages?.length ?? 0} page(s)`,
        );
        spec = planned.spec;
      } catch (planErr) {
        if (!(planErr instanceof Error && planErr.name === "AbortError")) {
          plannerUnit.fail(planErr instanceof Error ? planErr.message : String(planErr));
        }
        throw planErr;
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return cancelledResult(defaultWikiRunSpec(input.workspace.name), fixture, metrics);
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
      const domainUnit = attachWorkUnitSink(events, {
        unitId: domainNodeId,
        role: "domain",
        task: d.title ?? d.id,
        parentId: "root",
        runId: input.runId,
      });
      domainUnit.open();

      const leafQuestions = (d.questions ?? []).slice(0, orch.maxLeafFanOut);
      const childReceiptPaths: string[] = [];

      if (leafQuestions.length > 0 && orch.maxDepth >= 2) {
        const leafTasks = leafQuestions.map((q, li) => {
          metrics.leafStarts += 1;
          const leafNodeId = `leaf-${d.id}-${li + 1}`;
          const leafUnit = attachWorkUnitSink(events, {
            unitId: leafNodeId,
            role: "leaf",
            task: q.slice(0, 2000),
            parentId: domainNodeId,
            runId: input.runId,
          });
          leafUnit.open();
          return {
            leafNodeId,
            leafUnit,
            input: {
              role: "leaf" as const,
              unitId: leafNodeId,
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
              onPiEvent: leafUnit.onPiEvent,
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
            const leafUnit = leafTasks[i]!.leafUnit;
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
            leafUnit.settle(lr.summary.slice(0, 4000), {
              receiptPath: persisted.relativePath,
            });
          }
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            return cancelledResult(spec, fixture, metrics);
          }
          for (const t of leafTasks) {
            t.leafUnit.fail(err instanceof Error ? err.message : String(err));
          }
        }
      }

      try {
        const domainResult = await runChildSession({
          role: "domain",
          unitId: domainNodeId,
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
          onPiEvent: domainUnit.onPiEvent,
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
        domainUnit.settle(domainResult.summary.slice(0, 4000), {
          receiptPath: persisted.relativePath,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return cancelledResult(spec, fixture, metrics);
        }
        const msg = err instanceof Error ? err.message : String(err);
        domainUnit.fail(msg);
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
      maxContextTokens: input.maxContextTokens ?? input.models?.writer?.maxContextTokens,
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
          const reviewerId = `reviewer-${i + 1}`;
          // Distinct unitId per review round so fold last-by-unitId stays truthful.
          const unitId = `${reviewerId}-r${round}`;
          const unit = attachWorkUnitSink(events, {
            unitId,
            role: "reviewer",
            task: `Review round ${round}`,
            parentId: "root",
            runId: input.runId,
          });
          unit.open();
          reviewers.push({
            id: reviewerId,
            text: JSON.stringify({
              clean: true,
              defects: [],
              summary: "NO_DEFECTS",
            }),
          });
          unit.settle("NO_DEFECTS");
        }
      } else {
        for (let i = 0; i < councilSize; i++) {
          const reviewerId = `reviewer-${i + 1}`;
          const unitId = `${reviewerId}-r${round}`;
          const lens = lenses[i % lenses.length]!;
          const unit = attachWorkUnitSink(events, {
            unitId,
            role: "reviewer",
            task: `Review lens: ${lens}`,
            parentId: "root",
            runId: input.runId,
          });
          unit.open();
          try {
            const child = await runChildSession({
              role: "reviewer",
              unitId,
              runWorkDir: input.runWorkDir,
              task: reviewerPrompt({ pages: produced.pages, lens }),
              model: input.models.reviewer.model,
              modelRuntime: input.models.reviewer.modelRuntime,
              maxContextTokens: input.models.reviewer.maxContextTokens,
              contextTargetTokens,
              workspaceRoot: input.workspace.rootPath,
              sourceIgnores: input.sourceIgnores,
              abortSignal: input.abortSignal,
              onPiEvent: unit.onPiEvent,
            });
            reviewers.push({ id: reviewerId, text: child.summary });
            unit.settle(child.summary.slice(0, 4000));
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
              return cancelledResult(spec, fixture, metrics, produced);
            }
            // Fail-closed: reviewer error is a blocking defect, not clean.
            const msg = err instanceof Error ? err.message : String(err);
            reviewers.push({
              id: reviewerId,
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
            unit.fail(msg);
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

      const blocking = (spec.acceptance?.blockingSeverities ?? ["blocking"]) as string[];
      const hasBlocking = defects.defects.some((d) => blocking.includes(d.severity));
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
        .map((d) => `- [${d.severity}] ${d.path ?? "?"} ${d.code ?? ""}: ${d.issue}`)
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
          maxContextTokens: input.maxContextTokens ?? input.models?.writer?.maxContextTokens,
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
