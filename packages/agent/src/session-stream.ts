/**
 * Operator Session turn streaming via Mastra Workflow + @mastra/ai-sdk toAISdkStream.
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
  InteractionOption,
  OperatorSession,
  PendingInteraction,
  SessionMessage,
  SessionWorkflowState,
  WikiRunPlan,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import {
  helpTextForSessionTurn,
  normalizeSessionUserText,
  resolveSessionTurnMode,
} from "@okf-wiki/contract";
import { redactErrorMessage } from "./run.js";
import { uiMessagesToSessionMessages } from "./session-messages.js";
import {
  extractSuspendGate,
  isDurableRunStatus,
  mapWorkflowResult,
  sessionViewFromTerminal,
} from "./workflow-result.js";
import { openWikiWorkflowUiStream } from "./workflow-ui-stream.js";

// Re-export shared policy + message bridge for existing agent imports.
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
} from "./session-messages.js";

export type SessionStreamSideEffects = {
  /** Register / update product run record after workflow progress. */
  upsertRun?: {
    runId: string;
    status: OperatorSession["status"] | string;
    pages?: string[];
    plan?: WikiRunPlan;
    summary?: string;
    /** Link run record back to the Operator Session that started it. */
    sessionId?: string;
  };
};

export type SessionStreamResult = {
  stream: ReadableStream<UIMessageChunk>;
  /**
   * Turn mode after body/session inspection. Server uses `start` to eagerly
   * register a run record so explicit Stop/cancel can target it mid-stream.
   */
  mode: "start" | "resume" | "help";
  /** Linked Wiki Run id for start/resume turns (undefined for help). */
  runId?: string;
  finalize: () => Promise<{
    /** Full UIMessage-compatible history after this turn (server source of truth). */
    messages: SessionMessage[];
    assistantMessage: SessionMessage;
    status: OperatorSession["status"];
    pending: PendingInteraction | null;
    workflow: Partial<SessionWorkflowState>;
    sideEffects?: SessionStreamSideEffects;
  }>;
};

export type SessionStreamBody = {
  /** Preferred: last user message only (AI SDK chat persistence). */
  message?: UIMessage;
  /** Full message list (server-assembled or legacy client). */
  messages?: UIMessage[];
  /** Chat / session id from DefaultChatTransport. */
  id?: string;
  /**
   * Explicit turn intent (preferred). Avoids guessing resume/start from user text.
   * - start: kick off a Wiki Run
   * - resume: answer plan/publish gate with resumeData
   * - chat: help / non-run (default when omitted and no resumeData)
   */
  intent?: "start" | "resume" | "chat";
  /** Workflow resume payload (plan/publication gate). Required when intent=resume. */
  resumeData?: {
    action: "approve" | "deny" | "revise";
    plan?: WikiRunPlan;
    feedback?: string;
  };
  runId?: string;
  step?: string;
};

/** Accumulator for mid-stream durable checkpoints (refresh mid-flight). */
type StreamPartAcc = {
  textById: Map<string, string>;
  toolParts: Map<string, SessionMessage["parts"][number]>;
  dataParts: SessionMessage["parts"];
};

function createStreamPartAcc(): StreamPartAcc {
  return {
    textById: new Map(),
    toolParts: new Map(),
    dataParts: [],
  };
}

