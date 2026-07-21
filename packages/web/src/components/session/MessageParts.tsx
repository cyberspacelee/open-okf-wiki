/**
 * Product Session timeline part dispatcher.
 *
 * Architecture (skill-aligned, product-specific):
 * - AI Elements: MessageResponse, Reasoning, Suggestion (text primitives)
 * - SessionCard: single chrome for tools / workflow / phase / batch / subagent
 * - data-* whitelist only — unknown data parts are not rendered
 * - tool bodies via TOOL_BODY_REGISTRY (tool-bodies.tsx)
 */

import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  Suggestion,
  Suggestions,
} from "@/components/ai-elements/suggestion";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2Icon,
  CircleIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import { useI18n } from "../../i18n";
import type { PendingInteraction } from "./decision-types";
import { PlanViewer } from "./PlanViewer";
import type { PlanLike } from "./plan-markdown";
import { renderSessionToolPart } from "./tool-render";
import { SubagentCard } from "./SubagentCard";
import { ToolBatch } from "./ToolBatch";
import { PhaseProgress } from "./PhaseProgress";
import {
  SessionCard,
  SessionCardAdvanced,
  SessionCardMono,
  type SessionCardStatus,
} from "./SessionCard";
import { sessionCardMeta } from "./session-card-styles";
import {
  groupPartsForRender,
  isAgentToolName,
  toolNameFromPart,
  writtenPathsFromMessages,
} from "./session-tool-utils";

/** Product data-* parts that may appear on the operator timeline. */
const DATA_PART_WHITELIST = new Set([
  "data-gate",
  "data-plan",
  "data-plan-progress",
  "data-progress",
  "data-run",
  "data-workflow",
  "data-workflow-step",
  "data-tool-workflow",
  "data-tool-agent",
]);

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
          s.replace(
            /"content"\s*:\s*"(?:\\.|[^"\\]){20,}"/g,
            '"content":"[omitted]"',
          ),
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
  isLatestAssistant?: boolean;
  onChoice?: (optionId: string) => void;
  onApproval?: (approved: boolean, approvalId: string) => void;
  writtenPaths?: ReadonlySet<string> | readonly string[];
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
    if ((payload as { gate?: unknown }).gate === "plan") {
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
    (d.step &&
    typeof d.step === "object" &&
    typeof (d.step as { name?: string }).name === "string"
      ? (d.step as { name: string }).name
      : undefined) ||
    (typeof d.runId === "string" ? d.runId.slice(0, 8) : undefined);
  if (name && status) {
    return `${name}: ${status}`;
  }
  return status || name || partType.replace(/^data-/, "");
}

function workflowErrorFromData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const d = data as Record<string, unknown>;
  if (typeof d.error === "string" && d.error.trim()) {
    return d.error.trim();
  }
  if (d.steps && typeof d.steps === "object") {
    for (const [id, step] of Object.entries(
      d.steps as Record<string, unknown>,
    )) {
      if (!step || typeof step !== "object") {
        continue;
      }
      const s = step as Record<string, unknown>;
      if (s.status === "failed" || s.status === "error") {
        if (typeof s.error === "string" && s.error.trim()) {
          return `${id}: ${s.error.trim()}`;
        }
        return `${id} failed`;
      }
    }
  }
  return undefined;
}

function isNoisyWorkflowPart(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }
  const status = String(
    (data as { status?: unknown }).status ?? "",
  ).toLowerCase();
  return status === "running" || status === "waiting" || status === "pending";
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

function workflowCardStatus(status: string, failed: boolean): SessionCardStatus {
  if (failed) {
    return "failed";
  }
  if (/success|complete|done|finish/i.test(status)) {
    return "completed";
  }
  if (/run|stream|active|start|suspend/i.test(status)) {
    return "running";
  }
  return "idle";
}

