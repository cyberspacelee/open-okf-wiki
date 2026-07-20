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
  Plan,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
} from "@/components/ai-elements/plan";
import {
  Suggestion,
  Suggestions,
} from "@/components/ai-elements/suggestion";
import type { PendingInteraction } from "./decision-types";

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

export function MessageParts({
  message,
  isLatestAssistant,
  onChoice,
  onApproval,
}: MessagePartsProps) {
  // Prefer tool-request_user_decision over data-choice to avoid double chips.
  const hasDecisionTool = message.parts.some(
    (p) =>
      isToolUIPart(p) &&
      (p.type === "tool-request_user_decision" ||
        ("toolName" in p && p.toolName === "request_user_decision")),
  );

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
                    {decision.options.map((opt) => (
                      <Suggestion
                        key={opt.id}
                        suggestion={opt.label}
                        onClick={() => onChoice(opt.id)}
                        data-testid={`session-choice-${opt.id}`}
                      />
                    ))}
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
                  {decision.options.map((opt) => (
                    <Suggestion
                      key={opt.id}
                      suggestion={opt.label}
                      onClick={() => onChoice(opt.id)}
                      data-testid={`session-choice-${opt.id}`}
                    />
                  ))}
                </Suggestions>
              </div>
            );
          }
          // Optional plan-shaped data
          if (
            data &&
            typeof data === "object" &&
            "pages" in (data as object) &&
            "summary" in (data as object)
          ) {
            const plan = data as {
              summary: string;
              pages: Array<{ path: string; purpose: string }>;
            };
            return (
              <Plan key={key} defaultOpen>
                <PlanHeader>
                  <PlanTitle>Wiki plan</PlanTitle>
                  <PlanDescription>{plan.summary}</PlanDescription>
                </PlanHeader>
                <PlanContent>
                  <ul className="list-disc pl-5 text-sm">
                    {plan.pages.map((p) => (
                      <li key={p.path}>
                        <code>{p.path}</code> — {p.purpose}
                      </li>
                    ))}
                  </ul>
                </PlanContent>
              </Plan>
            );
          }
        }

        return null;
      })}
    </>
  );
}
