/**
 * SessionTurn — deep module for one Operator Session turn (ADR 0027 / 0029).
 *
 * Framework-first: workflow open + toAISdkStream live in the thin UI projection
 * shell (openWikiRunUiProjection). This module assembles turn params, owns outer
 * createUIMessageStream framing, mid-stream checkpoints, and finalize → product
 * Session/Run state via mapWorkflowResult. Gate chips use mapSuspendToGateUi once.
 *
 * Business Operator Events (`data-plan-progress`, `data-progress`, defects,
 * agent spans, sources) are emitted only by Produce (writer.custom). Session
 * forwards the framework UI stream and product shell parts (`data-gate`,
 * `data-plan`, `data-run`) — it does not synthesize business progress.
 *
 * AI SDK persistence: server owns history; client sends last message only.
 * No Session-local Staging materialize; no hand-rolled Mastra→SSE projection.
 */

import { randomUUID } from "node:crypto";
import {
  createUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type {
  OperatorSession,
  PendingInteraction,
  SessionMessage,
  SessionWorkflowState,
} from "@okf-wiki/contract";
import {
  helpTextForSessionTurn,
  mapSuspendToGateUi,
  normalizeSessionUserText,
  resolveSessionTurnMode,
} from "@okf-wiki/contract";
import { transition } from "@okf-wiki/core";
import { redactErrorMessage } from "../run-redact.js";
import { uiMessagesToSessionMessages } from "../session-messages.js";
import { projectSessionMessages } from "../ui-projection.js";
import {
  extractSuspendGate,
  isDurableRunStatus,
  mapWorkflowResult,
  sessionViewFromTerminal,
} from "../workflow-result.js";
import { openWikiRunUiProjection } from "../workflow-ui-stream.js";
import { isRunCancelledError } from "./cancel.js";
import {
  applyChunkToAcc,
  createStreamPartAcc,
  partsFromAcc,
  pipeUiStream,
} from "./stream-pipe.js";
import type {
  CreateSessionTurnStreamInput,
  SessionStreamResult,
  SessionStreamSideEffects,
} from "./types.js";

// Re-export shared policy + message bridge for agent package consumers.
export {
  helpTextForSessionTurn,
  isKickoff,
  isKickoffPhrase,
  normalizeSessionUserText,
  resolveSessionTurnMode,
  type SessionTurnHelpReason,
  type SessionTurnModeResult,
} from "@okf-wiki/contract";
export {
  sessionMessagesToUIMessages,
  uiMessagesToSessionMessages,
} from "../session-messages.js";
export { isRunCancelledError } from "./cancel.js";
export { planToMarkdown } from "./plan.js";
export type {
  CreateSessionTurnStreamInput,
  SessionStreamBody,
  SessionStreamResult,
  SessionStreamSideEffects,
  SessionTurnHooks,
} from "./types.js";

function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") {
      continue;
    }
    for (const p of m.parts ?? []) {
      if (p.type === "text" && typeof p.text === "string") {
        return p.text.trim();
      }
    }
  }
  return "";
}

/**
 * Stream one Session turn: start or resume the wiki-run workflow via official AI SDK bridge.
 * Caller must pass full `messages` (server history + new user message).
 */
