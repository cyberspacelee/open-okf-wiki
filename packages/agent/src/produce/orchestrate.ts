/**
 * Deep Produce module (Layer B Semantic Workflow body, ADR 0028 / 0030).
 *
 * wiki_produce-driven: approved Spec → Domain/Leaf research + receipts →
 * root_write → review council → repair* → evaluateWikiPublishable.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  MergedDefectReport,
  WikiProduceChildSpan,
  WikiProduceToolDetails,
  WikiRunSpec,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { evaluateWikiPublishable, type PublishabilityResult } from "../defects.js";
import { resolveOrchestration } from "../limits.js";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import { runReviewCouncil } from "../review-council.js";
import { writeWikiRunSpec } from "../spec-store.js";
import { runChildrenParallel, runChildSession } from "./children.js";
import {
  listWikiMarkdown,
  type ProduceWithPiResult,
  produceWithPi,
  shouldUsePiFixtureMode,
} from "./live-pi.js";
import { domainResearchPrompt, leafResearchPrompt, reviewerPrompt } from "./prompts.js";
import { buildReceiptIndex, persistResearchReceipt } from "./receipts.js";

/** Coarse progress into the owning wiki_produce tool (Pi onUpdate details). */
export type ProduceUpdatePatch = Partial<WikiProduceToolDetails>;

