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
import type { WikiRunWorkflowOutput } from "./wiki-workflow.js";
import { redactErrorMessage } from "./run.js";
import { openWikiWorkflowUiStream } from "./workflow-ui-stream.js";

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
  /** Workflow resume payload (plan/publication gate). */
  resumeData?: { action: "approve" | "deny"; plan?: WikiRunPlan };
  runId?: string;
  step?: string;
};

/**
 * Pipe another UI stream into the turn writer (awaited for ordering).
 * Skip nested start/finish — the outer createUIMessageStream owns message framing
 * (with originalMessages) so we do not open a second assistant bubble.
 * When `abortSignal` fires, cancel the reader so we stop merging chunks ASAP.
 */
async function pipeUiStream(
  writer: { write: (part: UIMessageChunk) => void },
  stream: ReadableStream<UIMessageChunk>,
  abortSignal?: AbortSignal,
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

/** Why a turn stayed in help mode (contextual assistant copy). */
export type SessionTurnHelpReason =
  | "no_sources"
  | "pending_gate"
  | "running"
  | "not_kickoff";

export type SessionTurnModeResult = {
  mode: "start" | "resume" | "help";
  helpReason?: SessionTurnHelpReason;
};

/** Generate-ish user text (phase-agnostic). Free-chat must not auto-start. */
export function isKickoffPhrase(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return false;
  }
  // Keep broad enough for e2e / kickoff ("generate a wiki plan") and help copy ("generate").
  return /generate|wiki|plan|开始|生成|写|run/i.test(t);
}

/**
 * True when user text should start a new Wiki Run.
 * Only on idle/done (never while a gate or run is mid-flight), and only for
 * generate-ish phrases — idle free-chat must not auto-start a run.
 */
export function isKickoff(text: string, phase: string | undefined): boolean {
  if (phase !== "idle" && phase !== undefined && phase !== "done") {
    return false;
  }
  return isKickoffPhrase(text);
}

/**
 * Pure turn-mode resolution for Operator Session chat.
 * Product rule: only generate-ish kickoff on idle/done starts a run; free-chat never does.
 */
export function resolveSessionTurnMode(input: {
  userText: string;
  phase: string | undefined;
  status: OperatorSession["status"] | string;
  hasSources: boolean;
  resumeData?: { action: "approve" | "deny"; plan?: WikiRunPlan };
  existingRunId?: string;
}): SessionTurnModeResult {
  const { userText, phase, status, hasSources, resumeData, existingRunId } =
    input;
  const phaseNorm = phase ?? "idle";
  const atGate =
    phaseNorm === "awaiting_plan" || phaseNorm === "awaiting_publish";

  // Resume wins when we have both payload and a linked run.
  if (resumeData && existingRunId) {
    return { mode: "resume" };
  }

  // Soft guard: avoid stacking a second start while a run is mid-flight.
  // Cover both session.status and workflow phases set during start/write.
  if (
    status === "running" ||
    phaseNorm === "planning" ||
    phaseNorm === "writing"
  ) {
    return { mode: "help", helpReason: "running" };
  }

  // Start only on generate-ish kickoff at idle/done with sources present.
  if (isKickoff(userText, phase) && !resumeData && hasSources) {
    return { mode: "start" };
  }

  // Pending plan/publish gate without a valid resume payload.
  if (atGate) {
    return { mode: "help", helpReason: "pending_gate" };
  }

  // Any non-resume turn without sources — do not suggest generate first.
  if (!hasSources) {
    return { mode: "help", helpReason: "no_sources" };
  }

  return { mode: "help", helpReason: "not_kickoff" };
}

