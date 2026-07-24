/**
 * Real Pi custom tool that owns one complete Wiki Run (ADR 0032).
 *
 * Pi owns the tool lifecycle. This implementation never appends Session
 * messages and never fabricates message_* / tool_execution_* events.
 */

import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  defineTool,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type WikiProduceToolDetails,
  type WikiRunSpec,
  WikiRunSpecSchema,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { freezeWikiRun, publishStagingToPublication, updateRunRecord } from "@okf-wiki/core";
import { runWorkdirLayout } from "../../pi/run-workdir.js";
import { redactErrorMessage } from "../../run-redact.js";
import { writeWikiRunSpec } from "../../spec-store.js";
import { shouldUsePiFixtureMode } from "../live-pi.js";
import { type ProduceWikiModels, produceWiki } from "../orchestrate.js";
import { planWikiSpec } from "../plan.js";

export const WIKI_PRODUCE_TOOL_NAME = "wiki_produce" as const;

export type WikiProduceModelRole = "writer" | "planner" | "worker" | "reviewer";

export type WikiProduceModelFactory = (
  role: WikiProduceModelRole,
  workspace: WorkspaceConfig,
) => Promise<{
  model: Model<any>;
  modelRuntime?: ModelRuntime;
  maxContextTokens?: number;
}>;

export type WikiProduceGateDecision = {
  action: "approve" | "deny" | "revise";
  feedback?: string;
  spec?: WikiRunSpec;
};

export type WikiProduceGateRequest = {
  toolCallId: string;
  runId: string;
  gate: "plan" | "publication";
  spec: WikiRunSpec;
  pages: string[];
};

export type WikiProduceGateCoordinator = {
  waitForDecision(
    request: WikiProduceGateRequest,
    signal?: AbortSignal,
  ): Promise<WikiProduceGateDecision>;
};

export type { WikiProduceToolDetails, WikiProduceToolStatus } from "@okf-wiki/contract";

export type CreateWikiProduceToolInput = {
  /** Bootstrap snapshot used when no live resolver is provided. */
  workspace: WorkspaceConfig;
  /** Resolve once when execute begins so a long-lived Session sees saved Workspace edits. */
  resolveWorkspace?: () => Promise<WorkspaceConfig>;
  sessionId: string;
  gateCoordinator: WikiProduceGateCoordinator;
  resolveModel?: WikiProduceModelFactory;
  /** Explicit no-model path for tests and smoke runs. */
  fixture?: boolean;
  /** Trusted caller choice; never exposed as a model-controlled tool argument. */
  autoApprove?: boolean;
};

const wikiProduceParameters = Type.Object(
  {
    notes: Type.Optional(
      Type.String({
        description: "Optional operator-requested focus for this Wiki Run.",
        maxLength: 4000,
      }),
    ),
  },
  { additionalProperties: false },
);