function applyChunkToAcc(acc: StreamPartAcc, value: UIMessageChunk): void {
  const v = value as UIMessageChunk & Record<string, unknown>;
  switch (v.type) {
    case "text-delta": {
      const id = String(v.id ?? "text");
      const delta = typeof v.delta === "string" ? v.delta : "";
      acc.textById.set(id, (acc.textById.get(id) ?? "") + delta);
      break;
    }
    case "tool-input-available": {
      const toolCallId = String(v.toolCallId ?? "tool");
      const toolName = String(v.toolName ?? "tool");
      acc.toolParts.set(toolCallId, {
        type: `tool-${toolName}`,
        toolCallId,
        toolName,
        state: "input-available",
        input: v.input,
      } as SessionMessage["parts"][number]);
      break;
    }
    case "tool-output-available": {
      const toolCallId = String(v.toolCallId ?? "tool");
      const prev = acc.toolParts.get(toolCallId) as
        | {
            type: string;
            toolCallId?: string;
            toolName?: string;
            input?: unknown;
          }
        | undefined;
      const toolName =
        prev?.toolName ??
        (prev?.type?.startsWith("tool-") ? prev.type.slice(5) : "tool");
      acc.toolParts.set(toolCallId, {
        type: `tool-${toolName}`,
        toolCallId,
        toolName,
        state: "output-available",
        input: prev?.input,
        output: v.output,
      } as SessionMessage["parts"][number]);
      break;
    }
    default: {
      if (typeof v.type === "string" && v.type.startsWith("data-")) {
        acc.dataParts.push({
          type: v.type,
          id: typeof v.id === "string" ? v.id : undefined,
          data: v.data,
        } as SessionMessage["parts"][number]);
      }
      break;
    }
  }
}

function partsFromAcc(
  productText: string,
  productData: SessionMessage["parts"],
  productTools: SessionMessage["parts"],
  acc: StreamPartAcc,
): SessionMessage["parts"] {
  const parts: SessionMessage["parts"] = [];
  const streamedText = [...acc.textById.values()].join("");
  const text = [productText, streamedText].filter(Boolean).join("\n\n");
  if (text) {
    parts.push({ type: "text", text, state: "streaming" });
  } else {
    parts.push({
      type: "text",
      text: "Wiki Run in progress… (refresh will update as work continues)",
      state: "streaming",
    });
  }
  parts.push(...productData);
  parts.push(...productTools);
  parts.push(...acc.dataParts);
  parts.push(...acc.toolParts.values());
  return parts;
}

/**
 * Pipe another UI stream into the turn writer (awaited for ordering).
 * Skip nested start/finish — the outer createUIMessageStream owns message framing
 * (with originalMessages) so we do not open a second assistant bubble.
 * When `abortSignal` fires, cancel the reader so we stop merging chunks ASAP.
 * Optional `onChunk` supports durable mid-stream checkpoints for refresh.
 */
async function pipeUiStream(
  writer: { write: (part: UIMessageChunk) => void },
  stream: ReadableStream<UIMessageChunk>,
  abortSignal?: AbortSignal,
  onChunk?: (chunk: UIMessageChunk) => void | Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (abortSignal?.aborted) {
    await reader.cancel().catch(() => undefined);
    return;
  }
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (abortSignal?.aborted) {
        break;
      }
      let done: boolean;
      let value: UIMessageChunk | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch {
        // reader.cancel() from product abort rejects a pending read — treat as
        // clean stop so the caller can still await workflow result() (durable
        // publish must not be lost to a stream cancel error).
        break;
      }
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      if (value.type === "start" || value.type === "finish") {
        continue;
      }
      // Drop further writes once product cancel wins mid-pipe.
      if (abortSignal?.aborted) {
        break;
      }
      writer.write(value);
      try {
        await onChunk?.(value);
      } catch {
        // checkpoint must never break the live stream
      }
    }
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    // Ensure the underlying workflow stream is not left locked if we broke early.
    try {
      await reader.cancel();
    } catch {
      // already cancelled / closed
    }
  }
}

function isCancelError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: string }).name;
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    name === "WikiRunCancelled"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|AbortError|cancelled|plan declined/i.test(message);
}

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

function optionsForPlan(plan: WikiRunPlan): InteractionOption[] {
  return [
    {
      id: "approve",
      label: `Write ${plan.pages.length} page(s)`,
      description: plan.pages.map((p) => p.path).join(", "),
    },
    {
      id: "revise",
      label: "Request changes",
      description: "Type modification feedback to replan",
    },
    {
      id: "deny",
      label: "Reject this plan",
      description: "Cancel this Wiki Run",
    },
  ];
}

