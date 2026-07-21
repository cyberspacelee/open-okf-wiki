import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import {
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  Suggestion,
  Suggestions,
} from "@/components/ai-elements/suggestion";
import { useI18n } from "../../i18n";
import type { PendingInteraction } from "./decision-types";
import { PlanViewer } from "./PlanViewer";
import type { PlanLike } from "./plan-markdown";

function redactUnknown(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  }
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(value);
      if (s.length > 800) {
        return JSON.parse(
          s.replace(/"content"\s*:\s*"(?:\\.|[^"\\]){20,}"/g, '"content":"[omitted]"'),
        );
      }
      return value;
    } catch {
      return "[unserializable]";
    }
  }
  return value;
}

export type MessagePartsProps = {
  message: UIMessage;
  /** When this is the latest assistant message, surface decision chips. */
  isLatestAssistant?: boolean;
  onChoice?: (optionId: string) => void;
  onApproval?: (approved: boolean, approvalId: string) => void;
};

function asDecision(input: unknown): PendingInteraction | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const o = input as Record<string, unknown>;
  if (typeof o.question !== "string") {
    return null;
  }
  const options = Array.isArray(o.options) ? o.options : [];
  return {
    type: (o.type as PendingInteraction["type"]) ?? "choice",
    question: o.question,
    mode: (o.mode as PendingInteraction["mode"]) ?? "choice_or_input",
    selectionMode: (o.selectionMode as "single" | "multi") ?? "single",
    options: options
      .filter((x): x is { id: string; label: string; description?: string } =>
        Boolean(x && typeof x === "object" && "id" in x && "label" in x),
      )
      .map((x) => ({
        id: String(x.id),
        label: String(x.label),
        description:
          typeof x.description === "string" ? x.description : undefined,
      })),
    inputPlaceholder:
      typeof o.inputPlaceholder === "string" ? o.inputPlaceholder : undefined,
    toolCallId: typeof o.toolCallId === "string" ? o.toolCallId : undefined,
  };
}

function asPlanLike(value: unknown): PlanLike | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.summary !== "string" || !Array.isArray(o.pages)) {
    return null;
  }
  const pages = o.pages
    .filter(
      (p): p is { path: string; purpose: string } =>
        Boolean(
          p &&
            typeof p === "object" &&
            typeof (p as { path?: unknown }).path === "string" &&
            typeof (p as { purpose?: unknown }).purpose === "string",
        ),
    )
    .map((p) => ({ path: p.path, purpose: p.purpose }));
  if (pages.length === 0) {
    return null;
  }
  return {
    summary: o.summary,
    pages,
    notes: typeof o.notes === "string" ? o.notes : undefined,
  };
}

/**
 * Prefer product data-plan; fall back to Mastra data-workflow suspendPayload.plan
 * (official AI SDK / Mastra part shape).
 */
function planFromWorkflowDataPart(data: unknown): PlanLike | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const steps = (data as { steps?: unknown }).steps;
  if (!steps || typeof steps !== "object") {
    return null;
  }
  for (const step of Object.values(steps as Record<string, unknown>)) {
    if (!step || typeof step !== "object") {
      continue;
    }
    const status = (step as { status?: unknown }).status;
    const payload = (step as { suspendPayload?: unknown }).suspendPayload;
    if (status !== "suspended" || !payload || typeof payload !== "object") {
      continue;
    }
    const gate = (payload as { gate?: unknown }).gate;
    if (gate === "plan") {
      const plan = asPlanLike((payload as { plan?: unknown }).plan);
      if (plan) {
        return plan;
      }
    }
  }
  return null;
}

function localizeDecisionOption(
  opt: PendingInteraction["options"][number],
  t: ReturnType<typeof useI18n>["t"],
): PendingInteraction["options"][number] {
  const blob = `${opt.label} ${opt.description ?? ""}`;
  switch (opt.id) {
    case "publish_now":
      return { ...opt, label: t.planConfirm.chipPublish };
    case "keep_staging":
      return { ...opt, label: t.planConfirm.chipKeepStaging };
    case "revise":
    case "request_changes":
    case "request-changes":
      return { ...opt, label: t.planConfirm.chipRevise };
    case "approve":
    case "approve_write": {
      if (/publish/i.test(blob)) {
        return { ...opt, label: t.planConfirm.chipPublish };
      }
      const n =
        Number(/(\d+)/.exec(opt.label)?.[1]) ||
        (opt.description
          ? opt.description.split(",").map((s) => s.trim()).filter(Boolean)
              .length
          : 0) ||
        1;
      return {
        ...opt,
        label: t.planConfirm.chipWrite.replace("{n}", String(n)),
      };
    }
    case "deny":
    case "reject_plan":
      if (/staging|keep/i.test(blob)) {
        return { ...opt, label: t.planConfirm.chipKeepStaging };
      }
      return { ...opt, label: t.planConfirm.chipDeny };
    default:
      return opt;
  }
}