/** Contextual help copy for non-start/resume turns. */
export function helpTextForSessionTurn(input: {
  helpReason: SessionTurnHelpReason;
  phase?: string;
  userText?: string;
}): string {
  const phase = input.phase ?? "idle";
  switch (input.helpReason) {
    case "no_sources":
      return "Add at least one Git source under **Sources** before starting a Wiki Run.";
    case "pending_gate": {
      // Kickoff-like text at a gate: do not pretend "generate" will start a run.
      if (isKickoffPhrase(input.userText ?? "")) {
        if (phase === "awaiting_publish") {
          return "A publication decision is still pending. Complete or deny the publish gate (use the decision options above) before starting a new Wiki Run with **generate**.";
        }
        return "A plan decision is still pending. Complete or deny the plan gate (use the decision options above) before starting a new Wiki Run with **generate**.";
      }
      if (phase === "awaiting_publish") {
        return "A publication decision is waiting. Pick **approve** or **deny** above to continue — free-text chat will not advance this gate.";
      }
      return "A plan decision is waiting. Pick **approve** or **deny** above to continue — free-text chat will not advance this gate.";
    }
    case "running":
      return "A Wiki Run is already in progress. Wait for it to finish, or use **Stop** to cancel it.";
    case "not_kickoff":
    default:
      return "Continue the wiki session: say **generate** to start a Wiki Run, or pick a decision option above.";
  }
}

