/**
 * Live Produce path — Root agent assembly + stream loop + review-repair handoff.
 */

import { Agent, type AgentMemoryOption } from "@mastra/core/agent";
import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import {
  buildSourceIgnoreMap,
  validateWikiTree,
} from "@okf-wiki/core";
import {
  buildContextInputProcessors,
  resolveContextTargetForWorkspace,
} from "../context-limits.js";
import {
  buildRootDelegationOptions,
  createDelegationCounters,
} from "../delegation.js";
import { listMarkdownPages } from "../fs-ops.js";
import {
  orchestrationLimitsInstruction,
  resolveOrchestration,
} from "../limits.js";
import { resolveRoleModels } from "../role-models.js";
import {
  emitRunPhase,
  emitSourcesIndex,
  noteSourceHit,
  sourceHitsFromToolChunk,
  type SourceIndexEntry,
} from "../run-timeline.js";
import { isRunCancelledError } from "../session-turn/cancel.js";
import { writeWikiRunSpec } from "../spec-store.js";
import { createSubagents, subagentsAsAgentsMap } from "../subagents.js";
import { createWikiRunTools } from "../tools.js";
import {
  createWikiRunMemory,
  wikiRunMemoryOption,
} from "../wiki-memory.js";
import { buildInstructions } from "./instructions.js";
import { resolvePhaseMaxSteps } from "./max-steps.js";
import { parsePlanFromAgentText } from "./plan-parse.js";
import { runReviewAndRepair } from "./review-repair.js";
import {
  emitPlanProgressFromWriter,
  hasStreamCustom,
  toolNameFromAgentChunk,
  writePathFromAgentChunk,
} from "./stream-emit.js";
import {
  buildSourceMap,
  normalizeWikiPath,
  throwIfAborted,
  type WikiRunAgentInput,
  type WikiRunAgentPhase,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
} from "./types.js";

export async function runLive(
  input: WikiRunAgentInput,
  wikiRoot: string,
  skillRoot: string,
): Promise<WikiRunAgentResult> {
  const sources = buildSourceMap(input.workspace);
  // Freeze Effective Source Ignores at run start (defaults + per-source user ignore).
  // Source tools enforce this map for the whole Wiki generation loop.
  const sourceIgnores = buildSourceIgnoreMap(input.workspace.sources);
  // Discrete path-policy tools only (no CodeMode / no shell).
  const tools = createWikiRunTools({
    sources,
    sourceIgnores,
    skillRoot,
    wikiRoot,
    workspaceRoot: input.workspace.rootPath,
    runId: input.runId,
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
  // writer is available later; re-bound after we have input.writer in stream opts.
  // Delegation hooks close over a mutable holder so emit works once stream starts.
  const writerHolder: { current: WikiRunStreamWriter | undefined } = {
    current: input.writer,
  };
  const delegation = buildRootDelegationOptions({
    orchestration: orch,
    counters: delegationCounters,
    runId: input.runId,
    writer: {
      write: async (chunk) => {
        const w = writerHolder.current;
        if (w) {
          await w.write(chunk);
        }
      },
      custom: async (chunk) => {
        const w = writerHolder.current;
        if (w && hasStreamCustom(w)) {
          await w.custom(chunk);
        } else if (w) {
          await w.write(chunk);
        }
      },
    },
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
  const rootMemoryOpt: { memory: AgentMemoryOption } | Record<string, never> =
    runMemory
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
  const sourceHits = new Map<string, SourceIndexEntry>();
  let lastSourcesEmit = 0;
  writerHolder.current = input.writer;

  await emitRunPhase(input.writer, {
    runId: input.runId,
    phase: phase === "plan" ? "planning" : "researching",
    plan: input.plan,
  });

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
          if (
            phase === "write" &&
            toolName === "write_wiki" &&
            writtenPaths.size === 0
          ) {
            await emitRunPhase(input.writer, {
              runId: input.runId,
              phase: "writing",
              plan: input.plan,
              writtenPaths,
            });
          }
        }
        for (const hit of sourceHitsFromToolChunk(chunk)) {
          noteSourceHit(sourceHits, hit);
        }
        if (sourceHits.size > 0 && sourceHits.size - lastSourcesEmit >= 3) {
          lastSourcesEmit = sourceHits.size;
          await emitSourcesIndex(input.writer, {
            runId: input.runId,
            sources: [...sourceHits.values()],
          });
        }
        if (phase === "write") {
          const pathValue = writePathFromAgentChunk(chunk);
          if (pathValue && !writtenPaths.has(pathValue)) {
            writtenPaths.add(pathValue);
            await emitPlanProgressFromWriter(input.writer, {
              plan: input.plan,
              writtenPaths,
              runId: input.runId,
              phase: "writing",
            });
            await emitRunPhase(input.writer, {
              runId: input.runId,
              phase: "writing",
              plan: input.plan,
              writtenPaths,
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
    if (isRunCancelledError(streamError) || input.abortSignal?.aborted) {
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
    await emitSourcesIndex(input.writer, {
      runId: input.runId,
      sources: [...sourceHits.values()],
    });
    await emitRunPhase(input.writer, {
      runId: input.runId,
      phase: "planning",
      label: "Spec ready for confirmation",
      plan,
    });
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

  await emitSourcesIndex(input.writer, {
    runId: input.runId,
    sources: [...sourceHits.values()],
  });

  return runReviewAndRepair({
    agent,
    subagents,
    pages,
    wikiRoot,
    input,
    maxSteps,
    text,
    runMemory,
    rootMemoryOpt,
    delegation,
  });
}