function WorkflowStepCard({
  label,
  data,
  partType,
}: {
  label: string;
  data: unknown;
  partType: string;
}) {
  const { t } = useI18n();
  const status =
    data && typeof data === "object" && "status" in data
      ? String((data as { status?: unknown }).status ?? "")
      : "";
  const err = workflowErrorFromData(data);
  const failed = /fail|error/i.test(status) || Boolean(err);
  const cardStatus = workflowCardStatus(status, failed);
  const Icon =
    cardStatus === "failed"
      ? XCircleIcon
      : cardStatus === "completed"
        ? CheckCircle2Icon
        : cardStatus === "running"
          ? LoaderIcon
          : CircleIcon;

  return (
    <SessionCard
      title={label}
      icon={
        <Icon
          className={
            cardStatus === "running"
              ? "size-4 animate-spin"
              : cardStatus === "failed"
                ? "size-4 text-destructive"
                : cardStatus === "completed"
                  ? "size-4 text-green-600"
                  : "size-4"
          }
        />
      }
      status={cardStatus}
      failed={failed}
      defaultOpen={failed}
      data-testid="session-workflow-progress"
      dataAttrs={{ "part-type": partType, status: status || undefined }}
    >
      {err ? (
        <p className="whitespace-pre-wrap break-words text-xs text-destructive">
          {err}
        </p>
      ) : (
        <p className={sessionCardMeta}>
          {status || partType.replace(/^data-/, "")}
        </p>
      )}
      <SessionCardAdvanced label={t.session.tools.advancedRaw}>
        <SessionCardMono>
          {JSON.stringify(redactUnknown(data), null, 2)}
        </SessionCardMono>
      </SessionCardAdvanced>
    </SessionCard>
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

function PlanProgressBadge({
  written,
  total,
}: {
  written: number;
  total: number;
}) {
  const { t } = useI18n();
  const text = t.session.tools.pagesWritten
    .replace("{written}", String(written))
    .replace("{total}", String(total));
  return (
    <p className={`mb-2 ${sessionCardMeta}`} data-testid="session-plan-progress">
      {text}
    </p>
  );
}

function renderToolOrAgent(
  key: string,
  part: UIMessage["parts"][number],
  onApproval: MessagePartsProps["onApproval"],
) {
  const toolName = toolNameFromPart(part) ?? "tool";
  if (isAgentToolName(toolName) || part.type === "data-tool-agent") {
    return (
      <SubagentCard key={key} part={part} toolName={toolName} partKey={key} />
    );
  }
  return renderSessionToolPart({
    key,
    part,
    toolName,
    onApproval,
  });
}

function renderSinglePart(
  key: string,
  part: UIMessage["parts"][number],
  opts: {
    isLatestAssistant?: boolean;
    onChoice?: MessagePartsProps["onChoice"];
    onApproval?: MessagePartsProps["onApproval"];
    writtenPaths: ReadonlySet<string> | readonly string[];
    hasDataPlan: boolean;
  },
): ReactNode {
  const { isLatestAssistant, onChoice, onApproval, writtenPaths, hasDataPlan } =
    opts;

  if (part.type === "text") {
    return (
      <div key={key} data-testid="session-message-text">
        <MessageResponse>{part.text}</MessageResponse>
      </div>
    );
  }

  if (part.type === "reasoning") {
    const text = "text" in part ? String(part.text ?? "") : "";
    const streaming = "state" in part && part.state === "streaming";
    if (!text && !streaming) {
      return null;
    }
    return (
      <Reasoning
        key={key}
        isStreaming={Boolean(streaming)}
        defaultOpen={streaming}
      >
        <ReasoningTrigger />
        <ReasoningContent>{text}</ReasoningContent>
      </Reasoning>
    );
  }

  if (part.type === "dynamic-tool" || isToolUIPart(part)) {
    return renderToolOrAgent(key, part, onApproval);
  }

  if (part.type === "step-start") {
    return null;
  }

  if (typeof part.type === "string" && part.type.startsWith("data-")) {
    // Whitelist only — no dashed JSON dump for unknown product parts.
    if (!DATA_PART_WHITELIST.has(part.type)) {
      return null;
    }

    const data = "data" in part ? part.data : undefined;

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
          <DecisionChips key={key} decision={decision} onChoice={onChoice} />
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

    if (part.type === "data-plan") {
      const plan = asPlanLike(data);
      if (plan) {
        return (
          <div key={key}>
            <PlanViewer plan={plan} writtenPaths={writtenPaths} />
          </div>
        );
      }
      return null;
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
      if (!runId) {
        return null;
      }
      return (
        <div key={key} className="mb-2" data-testid="session-data-run">
          <Badge variant="outline" className="font-mono text-xs">
            run {runId.slice(0, 8)}…{status ? ` · ${status}` : ""}
          </Badge>
        </div>
      );
    }

    if (part.type === "data-progress") {
      if (data && typeof data === "object" && "phase" in data) {
        const d = data as {
          phase?: unknown;
          label?: unknown;
          runId?: unknown;
          failed?: unknown;
        };
        const phase = String(d.phase ?? "");
        if (!phase) {
          return null;
        }
        return (
          <PhaseProgress
            key={key}
            phase={phase}
            label={typeof d.label === "string" ? d.label : undefined}
            runId={typeof d.runId === "string" ? d.runId : undefined}
            failed={Boolean(d.failed)}
          />
        );
      }
      return null;
    }

    if (part.type === "data-plan-progress") {
      if (
        data &&
        typeof data === "object" &&
        Array.isArray((data as { pages?: unknown }).pages)
      ) {
        const pages = (data as { pages: Array<{ status?: string }> }).pages;
        const written = pages.filter((p) => p.status === "written").length;
        return (
          <PlanProgressBadge key={key} written={written} total={pages.length} />
        );
      }
      return null;
    }

    if (part.type === "data-tool-agent") {
      const toolName =
        data && typeof data === "object" && "name" in data
          ? String((data as { name?: unknown }).name ?? "agent")
          : "agent";
      return (
        <SubagentCard
          key={key}
          part={
            {
              type: "dynamic-tool",
              toolCallId: key,
              toolName,
              state: "output-available",
              input: data,
              output:
                data && typeof data === "object" && "result" in data
                  ? (data as { result?: unknown }).result
                  : data,
            } as UIMessage["parts"][number]
          }
          toolName={toolName}
          partKey={key}
        />
      );
    }

    if (
      part.type === "data-workflow" ||
      part.type === "data-workflow-step" ||
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
                    (
                      data as {
                        step?: { suspendPayload?: { plan?: unknown } };
                      }
                    ).step?.suspendPayload as { plan?: unknown } | undefined
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
            <PlanViewer plan={plan} writtenPaths={writtenPaths} />
          </div>
        );
      }
      if (isNoisyWorkflowPart(data) && !workflowErrorFromData(data)) {
        return null;
      }
      return (
        <WorkflowStepCard
          key={key}
          label={workflowProgressLabel(data, part.type)}
          data={data}
          partType={part.type}
        />
      );
    }

    return null;
  }

  return null;
}

export function MessageParts({
  message,
  isLatestAssistant,
  onChoice,
  onApproval,
  writtenPaths: writtenPathsProp,
}: MessagePartsProps) {
  const hasDataPlan = message.parts.some((p) => p.type === "data-plan");
  const writtenPaths =
    writtenPathsProp ?? writtenPathsFromMessages(message);
  const items = groupPartsForRender(message.parts ?? []);

  return (
    <>
      {items.map((item) => {
        if (item.kind === "batch") {
          return (
            <ToolBatch
              key={`${message.id}-batch-${item.start}`}
              messageId={message.id}
              toolName={item.toolName}
              parts={item.parts}
              startIndex={item.start}
              onApproval={onApproval}
            />
          );
        }
        return renderSinglePart(`${message.id}-${item.index}`, item.part, {
          isLatestAssistant,
          onChoice,
          onApproval,
          writtenPaths,
          hasDataPlan,
        });
      })}
    </>
  );
}