function optionsForPlan(plan: WikiRunPlan): InteractionOption[] {
  return [
    {
      id: "approve",
      label: `Write ${plan.pages.length} page(s)`,
      description: plan.pages.map((p) => p.path).join(", "),
    },
    {
      id: "deny",
      label: "Reject this plan",
      description: "Cancel this Wiki Run",
    },
  ];
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
    const lines = [
      "## Proposed wiki plan",
      "",
      plan.summary,
      "",
      "### Pages",
      ...plan.pages.map((p) => `- \`${p.path}\` — ${p.purpose}`),
    ];
    return {
      plan,
      text: lines.join("\n"),
      pending: {
        type: "approval",
        question: "How do you want to proceed with this plan?",
        mode: "choice_only",
        selectionMode: "single",
        options: optionsForPlan(plan),
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

function extractSuspendPayload(result: {
  status?: string;
  suspendPayload?: unknown;
  steps?: Record<string, { status?: string; suspendPayload?: unknown }>;
}): { gate?: string; plan?: WikiRunPlan; pages?: string[]; summary?: string } | null {
  if (result.status !== "suspended") {
    return null;
  }
  const steps = result.steps ?? {};
  for (const step of Object.values(steps)) {
    if (step?.status !== "suspended") {
      continue;
    }
    const p = step.suspendPayload as
      | { gate?: string; plan?: WikiRunPlan; pages?: string[]; summary?: string }
      | undefined;
    if (p?.gate) {
      return p;
    }
  }
  // Nested by step id: { 'plan-gate': { gate, plan } }
  const top = result.suspendPayload;
  if (top && typeof top === "object") {
    for (const v of Object.values(top as Record<string, unknown>)) {
      if (v && typeof v === "object" && "gate" in (v as object)) {
        return v as {
          gate?: string;
          plan?: WikiRunPlan;
          pages?: string[];
          summary?: string;
        };
      }
    }
  }
  return null;
}

function mapTerminalStatus(result: {
  status?: string;
  result?: WikiRunWorkflowOutput;
}): {
  status: OperatorSession["status"];
  workflowPhase: SessionWorkflowState["phase"];
  pages?: string[];
  plan?: WikiRunPlan;
  summary?: string;
  runStatus?: string;
} {
  if (result.status === "success" && result.result) {
    const out = result.result;
    if (out.status === "published") {
      return {
        status: "completed",
        workflowPhase: "done",
        pages: out.pages,
        plan: out.plan,
        summary: out.summary,
        runStatus: "published",
      };
    }
    if (out.status === "publication_declined") {
      return {
        status: "active",
        workflowPhase: "idle",
        pages: out.pages,
        plan: out.plan,
        summary: out.summary,
        runStatus: "publication_declined",
      };
    }
    if (out.status === "cancelled") {
      return {
        status: "active",
        workflowPhase: "idle",
        summary: out.summary,
        runStatus: "cancelled",
      };
    }
    return {
      status: "failed",
      workflowPhase: "idle",
      summary: out.summary,
      runStatus: out.status,
    };
  }
  if (result.status === "failed") {
    return { status: "failed", workflowPhase: "idle", runStatus: "failed" };
  }
  return { status: "active", workflowPhase: "idle" };
}

/** Convert durable SessionMessage rows to AI SDK UIMessage shape. */
export function sessionMessagesToUIMessages(
  messages: SessionMessage[],
): UIMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: (m.parts ?? []).map((p) => {
      if (p.type === "text" && "text" in p) {
        return { type: "text" as const, text: p.text };
      }
      if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const tool = p as {
          type: string;
          toolCallId?: string;
          toolName?: string;
          state?: string;
          input?: unknown;
          output?: unknown;
          errorText?: string;
        };
        return {
          type: tool.type as `tool-${string}`,
          toolCallId: tool.toolCallId ?? tool.type,
          state: (tool.state as "output-available") ?? "output-available",
          input: tool.input,
          output: tool.output,
          errorText: tool.errorText,
        } as UIMessage["parts"][number];
      }
      if (typeof p.type === "string" && p.type.startsWith("data-")) {
        const dataPart = p as { type: string; id?: string; data?: unknown };
        return {
          type: dataPart.type as `data-${string}`,
          id: dataPart.id,
          data: dataPart.data,
        } as UIMessage["parts"][number];
      }
      if (p.type === "step-start") {
        return { type: "step-start" as const };
      }
      return { type: "text" as const, text: JSON.stringify(p) };
    }),
  }));
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

  const phase = input.session.workflow.phase ?? "idle";
  const userText = lastUserText(input.messages);
  const existingRunId =
    input.body?.runId ?? input.session.workflow.linkedRunId ?? undefined;

  // Prefer explicit body; else map plain "approve"/"deny" user text when a run is linked.
  let resumeData = input.body?.resumeData;
  if (
    !resumeData &&
    existingRunId &&
    (userText === "approve" || userText === "deny")
  ) {
    resumeData = { action: userText };
  }

  // Plan gate approve requires a plan payload. Client may omit it (stale meta);
  // always fill from durable session workflow when missing.
  if (
    resumeData?.action === "approve" &&
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

  const hasSources = (input.workspace.sources?.length ?? 0) > 0;
  const turn = resolveSessionTurnMode({
    userText,
    phase,
    status: input.session.status,
    hasSources,
    resumeData,
    existingRunId,
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
      };

      const writeDecision = (interaction: PendingInteraction) => {
        const id = `${randomUUID()}-decision`;
        writer.write({
          type: "tool-input-start",
          toolCallId: id,
          toolName: "request_user_decision",
        });
        writer.write({
          type: "tool-input-available",
          toolCallId: id,
          toolName: "request_user_decision",
          input: interaction,
        });
        toolParts.push({
          type: "tool-request_user_decision",
          toolCallId: id,
          toolName: "request_user_decision",
          state: "input-available",
          input: interaction,
        });
        writer.write({
          type: "data-choice",
          id: randomUUID(),
          data: interaction,
        } as UIMessageChunk);
        pending = { ...interaction, toolCallId: id };
        status = "waiting";
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
      };

      const applyWorkflowResult = async (result: unknown) => {
        const suspend = extractSuspendPayload(result as never);
        if (suspend) {
          const decision = decisionFromSuspend(suspend);
          if (decision) {
            await writeText(decision.text);
            writeDecision(decision.pending);
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
            workflow = {
              phase:
                suspend.gate === "publication"
                  ? "awaiting_publish"
                  : "awaiting_plan",
              plan: decision.plan ?? input.session.workflow.plan,
              linkedRunId: runId,
            };
            sideEffects = {
              upsertRun: {
                runId,
                status:
                  suspend.gate === "plan"
                    ? "awaiting_plan"
                    : "awaiting_publication",
                pages: suspend.pages,
                plan: decision.plan ?? suspend.plan ?? input.session.workflow.plan,
                summary:
                  suspend.gate === "plan"
                    ? "Awaiting plan confirmation"
                    : suspend.summary,
                sessionId: input.session.id,
              },
            };
            return;
          }
        }

        const terminal = mapTerminalStatus(result as never);
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
        const runStatus = sideEffects?.upsertRun?.status;
        if (runStatus === "published" || runStatus === "publication_declined") {
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
          workflow = { phase: "awaiting_plan", linkedRunId: runId };
          ui = await openWikiWorkflowUiStream({
            kind: "start",
            runId,
            workspace: input.workspace,
            autoApprove: false,
            skipPlanConfirm: false,
            forcePlanConfirm: true,
            abortSignal,
          });
          // Merge workflow UI parts into this turn's assistant message
          // (originalMessages keeps a single bubble). Await pipe so decision
          // text is ordered after workflow chunks.
          await pipeUiStream(writer, ui.stream, abortSignal);
          // Always settle result (unbind + real outcome). Late abort must not
          // rewrite published/publication_declined after the workflow finished.
          await applyWorkflowResult(await ui.result());
          await cancelUnlessDurableSuccess();
          return;
        }

        writeRunLink(runId, "resuming");
        await writeText(
          resumeData?.action === "approve"
            ? "Resuming Wiki Run…"
            : "Declining and closing the suspended gate…",
        );
        ui = await openWikiWorkflowUiStream({
          kind: "resume",
          runId,
          step: resumeStep ?? "plan-gate",
          resumeData: {
            action: resumeData!.action,
            ...(resumeData!.plan ? { plan: resumeData!.plan } : {}),
          },
          abortSignal,
        });
        await pipeUiStream(writer, ui.stream, abortSignal);
        await applyWorkflowResult(await ui.result());
        await cancelUnlessDurableSuccess();
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
        const durable =
          sideEffects?.upsertRun?.status === "published" ||
          sideEffects?.upsertRun?.status === "publication_declined";
        if (durable) {
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
        parts.push({ type: "data-choice", data: pending });
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

/** Convert AI SDK UI messages to durable SessionMessage rows (lossy-safe, UIMessage-shaped). */
export function uiMessagesToSessionMessages(
  messages: UIMessage[],
): SessionMessage[] {
  return messages.map((m) => {
    const parts: SessionMessage["parts"] = [];
    for (const p of m.parts ?? []) {
      if (p.type === "text") {
        parts.push({ type: "text", text: p.text });
        continue;
      }
      if (p.type === "step-start") {
        parts.push({ type: "step-start" });
        continue;
      }
      if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        parts.push({
          type: p.type,
          toolCallId: "toolCallId" in p ? String(p.toolCallId ?? "") : "",
          toolName:
            "toolName" in p
              ? String(p.toolName ?? p.type.slice(5))
              : p.type.slice(5),
          state:
            "state" in p
              ? (p.state as SessionMessage["parts"][0] extends never
                  ? never
                  : string)
              : "output-available",
          input: "input" in p ? p.input : undefined,
          output: "output" in p ? p.output : undefined,
        } as SessionMessage["parts"][number]);
        continue;
      }
      if (typeof p.type === "string" && p.type.startsWith("data-")) {
        parts.push({
          type: p.type,
          id: "id" in p && typeof p.id === "string" ? p.id : undefined,
          data: "data" in p ? p.data : undefined,
        } as SessionMessage["parts"][number]);
      }
    }
    if (parts.length === 0) {
      parts.push({ type: "text", text: "(empty)" });
    }
    return {
      id: m.id,
      role: m.role as SessionMessage["role"],
      parts,
      createdAt: new Date().toISOString(),
    };
  });
}
