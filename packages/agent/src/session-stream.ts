/**
 * Operator Session turn streaming via Mastra Workflow + @mastra/ai-sdk toAISdkStream.
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
  };
  /** Resume already registered; publish handled inside workflow. */
};

export type SessionStreamResult = {
  stream: ReadableStream<UIMessageChunk>;
  finalize: () => Promise<{
    assistantMessage: SessionMessage;
    status: OperatorSession["status"];
    pending: PendingInteraction | null;
    workflow: Partial<SessionWorkflowState>;
    sideEffects?: SessionStreamSideEffects;
  }>;
};

export type SessionStreamBody = {
  messages?: UIMessage[];
  /** Workflow resume payload (plan/publication gate). */
  resumeData?: { action: "approve" | "deny"; plan?: WikiRunPlan };
  runId?: string;
  step?: string;
};

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

function isKickoff(text: string, phase: string | undefined): boolean {
  if (phase === "idle" || phase === undefined || phase === "done") {
    return true;
  }
  if (!text) {
    return true;
  }
  return /generate|wiki|plan|开始|生成|写|run/i.test(text);
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

/**
 * Stream one Session turn: start or resume the wiki-run workflow via official AI SDK bridge.
 */
export async function createSessionWorkflowStream(input: {
  session: OperatorSession;
  workspace: WorkspaceConfig;
  messages: UIMessage[];
  body?: SessionStreamBody;
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
    resumeData = {
      action: userText,
      ...(phase === "awaiting_plan" && input.session.workflow.plan
        ? { plan: input.session.workflow.plan }
        : {}),
    };
  }

  let mode: "start" | "resume" | "help" = "help";
  let runId = existingRunId ?? randomUUID();
  let resumeStep = input.body?.step;

  if (resumeData && existingRunId) {
    mode = "resume";
    runId = existingRunId;
    if (!resumeStep) {
      resumeStep =
        input.session.workflow.phase === "awaiting_publish" ||
        phase === "awaiting_publish"
          ? "publish-gate"
          : "plan-gate";
    }
  } else if (isKickoff(userText, phase) && !resumeData) {
    mode = "start";
    runId = randomUUID();
  }

  const stream = createUIMessageStream({
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

      const applyWorkflowResult = async (result: unknown) => {
        const suspend = extractSuspendPayload(result as never);
        if (suspend) {
          const decision = decisionFromSuspend(suspend);
          if (decision) {
            await writeText(decision.text);
            writeDecision(decision.pending);
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
          },
        };
      };

      if (mode === "help") {
        await writeText(
          "Continue the wiki session: say **generate** to start a Wiki Run, or pick a decision option above.",
        );
        status = "active";
        return;
      }

      if (!input.workspace.sources?.length) {
        await writeText(
          "Add at least one Git source under **Sources** before starting a Wiki Run.",
        );
        status = "active";
        return;
      }

      try {
        status = "running";
        if (mode === "start") {
          await writeText(
            `Starting **Wiki Run** \`${runId}\` for **${input.workspace.name}**…`,
          );
          workflow = { phase: "awaiting_plan", linkedRunId: runId };
          const ui = await openWikiWorkflowUiStream({
            kind: "start",
            runId,
            workspace: input.workspace,
            autoApprove: false,
            skipPlanConfirm: false,
            forcePlanConfirm: true,
          });
          // Pipe official workflow UI parts into this turn's stream.
          const reader = ui.stream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (value) {
              writer.write(value);
            }
          }
          await applyWorkflowResult(await ui.result());
          return;
        }

        await writeText(
          resumeData?.action === "approve"
            ? "Resuming Wiki Run…"
            : "Declining and closing the suspended gate…",
        );
        const ui = await openWikiWorkflowUiStream({
          kind: "resume",
          runId,
          step: resumeStep ?? "plan-gate",
          resumeData: {
            action: resumeData!.action,
            ...(resumeData!.plan ? { plan: resumeData!.plan } : {}),
          },
        });
        const reader = ui.stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            writer.write(value);
          }
        }
        await applyWorkflowResult(await ui.result());
      } catch (error) {
        status = "failed";
        await writeText(`Wiki Run failed: ${redactErrorMessage(error)}`);
        sideEffects = {
          upsertRun: {
            runId,
            status: "failed",
            summary: redactErrorMessage(error),
          },
        };
      }
    },
  });

  return {
    stream,
    finalize: async () => {
      const parts: SessionMessage["parts"] = [
        { type: "text", text: finalText || "(empty)", state: "done" },
        ...toolParts,
      ];
      if (pending) {
        parts.push({ type: "data-choice", data: pending });
      }
      return {
        assistantMessage: {
          id: assistantId,
          role: "assistant",
          parts,
          createdAt: new Date().toISOString(),
        },
        status,
        pending,
        workflow,
        sideEffects,
      };
    },
  };
}

/** Convert AI SDK UI messages to durable SessionMessage rows. */
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
      if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        parts.push({
          type: p.type,
          toolCallId: "toolCallId" in p ? String(p.toolCallId ?? "") : "",
          toolName:
            "toolName" in p
              ? String(p.toolName ?? p.type.slice(5))
              : p.type.slice(5),
          state: "state" in p ? (p.state as SessionMessage["parts"][0] extends never ? never : string) : "output-available",
          input: "input" in p ? p.input : undefined,
          output: "output" in p ? p.output : undefined,
        } as SessionMessage["parts"][number]);
        continue;
      }
      if (typeof p.type === "string" && p.type.startsWith("data-")) {
        parts.push({
          type: p.type,
          data: "data" in p ? p.data : undefined,
        } as SessionMessage["parts"][number]);
      }
    }
    return {
      id: m.id,
      role: m.role as SessionMessage["role"],
      parts,
      createdAt: new Date().toISOString(),
    };
  });
}