function abortError(): Error {
  const error = new Error("Wiki Run cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function awaitGate(
  coordinator: WikiProduceGateCoordinator,
  request: WikiProduceGateRequest,
  signal?: AbortSignal,
): Promise<WikiProduceGateDecision> {
  throwIfAborted(signal);
  if (!signal) return coordinator.waitForDecision(request);

  return new Promise<WikiProduceGateDecision>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void coordinator.waitForDecision(request, signal).then(
      (decision) => {
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function resolveModels(
  factory: WikiProduceModelFactory | undefined,
  fixture: boolean,
  workspace: WorkspaceConfig,
): Promise<
  ProduceWikiModels & {
    planner?: Awaited<ReturnType<WikiProduceModelFactory>>;
  }
> {
  if (fixture) return {};
  if (!factory) {
    throw new Error("Live wiki_produce requires a model resolver");
  }
  const writer = await factory("writer", workspace);
  const [planner, worker, reviewer] = await Promise.all([
    factory("planner", workspace).catch(() => writer),
    factory("worker", workspace).catch(() => writer),
    factory("reviewer", workspace).catch(() => writer),
  ]);
  return { writer, planner, worker, reviewer };
}

function toolResult(details: WikiProduceToolDetails) {
  const text =
    details.summary?.trim() ||
    (details.runId
      ? `Wiki Run ${details.runId}: ${details.status}`
      : `wiki_produce: ${details.status}`);
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function mergeNotes(...parts: Array<string | undefined>): string | undefined {
  let merged = "";
  for (const part of parts) {
    const next = part?.trim();
    if (!next || merged.includes(next)) continue;
    merged = merged ? `${merged}\n\n${next}` : next;
  }
  return merged.slice(0, 4000) || undefined;
}

/** Build the LLM-callable Pi tool. One execute owns one complete Wiki Run. */
export function createWikiProduceTool(
  input: CreateWikiProduceToolInput,
): ToolDefinition<typeof wikiProduceParameters, WikiProduceToolDetails> {
  return defineTool({
    name: WIKI_PRODUCE_TOOL_NAME,
    label: "Produce wiki",
    description:
      "Create or refresh the source-grounded repository Wiki. Use when the operator asks to produce, build, regenerate, or refresh the Wiki.",
    promptSnippet: "Produce the repository Wiki with plan and publication approval gates",
    parameters: wikiProduceParameters,
    async execute(toolCallId, args, signal, onUpdate) {
      let runId: string | undefined;
      let workspace = input.workspace;
      let details: WikiProduceToolDetails = { status: "freezing" };
      const update = (patch: Partial<WikiProduceToolDetails>): void => {
        details = { ...details, ...patch };
        try {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: details.summary ?? details.status,
              },
            ],
            details,
          });
        } catch {
          // A display subscriber must not break the Wiki Run.
        }
      };

      update({ summary: "Freezing Repository Snapshot Set and Producer Skill" });

      try {
        throwIfAborted(signal);
        workspace = input.resolveWorkspace ? await input.resolveWorkspace() : input.workspace;
        throwIfAborted(signal);
        const fixture = input.fixture ?? shouldUsePiFixtureMode({});
        const frozen = await freezeWikiRun({
          workspace,
          sessionId: input.sessionId,
          autoApprove: input.autoApprove === true,
        });
        runId = frozen.runId;
        const runWorkDir = path.dirname(frozen.skillPath);
        const layout = runWorkdirLayout(runWorkDir, frozen.sourcePathMap);
        const models = await resolveModels(input.resolveModel, fixture, workspace);
        const operatorNotes = args.notes?.trim();

        const runPlanner = async (
          priorSpec?: WikiRunSpec,
          revisionFeedback?: string,
        ): Promise<WikiRunSpec> => {
          update({
            runId,
            status: "planning",
            summary: priorSpec
              ? "Re-planning WikiRunSpec from frozen sources"
              : "Planning WikiRunSpec from frozen sources",
          });
          const planned = await planWikiSpec({
            layout,
            workspaceName: workspace.name,
            wikiLanguage: workspace.wikiLanguage,
            fixture,
            useDefaultSpec: fixture,
            model: models.planner?.model ?? models.writer?.model,
            modelRuntime: models.planner?.modelRuntime ?? models.writer?.modelRuntime,
            maxContextTokens: models.planner?.maxContextTokens ?? models.writer?.maxContextTokens,
            contextTargetTokens: workspace.limits?.contextTargetTokens,
            sourceIgnores: frozen.sourceIgnores,
            abortSignal: signal,
            operatorNotes,
            priorSpec,
            revisionFeedback,
          });
          const feedback = revisionFeedback?.trim();
          return WikiRunSpecSchema.parse({
            ...planned.spec,
            notes: mergeNotes(
              planned.spec.notes?.trim(),
              operatorNotes,
              feedback ? `Operator revision feedback:\n${feedback}` : undefined,
            ),
            changelog: [
              ...planned.spec.changelog,
              ...(operatorNotes && !priorSpec ? ["Operator notes supplied to wiki_produce"] : []),
              ...(priorSpec ? ["Planner re-ran after operator revision"] : []),
            ].slice(-40),
          });
        };

        let spec = await runPlanner();
        await writeWikiRunSpec(workspace.rootPath, runId, spec);

        const requirePlanGate = input.autoApprove !== true && workspace.planConfirm !== false;
        if (requirePlanGate) {
          for (;;) {
            await updateRunRecord(workspace.rootPath, runId, {
              status: "awaiting_plan",
              spec,
              summary: "Awaiting WikiRunSpec approval",
            });
            update({
              status: "awaiting_plan",
              spec,
              summary: "Awaiting WikiRunSpec approval",
            });
            const decision = await awaitGate(
              input.gateCoordinator,
              { toolCallId, runId, gate: "plan", spec, pages: [] },
              signal,
            );
            if (decision.action === "deny") {
              await updateRunRecord(workspace.rootPath, runId, {
                status: "cancelled",
                spec,
                summary: "WikiRunSpec declined by operator",
              });
              details = {
                ...details,
                status: "cancelled",
                summary: "WikiRunSpec declined by operator",
              };
              return toolResult(details);
            }
            if (decision.action === "revise") {
              const prior = decision.spec ? WikiRunSpecSchema.parse(decision.spec) : spec;
              spec = await runPlanner(
                prior,
                decision.feedback?.trim() || "Re-evaluate the WikiRunSpec against frozen sources.",
              );
              await writeWikiRunSpec(workspace.rootPath, runId, spec);
              continue;
            }
            if (decision.spec) {
              spec = WikiRunSpecSchema.parse(decision.spec);
              await writeWikiRunSpec(workspace.rootPath, runId, spec);
            }
            break;
          }
        }

        await updateRunRecord(workspace.rootPath, runId, {
          status: "running",
          spec,
          summary: "Producing Wiki",
        });
        update({
          status: "producing",
          spec,
          summary: "Producing and reviewing Wiki",
        });

        const produced = await produceWiki({
          runId,
          workspace,
          layout,
          spec,
          fixture,
          abortSignal: signal,
          models,
          maxContextTokens: models.writer?.maxContextTokens,
          contextTargetTokens: workspace.limits?.contextTargetTokens,
          additionalSkillPaths: [frozen.skillPath],
          sourceIgnores: frozen.sourceIgnores,
          onEvent: {
            progress: (progress) => {
              update({
                status: "producing",
                summary: progress.label ?? `Wiki production: ${progress.phase}`,
              });
            },
            planProgress: (progress) =>
              update({
                pages: progress.pages.filter((p) => p.status === "done").map((p) => p.path),
              }),
            defects: (defects) =>
              update({
                summary:
                  defects.summary ??
                  `Review round ${defects.round}: ${defects.defectCount} defect(s)`,
              }),
          },
        });

        if (produced.status === "cancelled") throw abortError();
        if (produced.status === "failed" || !produced.publishability.publishable) {
          const summary = produced.summary || produced.publishability.reasons.join("; ");
          await updateRunRecord(workspace.rootPath, runId, {
            status: "failed",
            spec: produced.spec,
            pages: produced.pages,
            summary,
            error: summary,
          });
          details = {
            ...details,
            status: "failed",
            spec: produced.spec,
            pages: produced.pages,
            summary,
            defects: produced.defects,
          };
          return toolResult(details);
        }

        const pages = produced.pages;
        spec = produced.spec;
        if (input.autoApprove !== true) {
          await updateRunRecord(workspace.rootPath, runId, {
            status: "awaiting_publication",
            spec,
            pages,
            summary: produced.summary,
          });
          update({
            status: "awaiting_publication",
            spec,
            pages,
            summary: "Awaiting publication approval",
            defects: produced.defects,
          });
          const decision = await awaitGate(
            input.gateCoordinator,
            { toolCallId, runId, gate: "publication", spec, pages },
            signal,
          );
          if (decision.action !== "approve") {
            await updateRunRecord(workspace.rootPath, runId, {
              status: "publication_declined",
              spec,
              pages,
              summary: "Publication declined; Staging Wiki retained",
            });
            details = {
              ...details,
              status: "publication_declined",
              summary: "Publication declined; Staging Wiki retained",
            };
            return toolResult(details);
          }
        }

        throwIfAborted(signal);
        const publicationPath = workspace.publicationPath ?? path.join(workspace.rootPath, "wiki");
        await publishStagingToPublication({
          stagingDir: produced.layout.wikiDir,
          publicationPath,
          runId,
          // Citation validation must never consult a live checkout after freeze.
          sources: frozen.sources.map((source) => ({ id: source.id, path: source.path })),
        });
        await updateRunRecord(workspace.rootPath, runId, {
          status: "published",
          spec,
          pages,
          summary: produced.summary,
          error: null,
        });
        details = {
          ...details,
          status: "published",
          spec,
          pages,
          summary: produced.summary,
          defects: produced.defects,
        };
        return toolResult(details);
      } catch (error) {
        const cancelled =
          signal?.aborted === true ||
          (error instanceof Error &&
            (error.name === "AbortError" || /cancel/i.test(error.message)));
        const message = cancelled
          ? "Wiki Run cancelled"
          : redactErrorMessage(error instanceof Error ? error.message : String(error));
        if (runId) {
          await updateRunRecord(workspace.rootPath, runId, {
            status: cancelled ? "cancelled" : "failed",
            summary: message,
            error: cancelled ? null : message,
          }).catch(() => undefined);
        }
        details = {
          ...details,
          ...(runId ? { runId } : {}),
          status: cancelled ? "cancelled" : "failed",
          summary: message,
        };
        return toolResult(details);
      }
    },
  });
}