export type ProduceWikiModels = {
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
  /** Existing frozen Run Boundary layout. */
  layout: RunWorkdirLayout;
  /** Already-approved living Spec. */
  spec: WikiRunSpec;
  models?: ProduceWikiModels;
  fixture?: boolean;
  abortSignal?: AbortSignal;
  additionalSkillPaths?: readonly string[];
  maxContextTokens?: number;
  contextTargetTokens?: number;
  /** Optional patch sink for the owning wiki_produce tool (and tests). */
  onUpdatePatch?: (patch: ProduceUpdatePatch) => void;
  /** Optional child span projection for details.children. */
  onChildProgress?: (span: WikiProduceChildSpan) => void;
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

function emitPatch(
  onUpdatePatch: ProduceWikiInput["onUpdatePatch"],
  patch: ProduceUpdatePatch,
): void {
  try {
    onUpdatePatch?.(patch);
  } catch {
    // Display subscribers must not break the Wiki Run.
  }
}

async function emitPlanProgressFromDisk(
  onUpdatePatch: ProduceWikiInput["onUpdatePatch"],
  wikiDir: string,
  spec: WikiRunSpec,
): Promise<void> {
  const existing = new Set(await listWikiMarkdown(wikiDir));
  const done = (spec.pages ?? [])
    .map((p) => p.path)
    .filter((pagePath) => existing.has(pagePath.replace(/^\.?\//, "")));
  emitPatch(onUpdatePatch, { pages: done });
}

/**
 * Layer B Produce: research → write → council → repair → hard score.
 */
export async function produceWiki(input: ProduceWikiInput): Promise<ProduceWikiResult> {
  throwIfAborted(input.abortSignal);
  const patch = input.onUpdatePatch;
  const onChild = input.onChildProgress;
  const orch = resolveOrchestration(input.workspace);
  const fixture = shouldUsePiFixtureMode({ fixture: input.fixture });
  const metrics = { domainStarts: 0, leafStarts: 0, repairRounds: 0 };
  const multiSource = (input.workspace.sources?.length ?? 0) > 1;
  const wikiLanguage = input.workspace.wikiLanguage ?? "en";
  const contextTargetTokens =
    input.contextTargetTokens ?? input.workspace.limits?.contextTargetTokens;
  const { layout, spec } = input;

  await writeWikiRunSpec(input.workspace.rootPath, input.runId, spec);
  await emitPlanProgressFromDisk(patch, layout.wikiDir, spec);

  // 3) Domain + Leaf research with receipts.
  const criticalDomainFailures: string[] = [];
  emitPatch(patch, { status: "producing", summary: "domain + leaf research" });
  const domains = (spec.domains ?? []).slice(0, orch.maxDomainFanOut);
  const workerModel = input.models?.worker ?? input.models?.writer;

  for (const d of domains) {
    throwIfAborted(input.abortSignal);
    metrics.domainStarts += 1;
    const domainNodeId = `domain-${d.id}`;

    const leafQuestions = (d.questions ?? []).slice(0, orch.maxLeafFanOut);
    const childReceiptPaths: string[] = [];

    if (leafQuestions.length > 0 && orch.maxDepth >= 2) {
      const leafTasks = leafQuestions.map((q, li) => {
        metrics.leafStarts += 1;
        const leafNodeId = `leaf-${d.id}-${li + 1}`;
        return {
          leafNodeId,
          input: {
            role: "leaf" as const,
            spanId: leafNodeId,
            runWorkDir: layout.runWorkDir,
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
            sourceIgnores: input.sourceIgnores,
            abortSignal: input.abortSignal,
            onProgress: onChild,
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
            runId: input.runId,
            nodeId: leafNodeId,
            parentId: domainNodeId,
            scope: `${d.id}: ${leafQuestions[i]}`,
            summary: lr.summary,
            status: "complete",
          });
          childReceiptPaths.push(persisted.relativePath);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return cancelledResult(spec, fixture, metrics, layout);
        }
      }
    }

    try {
      const domainResult = await runChildSession({
        role: "domain",
        spanId: domainNodeId,
        runWorkDir: layout.runWorkDir,
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
        sourceIgnores: input.sourceIgnores,
        abortSignal: input.abortSignal,
        onProgress: onChild,
      });
      await persistResearchReceipt({
        workspaceRoot: input.workspace.rootPath,
        runId: input.runId,
        nodeId: domainNodeId,
        parentId: "root",
        scope: d.scope ?? d.title ?? d.id,
        summary: domainResult.summary,
        status: "complete",
        childReceipts: childReceiptPaths,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return cancelledResult(spec, fixture, metrics, layout);
      }
      const msg = err instanceof Error ? err.message : String(err);
      await persistResearchReceipt({
        workspaceRoot: input.workspace.rootPath,
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

  if (criticalDomainFailures.length > 0 && !fixture) {
    emitPatch(patch, {
      status: "producing",
      summary: `critical domain research failed: ${criticalDomainFailures[0]}`,
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
  emitPatch(patch, { status: "producing", summary: "root_write" });
  const receiptIndex = await buildReceiptIndex(input.workspace.rootPath, input.runId);
  let produced: ProduceWithPiResult;
  try {
    produced = await produceWithPi({
      layout,
      spec,
      workspaceName: input.workspace.name,
      fixture,
      abortSignal: input.abortSignal,
      model: input.models?.writer?.model,
      modelRuntime: input.models?.writer?.modelRuntime,
      maxContextTokens: input.maxContextTokens ?? input.models?.writer?.maxContextTokens,
      contextTargetTokens,
      additionalSkillPaths: input.additionalSkillPaths,
      sourceIgnores: input.sourceIgnores,
      wikiLanguage,
      multiSource,
      receiptIndex,
      onProgress: onChild,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return cancelledResult(spec, fixture, metrics, layout);
    }
    throw err;
  }

  await emitPlanProgressFromDisk(patch, produced.layout.wikiDir, spec);
  emitPatch(patch, {
    status: "producing",
    summary: `root_write complete (${produced.pages.length} pages)`,
    pages: produced.pages,
  });

  // 5) Review + repair loop
  let defects: MergedDefectReport | null = null;
  const maxRepair = Math.max(0, spec.acceptance?.maxRepairRounds ?? 2);
  const councilSize = Math.max(1, orch.reviewCouncilSize ?? 1);
  const lenses = ["grounding", "coverage", "consistency", "general"] as const;

  for (let round = 1; round <= maxRepair + 1; round++) {
    throwIfAborted(input.abortSignal);
    emitPatch(patch, {
      status: "producing",
      summary: `review council round ${round}`,
    });

    const reviewers: Array<{ id: string; text: string }> = [];
    if (fixture || !input.models?.reviewer?.model) {
      for (let i = 0; i < councilSize; i++) {
        const reviewerId = `reviewer-${i + 1}`;
        reviewers.push({
          id: reviewerId,
          text: JSON.stringify({
            clean: true,
            defects: [],
            summary: "NO_DEFECTS",
          }),
        });
      }
    } else {
      for (let i = 0; i < councilSize; i++) {
        const reviewerId = `reviewer-${i + 1}`;
        const lens = lenses[i % lenses.length]!;
        try {
          const child = await runChildSession({
            role: "reviewer",
            spanId: `${reviewerId}-${lens}`,
            runWorkDir: layout.runWorkDir,
            task: reviewerPrompt({ pages: produced.pages, lens }),
            model: input.models.reviewer.model,
            modelRuntime: input.models.reviewer.modelRuntime,
            maxContextTokens: input.models.reviewer.maxContextTokens,
            contextTargetTokens,
            sourceIgnores: input.sourceIgnores,
            abortSignal: input.abortSignal,
            onProgress: onChild,
          });
          reviewers.push({ id: reviewerId, text: child.summary });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            return cancelledResult(spec, fixture, metrics, layout, produced);
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
    emitPatch(patch, {
      summary:
        defects.summary ??
        `Review round ${round}: ${defects.defects.length} defect(s)`,
      defects,
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
    emitPatch(patch, {
      status: "producing",
      summary: `repair round ${metrics.repairRounds} (${defects.defects.length} defects)`,
    });
    const defectText = defects.defects
      .map((d) => `- [${d.severity}] ${d.path ?? "?"} ${d.code ?? ""}: ${d.issue}`)
      .join("\n");
    try {
      produced = await produceWithPi({
        layout,
        spec,
        workspaceName: input.workspace.name,
        fixture,
        abortSignal: input.abortSignal,
        model: input.models?.writer?.model,
        modelRuntime: input.models?.writer?.modelRuntime,
        maxContextTokens: input.maxContextTokens ?? input.models?.writer?.maxContextTokens,
        contextTargetTokens,
        additionalSkillPaths: input.additionalSkillPaths,
        sourceIgnores: input.sourceIgnores,
        wikiLanguage,
        multiSource,
        receiptIndex,
        repairDefects: defectText,
        onProgress: onChild,
      });
      await emitPlanProgressFromDisk(patch, produced.layout.wikiDir, spec);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return cancelledResult(spec, fixture, metrics, layout, produced);
      }
      throw err;
    }
  }

  // 6) Hard score
  // Hard validation is bound to the run-owned Repository Snapshot Set.
  // Never re-read mutable Workspace checkout paths after freeze/materialize.
  const sources = [...layout.sourceMounts].map(([id, sourcePath]) => ({
    id,
    path: sourcePath,
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
    emitPatch(patch, {
      status: "producing",
      summary: publishability.reasons.slice(0, 3).join("; "),
      ...(defects ? { defects } : {}),
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

  emitPatch(patch, {
    status: "producing",
    summary: produced.summary,
    pages: produced.pages,
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
  layout: RunWorkdirLayout,
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
    layout: produced?.layout ?? layout,
    mode: fixture ? "fixture" : "live",
    metrics,
  };
}
