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
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ChevronDownIcon } from "lucide-react";
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

function workflowProgressLabel(data: unknown, partType: string): string {
  if (!data || typeof data !== "object") {
    return partType.replace(/^data-/, "");
  }
  const d = data as Record<string, unknown>;
  const status = typeof d.status === "string" ? d.status : undefined;
  const name =
    (typeof d.name === "string" && d.name) ||
    (d.step && typeof d.step === "object" && typeof (d.step as { name?: string }).name === "string"
      ? (d.step as { name: string }).name
      : undefined) ||
    (typeof d.runId === "string" ? d.runId.slice(0, 8) : undefined);
  if (name && status) {
    return `${name}: ${status}`;
  }
  if (status) {
    return status;
  }
  if (name) {
    return name;
  }
  return partType.replace(/^data-/, "");
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

function renderToolPart(
  key: string,
  part: UIMessage["parts"][number],
  toolName: string,
  _isLatestAssistant: boolean | undefined,
  _onChoice: MessagePartsProps["onChoice"],
  onApproval: MessagePartsProps["onApproval"],
) {
  // HITL chips come from data-gate only — never from fake tool parts.
  if (toolName === "request_user_decision") {
    return null;
  }
  const state =
    "state" in part && typeof part.state === "string"
      ? part.state
      : "output-available";

  if (
    state === "approval-requested" &&
    "approval" in part &&
    part.approval &&
    onApproval
  ) {
    const approval = part.approval as { id: string };
    return (
      <Confirmation
        key={key}
        approval={part.approval as never}
        state={state as never}
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
          <ConfirmationAction onClick={() => onApproval(true, approval.id)}>
            Approve
          </ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>
    );
  }

  const header =
    part.type === "dynamic-tool" ? (
      <ToolHeader
        type="dynamic-tool"
        state={state as never}
        toolName={toolName}
        title={toolName}
      />
    ) : (
      <ToolHeader
        type={part.type as `tool-${string}`}
        state={state as never}
        title={toolName}
      />
    );

  return (
    <div key={key} className="flex flex-col gap-2" data-testid="session-tool-part">
      <Tool defaultOpen={state !== "output-available"}>
        {header}
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
            errorText={"errorText" in part ? (part.errorText as string | undefined) : undefined}
          />
        </ToolContent>
      </Tool>
    </div>
  );
}

function DecisionChips({
  decision,
  onChoice,
}: {
  decision: PendingInteraction;
  onChoice: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
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
  );
}

export function MessageParts({
  message,
  isLatestAssistant,
  onChoice,
  onApproval,
}: MessagePartsProps) {
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

        if (part.type === "reasoning") {
          const text = "text" in part ? String(part.text ?? "") : "";
          const streaming =
            "state" in part && part.state === "streaming";
          if (!text && !streaming) {
            return null;
          }
          return (
            <Reasoning key={key} isStreaming={Boolean(streaming)} defaultOpen={streaming}>
              <ReasoningTrigger />
              <ReasoningContent>{text}</ReasoningContent>
            </Reasoning>
          );
        }

        if (part.type === "dynamic-tool") {
          const toolName =
            "toolName" in part && typeof part.toolName === "string"
              ? part.toolName
              : "tool";
          return renderToolPart(
            key,
            part,
            toolName,
            isLatestAssistant,
            onChoice,
            onApproval,
          );
        }

        if (isToolUIPart(part)) {
          const toolName =
            "toolName" in part && typeof part.toolName === "string"
              ? part.toolName
              : part.type.replace(/^tool-/, "");
          return renderToolPart(
            key,
            part,
            toolName,
            isLatestAssistant,
            onChoice,
            onApproval,
          );
        }

        if (typeof part.type === "string" && part.type.startsWith("data-")) {
          const data = "data" in part ? part.data : undefined;
          // Product HITL: data-gate only (not data-choice / fake tools).
          if (part.type === "data-gate") {
            const decision = asDecision(data);
            const cancelled =
              data &&
              typeof data === "object" &&
              "cancelled" in data &&
              Boolean((data as { cancelled?: unknown }).cancelled);
            if (
              decision &&
              !cancelled &&
              isLatestAssistant &&
              onChoice &&
              decision.mode !== "input_only"
            ) {
              return (
                <DecisionChips
                  key={key}
                  decision={decision}
                  onChoice={onChoice}
                />
              );
            }
            if (
              decision &&
              !cancelled &&
              isLatestAssistant &&
              decision.mode === "input_only"
            ) {
              return (
                <p
                  key={key}
                  className="text-sm text-muted-foreground"
                  data-testid="session-input-only-hint"
                >
                  {decision.question}
                  {decision.inputPlaceholder
                    ? ` — ${decision.inputPlaceholder}`
                    : ""}
                </p>
              );
            }
            return null;
          }
          if (part.type === "data-choice") {
            // Legacy part type — ignore for chips (protocol replaced by data-gate).
            return null;
          }
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
          if (part.type === "data-run") {
            const runId =
              data && typeof data === "object" && "runId" in data
                ? String((data as { runId?: unknown }).runId ?? "")
                : "";
            const status =
              data && typeof data === "object" && "status" in data
                ? String((data as { status?: unknown }).status ?? "")
                : "";
            if (runId) {
              return (
                <div key={key} className="mb-2" data-testid="session-data-run">
                  <Badge variant="outline" className="font-mono text-xs">
                    run {runId.slice(0, 8)}…{status ? ` · ${status}` : ""}
                  </Badge>
                </div>
              );
            }
          }
          if (
            part.type === "data-workflow" ||
            part.type === "data-workflow-step" ||
            part.type === "data-tool-agent" ||
            part.type === "data-tool-workflow"
          ) {
            const plan =
              !hasDataPlan &&
              (part.type === "data-workflow" || part.type === "data-workflow-step")
                ? planFromWorkflowDataPart(data) ||
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
                    : null)
                : null;
            if (plan) {
              return (
                <div key={key} data-testid="session-plan-from-workflow">
                  <PlanViewer plan={plan} />
                </div>
              );
            }
            const label = workflowProgressLabel(data, part.type);
            return (
              <Collapsible
                key={key}
                className="mb-2 rounded-md border border-dashed"
                data-testid="session-workflow-progress"
              >
                <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40">
                  <span className="flex-1 truncate">{label}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0" />
                </CollapsibleTrigger>
                <CollapsibleContent className="border-t border-dashed px-3 py-2">
                  <pre className="max-h-40 overflow-auto text-[10px] leading-snug text-muted-foreground">
                    {JSON.stringify(redactUnknown(data), null, 2)}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            );
          }
          // Other data-* parts: collapsible dump (never silent null).
          return (
            <Collapsible
              key={key}
              className="mb-2 rounded-md border border-dashed"
              data-testid="session-data-part"
            >
              <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40">
                <span className="flex-1 truncate">{part.type}</span>
                <ChevronDownIcon className="size-3.5 shrink-0" />
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t border-dashed px-3 py-2">
                <pre className="max-h-40 overflow-auto text-[10px] leading-snug text-muted-foreground">
                  {JSON.stringify(redactUnknown(data), null, 2)}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          );
        }

        if (part.type === "step-start") {
          return null;
        }

        return null;
      })}
    </>
  );
}
