/**
 * Fixture Produce path — no LLM; deterministic staging + clean review receipt.
 */

import {
  WikiRunSpecSchema,
  type WikiRunPlan,
  type WikiRunSpec,
} from "@okf-wiki/contract";
import {
  hasProviderCredentials,
  loadProviderConfig,
} from "@okf-wiki/core";
import { writeMergedDefects } from "../defects.js";
import { listMarkdownPages, writeFileContained } from "../fs-ops.js";
import { emitRunPhase, emitSourcesIndex } from "../run-timeline.js";
import { writeWikiRunSpec } from "../spec-store.js";
import {
  emitDefectsFromWriter,
  emitPlanProgressFromWriter,
} from "./stream-emit.js";
import {
  sleep,
  successStatus,
  throwIfAborted,
  type WikiRunAgentInput,
  type WikiRunAgentPhase,
  type WikiRunAgentResult,
  type WikiRunStreamWriter,
} from "./types.js";

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

export function buildFixturePlan(input: WikiRunAgentInput): WikiRunSpec {
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
 * Emit Mastra-shaped stream chunks for fixture mode so Session e2e can assert
 * tool + text parts without a live model (same seam as live fullStream).
 * Write phase also emits data-plan-progress via writer.custom (Produce only).
 */
export async function emitFixtureTrajectory(
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

export async function runFixture(
  input: WikiRunAgentInput,
  wikiRoot: string,
): Promise<WikiRunAgentResult> {
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

  // Phase chips from Produce (Session no longer synthesizes data-progress).
  if (phase === "plan") {
    await emitRunPhase(input.writer, {
      runId: input.runId,
      phase: "planning",
      plan: input.plan,
      label: "Planning wiki Spec",
    });
  } else {
    await emitRunPhase(input.writer, {
      runId: input.runId,
      phase: "writing",
      plan: input.plan,
      writtenPaths: [],
      label: "Writing wiki pages",
    });
    // Pending checklist so UI has pages before first write_wiki lands.
    await emitPlanProgressFromWriter(input.writer, {
      plan: input.plan,
      writtenPaths: [],
      runId: input.runId,
      phase: "writing",
    });
  }

  await emitFixtureTrajectory(input.writer, phase, input.abortSignal, {
    plan: input.plan,
    runId: input.runId,
    writePath: pagePath,
  });

  if (phase === "plan") {
    const plan = buildFixturePlan(input);
    await emitRunPhase(input.writer, {
      runId: input.runId,
      phase: "planning",
      plan,
      label: "Spec ready for confirmation",
    });
    // Spec checklist at plan gate (all pending until write phase).
    await emitPlanProgressFromWriter(input.writer, {
      plan,
      writtenPaths: [],
      runId: input.runId,
      phase: "planning",
    });
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
    await emitRunPhase(input.writer, {
      runId: input.runId,
      phase: "writing",
      plan,
      writtenPaths: pages,
    });
    await emitRunPhase(input.writer, {
      runId: input.runId,
      phase: "reviewing",
      plan,
      writtenPaths: pages,
    });
    await emitDefectsFromWriter(input.writer, {
      runId: input.runId,
      round: 1,
      merged: cleanReport,
    });
    await emitSourcesIndex(input.writer, {
      runId: input.runId,
      sources: [{ path: "README.md", sourceId: primarySource?.id }],
    });
    await emitRunPhase(input.writer, {
      runId: input.runId,
      phase: "done",
      plan,
      writtenPaths: pages,
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