/** Render a WikiRunPlan as operator-facing Markdown (fullscreen / transcript). */
export function planToMarkdown(plan: WikiRunPlan): string {
  const lines = [
    "## Proposed wiki plan",
    "",
    plan.summary,
    "",
    "### Pages",
    ...plan.pages.map((p) => `- \`${p.path}\` — ${p.purpose}`),
  ];
  if (plan.notes?.trim()) {
    lines.push("", "### Notes", "", plan.notes.trim());
  }
  return lines.join("\n");
}

function optionsForPublish(): InteractionOption[] {
  return [
    {
      id: "approve",
      label: "Publish staged wiki",
      description: "Atomic publication via product gate",
    },
    {
      id: "deny",
      label: "Keep staging only",
      description: "Do not change Published Wiki",
    },
  ];
}

function decisionFromSuspend(payload: {
  gate?: string;
  plan?: WikiRunPlan;
  pages?: string[];
  summary?: string;
}): { pending: PendingInteraction; text: string; plan?: WikiRunPlan } | null {
  if (payload.gate === "plan" && payload.plan) {
    const plan = payload.plan;
    // Short prompt only — full plan lives in data-plan (PlanViewer), avoid duplex markdown.
    return {
      plan,
      text:
        `A **wiki plan** with **${plan.pages.length}** page(s) is ready for review. ` +
        "Open the plan card (or fullscreen) below, then approve, request changes, or type revision feedback.",
      pending: {
        type: "approval",
        question:
          "How do you want to proceed with this plan? You can also type free-text revision feedback.",
        mode: "choice_or_input",
        selectionMode: "single",
        options: optionsForPlan(plan),
        inputPlaceholder:
          "Describe plan changes (e.g. add concepts.md, drop architecture.md)…",
      },
    };
  }
  if (payload.gate === "publication") {
    const pages = payload.pages ?? [];
    return {
      text:
        `Staged **${pages.length}** page(s)` +
        (pages.length ? `:\n\n${pages.map((p) => `- \`${p}\``).join("\n")}` : "") +
        "\n\nChoose how to proceed:",
      pending: {
        type: "confirmation",
        question: "Publish the staged wiki?",
        mode: "choice_only",
        selectionMode: "single",
        options: optionsForPublish(),
      },
    };
  }
  return null;
}



/**
 * Stream one Session turn: start or resume the wiki-run workflow via official AI SDK bridge.
 * Caller must pass full `messages` (server history + new user message).
 */
export async function createSessionWorkflowStream(input: {
  session: OperatorSession;
  workspace: WorkspaceConfig;
  /** Full UI message list for this turn (previous + new user). */
  messages: UIMessage[];
  body?: SessionStreamBody;
  /**
   * Register product cancel AbortController for this run (server abortRun).
   * Called synchronously once mode/runId are known so Stop can abort mid-stream.
   */
  abortSignalForRun?: (runId: string) => AbortSignal;
  /**
   * Called after the Mastra workflow stream is successfully opened (start or
   * resume). Server uses this to mark the run record `running` only once the
   * workflow is live — not at eager session mid-flight — so a crash before open
   * leaves the run at awaiting_* for gate recovery.
   */
  onWorkflowLive?: (runId: string) => void | Promise<void>;
  /**
   * Durable mid-stream journal: server persists partial assistant timeline so a
   * page refresh mid-turn can render progress and keep catching up.
   */
  onCheckpoint?: (snapshot: {
    messages: SessionMessage[];
    status: OperatorSession["status"];
    pending: PendingInteraction | null;
    workflow: Partial<SessionWorkflowState>;
  }) => void | Promise<void>;
}): Promise<SessionStreamResult> {
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

      const writeText = async (text: string) => {
        finalText += (finalText ? "\n\n" : "") + text;
        writer.write({ type: "text-start", id: textId });
        const step = 64;
        for (let i = 0; i < text.length; i += step) {
          writer.write({
            type: "text-delta",
            id: textId,
            delta: text.slice(i, i + step),
          });
        }
        writer.write({ type: "text-end", id: textId });
        await checkpoint(true);
      };

      /**
       * Product HITL gate part (not a model tool).
       * UI reads `data-gate` + `data-plan`; no tool-request_user_decision / data-choice.
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
        await checkpoint(false);
      };

      const applyWorkflowResult = async (result: unknown) => {
        const product = mapWorkflowResult(result);
        const suspend = extractSuspendGate(result);
        if (suspend) {
          const decision = decisionFromSuspend(suspend);
          if (decision) {
            await writeText(decision.text);
            const gateKind =
              suspend.gate === "publication" ? "publication" : "plan";
            writeGate(decision.pending, gateKind);
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
        if (terminal.summary) {
          await writeText(terminal.summary);
        } else if (terminal.runStatus === "published") {
          await writeText("Published Wiki updated atomically.");
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

      const markCancelled = async (summary = "Wiki Run cancelled") => {
        pending = null;
        status = "active";
        workflow = {
          phase: "idle",
          linkedRunId: runId,
          plan: input.session.workflow.plan,
        };
        await writeText(summary);
        sideEffects = {
          upsertRun: {
            runId,
            status: "cancelled",
            summary,
            sessionId: input.session.id,
          },
        };
      };

      // Hold ui so catch can settle result() and unbind product abort signal.
      let ui:
        | Awaited<ReturnType<typeof openWikiWorkflowUiStream>>
        | undefined;
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
        status = "running";
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
          // Mid-flight until suspend; do not pretent we are already at plan gate.
          workflow = { phase: "planning", linkedRunId: runId };
          ui = await openWikiWorkflowUiStream({
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
          await pipeUiStream(writer, ui.stream, abortSignal, onPipedChunk);
          // Always settle result (unbind + real outcome). Late abort must not
          // rewrite published/publication_declined after the workflow finished.
          await applyWorkflowResult(await ui.result());
          await cancelUnlessDurableSuccess();
          await checkpoint(true);
          return;
        }

        writeRunLink(runId, "resuming");
        const resumeAction = resumeData?.action;
        await writeText(
          resumeAction === "approve"
            ? "Resuming Wiki Run…"
            : resumeAction === "revise"
              ? "Revising the wiki plan with your feedback…"
              : "Declining and closing the suspended gate…",
        );
        ui = await openWikiWorkflowUiStream({
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
        await pipeUiStream(writer, ui.stream, abortSignal, onPipedChunk);
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
              isCancelError(error) ||
              isCancelError(resultError)
            ) {
              failCause =
                isCancelError(resultError) || abortSignal?.aborted
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
        if (abortSignal?.aborted || isCancelError(failCause) || isCancelError(error)) {
          await markCancelled();
          return;
        }
        status = "failed";
        // Do not leave phase stuck at awaiting_plan (set optimistically on start)
        // or a prior gate — failed turns must return to idle so kickoff works again.
        pending = null;
        workflow = {
          phase: "idle",
          linkedRunId: runId,
          plan: input.session.workflow.plan,
        };
        await writeText(`Wiki Run failed: ${redactErrorMessage(failCause)}`);
        sideEffects = {
          upsertRun: {
            runId,
            status: "failed",
            summary: redactErrorMessage(failCause),
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
      if (finishedMessages && finishedMessages.length > 0) {
        const asSession = uiMessagesToSessionMessages(finishedMessages);
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

      const parts: SessionMessage["parts"] = [
        { type: "text", text: finalText || "(empty)", state: "done" },
        ...toolParts,
        ...dataParts,
      ];
      if (pending) {
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
        messages: [
          ...uiMessagesToSessionMessages(input.messages),
          assistantMessage,
        ],
        assistantMessage,
        status,
        pending,
        workflow,
        sideEffects,
      };
    },
  };
}