export async function createSessionTurnStream(
  input: CreateSessionTurnStreamInput,
): Promise<SessionStreamResult> {
  const assistantId = randomUUID();
  const textId = randomUUID();
  let finalText = "";
  let pending: PendingInteraction | null = null;
  let status: OperatorSession["status"] = "active";
  let workflow: Partial<SessionWorkflowState> = {
    ...input.session.workflow,
  };
  let sideEffects: SessionStreamSideEffects | undefined;
  const toolParts: SessionMessage["parts"] = [];
  /** Structured data parts written during the turn (fallback if onFinish is late). */
  const dataParts: SessionMessage["parts"] = [];
  let finishedMessages: UIMessage[] | null = null;
  const streamAcc = createStreamPartAcc();
  let lastCheckpointAt = 0;

  const phase = input.session.workflow.phase ?? "idle";
  const rawUserText = lastUserText(input.messages);
  const userText = normalizeSessionUserText(rawUserText);
  const existingRunId =
    input.body?.runId ?? input.session.workflow.linkedRunId ?? undefined;

  // Explicit body only — do not reconstruct approve/deny/revise from free text.
  // Client must send intent + resumeData for gates (Codex-class structured HITL).
  let resumeData = input.body?.resumeData;
  const bodyIntent = input.body?.intent;

  // Plan gate approve/revise may need the durable plan payload.
  if (
    resumeData &&
    (resumeData.action === "approve" || resumeData.action === "revise") &&
    !resumeData.plan &&
    input.session.workflow.plan
  ) {
    const stepHint = input.body?.step ?? "";
    const atPlanGate =
      phase === "awaiting_plan" ||
      stepHint === "plan-gate" ||
      (!stepHint && phase !== "awaiting_publish");
    if (atPlanGate) {
      resumeData = { ...resumeData, plan: input.session.workflow.plan };
    }
  }

  // Normalize revise feedback from user text when client sent action + free text.
  if (
    resumeData?.action === "revise" &&
    !resumeData.feedback?.trim() &&
    userText &&
    userText.toLowerCase() !== "revise" &&
    userText !== "approve" &&
    userText !== "deny"
  ) {
    resumeData = { ...resumeData, feedback: userText };
  }

  const hasSources = (input.workspace.sources?.length ?? 0) > 0;
  const turn = resolveSessionTurnMode({
    userText,
    phase,
    status: input.session.status,
    hasSources,
    resumeData,
    existingRunId,
    intent: bodyIntent,
  });
  const mode = turn.mode;
  let runId = existingRunId ?? randomUUID();
  let resumeStep = input.body?.step;

  if (mode === "resume") {
    runId = existingRunId!;
    if (!resumeStep) {
      resumeStep =
        input.session.workflow.phase === "awaiting_publish" ||
        phase === "awaiting_publish"
          ? "publish-gate"
          : "plan-gate";
    }
  } else if (mode === "start") {
    runId = randomUUID();
  }

  // Register product cancel early (before stream execute) so Stop/cancel can
  // abort while the first chunks are still in flight.
  const abortSignal =
    mode !== "help" && input.abortSignalForRun
      ? input.abortSignalForRun(runId)
      : undefined;

  const stream = createUIMessageStream({
    // Persistence mode: stable assistant id + merge workflow parts into one bubble.
    originalMessages: input.messages,
    generateId: () => assistantId,
    onFinish: ({ messages }) => {
      finishedMessages = messages;
    },
    execute: async ({ writer }) => {
      const checkpoint = async (force = false) => {
        if (!input.onCheckpoint) {
          return;
        }
        const now = Date.now();
        // Throttle hard — concurrent disk writes corrupt session JSON without a lock,
        // and even with a lock we avoid flooding the journal.
        if (!force && now - lastCheckpointAt < 2500) {
          return;
        }
        lastCheckpointAt = now;
        const parts = partsFromAcc(finalText, dataParts, toolParts, streamAcc);
        try {
          await input.onCheckpoint({
            messages: [
              ...uiMessagesToSessionMessages(input.messages),
              {
                id: assistantId,
                role: "assistant",
                parts,
                createdAt: new Date().toISOString(),
              },
            ],
            status: status === "active" ? "running" : status,
            pending,
            workflow: {
              ...workflow,
              linkedRunId: runId,
            },
          });
        } catch {
          // never break the live stream
        }
      };

      const writeText = async (text: unknown) => {
        // Guard against object summaries (was rendering as "[object Object]").
        let body: string;
        if (typeof text === "string") {
          body = text;
        } else if (text instanceof Error) {
          body = text.message;
        } else if (text === null || text === undefined) {
          body = "";
        } else {
          try {
            body = JSON.stringify(text);
          } catch {
            body = "Wiki Run update";
          }
          if (body === "[object Object]") {
            body = "Wiki Run update";
          }
        }
        body = body.trim();
        if (!body) {
          return;
        }
        finalText += (finalText ? "\n\n" : "") + body;
        writer.write({ type: "text-start", id: textId });
        const step = 64;
        for (let i = 0; i < body.length; i += step) {
          writer.write({
            type: "text-delta",
            id: textId,
            delta: body.slice(i, i + step),
          });
        }
        writer.write({ type: "text-end", id: textId });
        await checkpoint(true);
      };

      /**
       * Product HITL gate part (not a model tool).
       * UI reads `data-gate` + `data-plan` only (ADR 0029).
       */
      const writeGate = (
        interaction: PendingInteraction,
        gate: "plan" | "publication",
      ) => {
        const partId = randomUUID();
        const data = {
          ...interaction,
          gate,
          cancelled: false as const,
        };
        writer.write({
          type: "data-gate",
          id: partId,
          data,
        } as UIMessageChunk);
        dataParts.push({
          type: "data-gate",
          id: partId,
          data,
        } as SessionMessage["parts"][number]);
        pending = { ...interaction };
        status = "waiting";
        void checkpoint(true);
      };

      const writeRunLink = (id: string, runStatus: string) => {
        const partId = randomUUID();
        const data = { runId: id, status: runStatus };
        writer.write({
          type: "data-run",
          id: partId,
          data,
        } as UIMessageChunk);
        dataParts.push({ type: "data-run", id: partId, data });
        void checkpoint(true);
      };

      const onPipedChunk = async (chunk: UIMessageChunk) => {
        applyChunkToAcc(streamAcc, chunk);
        // Produce data-* parts (plan-progress, progress, …) land via acc path.
        await checkpoint(false);
      };

      const applyWorkflowResult = async (result: unknown) => {
        const product = mapWorkflowResult(result);
        const suspend = extractSuspendGate(result);
        if (suspend) {
          // Single product map for chips (shared with session-reconcile).
          const decision = mapSuspendToGateUi(suspend);
          if (decision) {
            await writeText(decision.text);
            writeGate(decision.pending, decision.gate);
            // Structured plan for clients (no need to parse markdown).
            if (decision.plan) {
              const planPartId = randomUUID();
              writer.write({
                type: "data-plan",
                id: planPartId,
                data: decision.plan,
              } as UIMessageChunk);
              dataParts.push({
                type: "data-plan",
                id: planPartId,
                data: decision.plan,
              });
            }
            const view = sessionViewFromTerminal(product);
            workflow = {
              phase: view.workflowPhase,
              plan: decision.plan ?? input.session.workflow.plan,
              linkedRunId: runId,
            };
            // Business progress (data-progress / data-plan-progress) comes from
            // Produce only — Session does not synthesize chips at gate suspend.
            sideEffects = {
              upsertRun: {
                runId,
                status: view.runStatus ?? product.status,
                pages: suspend.pages ?? product.pages,
                plan: decision.plan ?? suspend.plan ?? input.session.workflow.plan,
                summary: product.summary,
                sessionId: input.session.id,
              },
            };
            return;
          }
        }

        const terminal = sessionViewFromTerminal(product);
        status = terminal.status;
        workflow = {
          phase: terminal.workflowPhase,
          plan: terminal.plan ?? input.session.workflow.plan,
          linkedRunId: runId,
        };
        const failed = terminal.runStatus === "failed" || terminal.status === "failed";
        if (terminal.runStatus === "published") {
          // Stable operator copy for e2e + UI (prefer over fixture-specific summary alone).
          await writeText(
            terminal.summary
              ? `${terminal.summary}\n\nPublished Wiki updated atomically.`
              : "Published Wiki updated atomically.",
          );
        } else if (terminal.summary) {
          await writeText(terminal.summary);
        } else if (failed) {
          await writeText("Wiki Run failed.");
        }
        sideEffects = {
          upsertRun: {
            runId,
            status: terminal.runStatus ?? terminal.status,
            pages: terminal.pages,
            plan: terminal.plan ?? input.session.workflow.plan,
            summary: terminal.summary,
            sessionId: input.session.id,
          },
        };
      };

      if (mode === "help") {
        await writeText(
          helpTextForSessionTurn({
            helpReason: turn.helpReason ?? "not_kickoff",
            phase,
            userText,
          }),
        );
        status = "active";
        return;
      }

      // Defensive: start/resume should not run without sources (mode resolution
      // already blocks start; resume of a pre-source run is not product-valid).
      if (!hasSources) {
        await writeText(
          helpTextForSessionTurn({ helpReason: "no_sources", phase, userText }),
        );
        status = "active";
        return;
      }

      /** Product cancel via P2 transition (ADR 0027) — no hard-coded status/phase. */
      const markCancelled = async (summary = "Wiki Run cancelled") => {
        const patches = transition(
          { type: "Cancel", runId, summary },
          {
            sessionStatus: status,
            workflowPhase: workflow.phase ?? "idle",
            linkedRunId: runId,
            runStatus: sideEffects?.upsertRun?.status ?? "running",
            pending,
            plan: workflow.plan ?? input.session.workflow.plan,
            summary: sideEffects?.upsertRun?.summary,
          },
        );
        if (patches.ignore) {
          // Durable publish outcome already won — leave session/run as-is.
          return;
        }
        if (patches.session?.status !== undefined) {
          status = patches.session.status;
        }
        if (patches.session && "pending" in patches.session) {
          pending = patches.session.pending ?? null;
        }
        workflow = {
          phase: patches.session?.workflow?.phase ?? "idle",
          linkedRunId:
            (patches.session?.workflow?.linkedRunId as string | undefined) ??
            runId,
          plan:
            patches.session?.workflow?.plan ??
            workflow.plan ??
            input.session.workflow.plan,
        };
        const text = patches.appendHint?.text ?? patches.run?.summary ?? summary;
        await writeText(text);
        sideEffects = {
          upsertRun: {
            runId,
            status: patches.run?.status ?? "cancelled",
            summary: patches.run?.summary ?? summary,
            sessionId: input.session.id,
          },
        };
      };

      // Hold ui so catch can settle result() and unbind product abort signal.
      let ui: Awaited<ReturnType<typeof openWikiRunUiProjection>> | undefined;
      /** Cancel wins over gates/errors, but not over durable publish outcomes. */
      const cancelUnlessDurableSuccess = async () => {
        if (!abortSignal?.aborted) {
          return;
        }
        if (isDurableRunStatus(sideEffects?.upsertRun?.status)) {
          return;
        }
        await markCancelled();
      };

      try {
        if (abortSignal?.aborted) {
          await markCancelled();
          return;
        }

        if (mode === "start") {
          // Emit run id before text so Session Stop can target cancel ASAP.
          writeRunLink(runId, "starting");
          await writeText(
            `Starting **Wiki Run** \`${runId}\` for **${input.workspace.name}**…`,
          );
          // P2 TurnStarted: running + planning (not hard-coded phase map).
          const startPatches = transition(
            { type: "TurnStarted", runId },
            {
              sessionStatus: status,
              workflowPhase: workflow.phase ?? "idle",
              linkedRunId: input.session.workflow.linkedRunId,
              pending,
              plan: input.session.workflow.plan,
            },
          );
          if (startPatches.session?.status !== undefined) {
            status = startPatches.session.status;
          }
          if (startPatches.session && "pending" in startPatches.session) {
            pending = startPatches.session.pending ?? null;
          }
          const startPhase =
            startPatches.session?.workflow?.phase ?? "planning";
          workflow = {
            phase: startPhase,
            linkedRunId:
              (startPatches.session?.workflow?.linkedRunId as
                | string
                | undefined) ?? runId,
            plan:
              startPatches.session?.workflow?.plan ??
              input.session.workflow.plan,
          };
          // Phase chips come from Produce emitRunPhase — not Session synthesis.
          // P1 thin shell: orchestrator open + one toAISdkStream (ADR 0027).
          ui = await openWikiRunUiProjection({
            kind: "start",
            runId,
            workspace: input.workspace,
            autoApprove: false,
            skipPlanConfirm: false,
            forcePlanConfirm: true,
            abortSignal,
          });
          await input.onWorkflowLive?.(runId);
          await checkpoint(true);
          // Merge workflow UI parts into this turn's assistant message
          // (originalMessages keeps a single bubble). Await pipe so decision
          // text is ordered after workflow chunks.
          await pipeUiStream(
            writer,
            ui.stream,
            abortSignal,
            onPipedChunk,
            streamAcc.toolNames,
          );
          // Always settle result (unbind + real outcome). Late abort must not
          // rewrite published/publication_declined after the workflow finished.
          await applyWorkflowResult(await ui.result());
          await cancelUnlessDurableSuccess();
          await checkpoint(true);
          return;
        }

        writeRunLink(runId, "resuming");
        const resumeAction = resumeData?.action;
        const resumePhase: SessionWorkflowState["phase"] =
          resumeAction === "revise"
            ? "planning"
            : resumeAction === "approve" && resumeStep === "plan-gate"
              ? "writing"
              : resumeAction === "approve" && resumeStep === "publish-gate"
                ? "done"
                : (workflow.phase as SessionWorkflowState["phase"]) ?? "writing";
        // P2 WorkflowLive for resume mid-flight (status/phase from transition).
        const livePatches = transition(
          {
            type: "WorkflowLive",
            runId,
            phase:
              resumeAction === "approve" || resumeAction === "revise"
                ? resumePhase
                : undefined,
          },
          {
            sessionStatus: status,
            workflowPhase: workflow.phase ?? "idle",
            linkedRunId: runId,
            pending,
            plan: workflow.plan ?? input.session.workflow.plan,
            runStatus: sideEffects?.upsertRun?.status,
          },
        );
        if (livePatches.session?.status !== undefined) {
          status = livePatches.session.status;
        }
        if (livePatches.session && "pending" in livePatches.session) {
          pending = livePatches.session.pending ?? null;
        }
        if (resumeAction === "approve" || resumeAction === "revise") {
          const nextPhase =
            livePatches.session?.workflow?.phase ?? resumePhase;
          workflow = {
            ...workflow,
            phase: nextPhase,
            linkedRunId: runId,
            plan:
              livePatches.session?.workflow?.plan ??
              workflow.plan ??
              input.session.workflow.plan,
          };
          // Mid-flight phase chips come from Produce, not Session synthesis.
        } else {
          workflow = {
            ...workflow,
            linkedRunId: runId,
            phase:
              livePatches.session?.workflow?.phase ??
              workflow.phase ??
              "writing",
          };
        }
        await writeText(
          resumeAction === "approve"
            ? "Resuming Wiki Run…"
            : resumeAction === "revise"
              ? "Revising the wiki plan with your feedback…"
              : "Declining and closing the suspended gate…",
        );
        ui = await openWikiRunUiProjection({
          kind: "resume",
          runId,
          step: resumeStep ?? "plan-gate",
          resumeData: {
            action: resumeData!.action,
            ...(resumeData!.plan ? { plan: resumeData!.plan } : {}),
            ...(resumeData!.feedback
              ? { feedback: resumeData!.feedback }
              : {}),
          },
          abortSignal,
        });
        await input.onWorkflowLive?.(runId);
        await checkpoint(true);
        await pipeUiStream(
          writer,
          ui.stream,
          abortSignal,
          onPipedChunk,
          streamAcc.toolNames,
        );
        await applyWorkflowResult(await ui.result());
        await cancelUnlessDurableSuccess();
        await checkpoint(true);
      } catch (error) {
        // Prefer durable workflow outcome over cancel/stream errors. pipeUiStream
        // or a late abort must not clobber published / publication_declined after
        // the workflow has already finished; always settle result() to unbind.
        let failCause: unknown = error;
        if (ui) {
          try {
            await applyWorkflowResult(await ui.result());
            await cancelUnlessDurableSuccess();
            return;
          } catch (resultError) {
            // Prefer cancel classification when either the pipe or result aborted.
            if (
              abortSignal?.aborted ||
              isRunCancelledError(error) ||
              isRunCancelledError(resultError)
            ) {
              failCause =
                isRunCancelledError(resultError) || abortSignal?.aborted
                  ? resultError
                  : error;
            } else {
              failCause = resultError;
            }
          }
        }
        if (isDurableRunStatus(sideEffects?.upsertRun?.status)) {
          // Outcome already applied; do not rewrite as cancelled/failed.
          return;
        }
        if (
          abortSignal?.aborted ||
          isRunCancelledError(failCause) ||
          isRunCancelledError(error)
        ) {
          await markCancelled();
          return;
        }
        // P2 WorkflowTerminal failed — idle phase so kickoff works again.
        const errText = redactErrorMessage(failCause);
        const failPatches = transition(
          {
            type: "WorkflowTerminal",
            runId,
            status: "failed",
            error: errText,
          },
          {
            sessionStatus: status,
            workflowPhase: workflow.phase ?? "idle",
            linkedRunId: runId,
            runStatus: sideEffects?.upsertRun?.status,
            pending,
            plan: workflow.plan ?? input.session.workflow.plan,
          },
        );
        if (failPatches.ignore) {
          return;
        }
        if (failPatches.session?.status !== undefined) {
          status = failPatches.session.status;
        }
        if (failPatches.session && "pending" in failPatches.session) {
          pending = failPatches.session.pending ?? null;
        }
        workflow = {
          phase: failPatches.session?.workflow?.phase ?? "idle",
          linkedRunId:
            (failPatches.session?.workflow?.linkedRunId as string | undefined) ??
            runId,
          plan:
            failPatches.session?.workflow?.plan ??
            workflow.plan ??
            input.session.workflow.plan,
        };
        await writeText(
          failPatches.appendHint?.text ??
            failPatches.run?.summary ??
            `Wiki Run failed: ${errText}`,
        );
        sideEffects = {
          upsertRun: {
            runId,
            status: failPatches.run?.status ?? "failed",
            summary: failPatches.run?.summary ?? errText,
            sessionId: input.session.id,
          },
        };
      }
    },
  });

  return {
    stream,
    mode,
    runId: mode === "help" ? undefined : runId,
    finalize: async () => {
      // onFinish runs in handleUIMessageStreamFinish flush while the stream is
      // still being drained. A few microtasks cover late assignment if finalize
      // is invoked on the same tick the readable closes.
      for (let i = 0; i < 5 && !finishedMessages; i += 1) {
        await Promise.resolve();
      }
      // Prefer full stream-assembled messages (tool/data parts included).
      // Structural bridge first; single projectSessionMessages safety pass for
      // durable Session (stream already projects live chunks — no second rewrite
      // inside session-messages).
      if (finishedMessages && finishedMessages.length > 0) {
        const asSession = projectSessionMessages(
          uiMessagesToSessionMessages(finishedMessages),
        );
        const assistantMessage =
          [...asSession].reverse().find((m) => m.role === "assistant") ??
          asSession[asSession.length - 1]!;
        return {
          messages: asSession,
          assistantMessage,
          status,
          pending,
          workflow,
          sideEffects,
        };
      }

      // Fallback: stream-pipe toolParts are already operator-projected; one
      // projectSessionMessages pass covers history + assistant assembly.
      const parts: SessionMessage["parts"] = [
        { type: "text", text: finalText || "(empty)", state: "done" },
        ...toolParts,
        ...dataParts,
      ];
      // writeGate already pushed data-gate into dataParts; only re-append if missing.
      const hasLiveGate = dataParts.some(
        (p) =>
          p.type === "data-gate" &&
          typeof p === "object" &&
          p !== null &&
          "data" in p &&
          !(p.data as { cancelled?: boolean } | undefined)?.cancelled,
      );
      if (pending && !hasLiveGate) {
        parts.push({
          type: "data-gate",
          data: {
            ...pending,
            gate:
              workflow.phase === "awaiting_publish" ? "publication" : "plan",
            cancelled: false,
          },
        } as SessionMessage["parts"][number]);
      }
      const assistantMessage: SessionMessage = {
        id: assistantId,
        role: "assistant",
        parts,
        createdAt: new Date().toISOString(),
      };
      return {
        messages: projectSessionMessages([
          ...uiMessagesToSessionMessages(input.messages),
          assistantMessage,
        ]),
        assistantMessage,
        status,
        pending,
        workflow,
        sideEffects,
      };
    },
  };
}

/**
 * @deprecated Prefer {@link createSessionTurnStream}. Alias kept for one PR cycle.
 */
export const createSessionWorkflowStream = createSessionTurnStream;