export function MessageParts({
  message,
  isLatestAssistant,
  onChoice,
  onApproval,
}: MessagePartsProps) {
  const { t } = useI18n();
  // Prefer tool-request_user_decision over data-choice to avoid double chips.
  const hasDecisionTool = message.parts.some(
    (p) =>
      isToolUIPart(p) &&
      (p.type === "tool-request_user_decision" ||
        ("toolName" in p && p.toolName === "request_user_decision")),
  );
  // Prefer explicit data-plan; otherwise recover from official data-workflow.
  const hasDataPlan = message.parts.some((p) => p.type === "data-plan");

  return (
    <>
      {message.parts.map((part, index) => {
        const key = `${message.id}-${index}`;

        if (part.type === "text") {
          return (
            <div key={key} data-testid="session-message-text">
              <MessageResponse>{part.text}</MessageResponse>
            </div>
          );
        }

        if (isToolUIPart(part)) {
          const toolName =
            "toolName" in part && typeof part.toolName === "string"
              ? part.toolName
              : part.type.replace(/^tool-/, "");
          const decision =
            toolName === "request_user_decision"
              ? asDecision(part.input)
              : null;

          // Approval UI for tools that use AI SDK approval state
          if (
            part.state === "approval-requested" &&
            "approval" in part &&
            part.approval &&
            onApproval
          ) {
            const approval = part.approval as { id: string };
            return (
              <Confirmation
                key={key}
                approval={part.approval as never}
                state={part.state}
              >
                <ConfirmationTitle>Tool approval required</ConfirmationTitle>
                <ConfirmationRequest>
                  Approve running <code>{toolName}</code>?
                </ConfirmationRequest>
                <ConfirmationActions>
                  <ConfirmationAction
                    variant="outline"
                    onClick={() => onApproval(false, approval.id)}
                  >
                    Reject
                  </ConfirmationAction>
                  <ConfirmationAction
                    onClick={() => onApproval(true, approval.id)}
                  >
                    Approve
                  </ConfirmationAction>
                </ConfirmationActions>
              </Confirmation>
            );
          }

          return (
            <div key={key} className="flex flex-col gap-2">
              <Tool defaultOpen={part.state !== "output-available"}>
                <ToolHeader
                  type={part.type as `tool-${string}`}
                  state={part.state}
                  title={toolName}
                />
                <ToolContent>
                  {"input" in part && part.input !== undefined ? (
                    <ToolInput input={redactUnknown(part.input) as object} />
                  ) : null}
                  <ToolOutput
                    output={
                      "output" in part && part.output !== undefined
                        ? redactUnknown(part.output)
                        : undefined
                    }
                    errorText={
                      "errorText" in part ? part.errorText : undefined
                    }
                  />
                </ToolContent>
              </Tool>

              {decision &&
              isLatestAssistant &&
              part.state === "input-available" &&
              onChoice &&
              decision.mode !== "input_only" ? (
                <div className="flex flex-col gap-2" data-testid="session-decision">
                  <p className="text-sm text-muted-foreground">{decision.question}</p>
                  <Suggestions>
                    {decision.options.map((opt) => {
                      const localized = localizeDecisionOption(opt, t);
                      return (
                        <Suggestion
                          key={opt.id}
                          suggestion={localized.label}
                          onClick={() => onChoice(opt.id)}
                          data-testid={`session-choice-${opt.id}`}
                        />
                      );
                    })}
                  </Suggestions>
                </div>
              ) : null}

              {decision &&
              isLatestAssistant &&
              decision.mode === "input_only" ? (
                <p className="text-sm text-muted-foreground" data-testid="session-input-only-hint">
                  {decision.question}
                  {decision.inputPlaceholder
                    ? ` — ${decision.inputPlaceholder}`
                    : ""}
                </p>
              ) : null}
            </div>
          );
        }

        if (typeof part.type === "string" && part.type.startsWith("data-")) {
          const data = "data" in part ? part.data : undefined;
          const decision = asDecision(data);
          if (
            decision &&
            !hasDecisionTool &&
            isLatestAssistant &&
            onChoice &&
            decision.mode !== "input_only"
          ) {
            return (
              <div key={key} className="flex flex-col gap-2" data-testid="session-decision">
                <p className="text-sm text-muted-foreground">{decision.question}</p>
                <Suggestions>
                  {decision.options.map((opt) => {
                    const localized = localizeDecisionOption(opt, t);
                    return (
                      <Suggestion
                        key={opt.id}
                        suggestion={localized.label}
                        onClick={() => onChoice(opt.id)}
                        data-testid={`session-choice-${opt.id}`}
                      />
                    );
                  })}
                </Suggestions>
              </div>
            );
          }
          // Structured plan (data-plan) — Markdown + fullscreen reader
          if (part.type === "data-plan") {
            const plan = asPlanLike(data);
            if (plan) {
              return (
                <div key={key}>
                  <PlanViewer plan={plan} />
                </div>
              );
            }
          }
          // Official Mastra AI SDK part: recover plan when product data-plan is missing.
          if (
            (part.type === "data-workflow" ||
              part.type === "data-workflow-step") &&
            !hasDataPlan
          ) {
            const plan =
              planFromWorkflowDataPart(data) ||
              (part.type === "data-workflow-step" &&
              data &&
              typeof data === "object"
                ? asPlanLike(
                    (
                      (data as { step?: { suspendPayload?: { plan?: unknown } } })
                        .step?.suspendPayload as { plan?: unknown } | undefined
                    )?.plan,
                  ) ||
                  asPlanLike(
                    (data as { suspendPayload?: { plan?: unknown } })
                      .suspendPayload?.plan,
                  )
                : null);
            if (plan) {
              return (
                <div key={key} data-testid="session-plan-from-workflow">
                  <PlanViewer plan={plan} />
                </div>
              );
            }
          }
        }

        return null;
      })}
    </>
  );
}
