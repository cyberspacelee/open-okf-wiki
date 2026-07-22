/**
 * Host-owned review council + repair loop after Root write phase.
 * Fail-closed publishability scoring; terminal status is still owned by Host
 * hard-validate in the thin workflow shell (ADR 0028 / 0029).
 */

import type { Agent, AgentMemoryOption } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { validateWikiTree } from "@okf-wiki/core";
import {
  evaluateWikiPublishable,
  hasBlockingDefects,
} from "../defects.js";
import { listMarkdownPages } from "../fs-ops.js";
import { runReviewCouncil } from "../review-council.js";
import { redactErrorMessage } from "../run-redact.js";
import { emitRunPhase } from "../run-timeline.js";
import { isRunCancelledError } from "../session-turn/cancel.js";
import type { SubagentBundle } from "../subagents.js";
import {
  emitDefectsFromWriter,
  writeCustomDataPart,
} from "./stream-emit.js";
import {
  successStatus,
  throwIfAborted,
  type WikiRunAgentInput,
  type WikiRunAgentResult,
} from "./types.js";

/** Default repair rounds when Spec.acceptance.maxRepairRounds is unset. */
export const DEFAULT_ORCHESTRATION_REPAIR_ROUNDS = 2;

export type ReviewRepairInput = {
  agent: Agent;
  subagents: SubagentBundle;
  pages: string[];
  wikiRoot: string;
  input: WikiRunAgentInput;
  maxSteps: number;
  text: string;
  runMemory: Memory | undefined;
  rootMemoryOpt: { memory: AgentMemoryOption } | Record<string, never>;
  // Cast: Mastra DelegationConfig message types are framework-internal.
  delegation: unknown;
};

/**
 * Run review council, optional repair rounds, then host publishability gate.
 * Returns a terminal WikiRunAgentResult for the write phase.
 */
export async function runReviewAndRepair(
  params: ReviewRepairInput,
): Promise<WikiRunAgentResult> {
  const {
    agent,
    subagents,
    wikiRoot,
    input,
    maxSteps,
    text,
    runMemory,
    rootMemoryOpt,
    delegation,
  } = params;
  let pages = params.pages;

  const maxRepairRounds =
    input.plan?.acceptance?.maxRepairRounds ??
    DEFAULT_ORCHESTRATION_REPAIR_ROUNDS;
  const blockingSeverities =
    input.plan?.acceptance?.blockingSeverities ?? ["blocking"];
  let reviewRound = 0;
  let reviewClean = false;
  let lastDefectSummary = "";

  await emitRunPhase(input.writer, {
    runId: input.runId,
    phase: "reviewing",
    plan: input.plan,
    writtenPaths: pages,
  });

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
      if (isRunCancelledError(reviewError) || input.abortSignal?.aborted) {
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
      !hasBlockingDefects(
        merged,
        blockingSeverities as ("blocking" | "major" | "minor")[],
      );

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

    await emitRunPhase(input.writer, {
      runId: input.runId,
      phase: "repairing",
      plan: input.plan,
      writtenPaths: pages,
      defectCount: merged.defects.length,
    });

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
      if (isRunCancelledError(repairError) || input.abortSignal?.aborted) {
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

  // Publishability score informs repair exit; Host hard-validate is still the
  // terminal gate in the thin workflow shell.
  const scored = await evaluateWikiPublishable({
    wikiRoot,
    workspaceRoot: input.workspace.rootPath,
    runId: input.runId,
    sources: input.workspace.sources.map((s) => ({ id: s.id, path: s.path })),
    spec: input.plan,
    requireReviewReceipt: true,
  });
  if (!scored.publishable) {
    await emitRunPhase(input.writer, {
      runId: input.runId,
      phase: "failed",
      plan: input.plan,
      writtenPaths: scored.pages,
      failed: true,
      label: scored.reasons.slice(0, 2).join("; "),
    });
    return {
      status: "failed",
      error: `host publishability gate failed: ${scored.reasons.join("; ")}`,
      pages: scored.pages,
      summary: text?.slice(0, 400) || undefined,
      plan: input.plan,
    };
  }

  await emitRunPhase(input.writer, {
    runId: input.runId,
    phase: "done",
    plan: input.plan,
    writtenPaths: scored.pages,
  });

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
