/**
 * Product Session timeline part dispatcher.
 *
 * Architecture (skill-aligned, product-specific):
 * - AI Elements: MessageResponse, Reasoning, Suggestion (text primitives)
 * - SessionCard: single chrome for tools / workflow / phase / batch / subagent
 * - data-* whitelist only — unknown data parts are not rendered
 * - tool bodies via TOOL_BODY_REGISTRY (tool-bodies.tsx)
 * - Part families: GateParts, PlanChrome, ToolParts, SubagentParts, ProgressParts
 */

import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  groupPartsForRender,
  writtenPathsFromMessages,
} from "./session-tool-utils";
import { extractRunTimelineChrome } from "./run-timeline-extract";
import { RunPhaseStrip } from "./RunPhaseStrip";
import { RunPagesQueue } from "./RunPagesQueue";
import { RunSourcesPanel } from "./RunSourcesPanel";
import { RunCheckpoint } from "./RunCheckpoint";
import { ToolBatch } from "./ToolBatch";
import { DATA_PART_WHITELIST } from "./parts/message-part-utils";
import { renderGatePart } from "./parts/GateParts";
import { renderPlanPart } from "./parts/PlanChrome";
import { renderToolPart } from "./parts/ToolParts";
import { renderSubagentPart } from "./parts/SubagentParts";
import { renderProgressPart } from "./parts/ProgressParts";

export type MessagePartsProps = {
  message: UIMessage;
  isLatestAssistant?: boolean;
  onChoice?: (optionId: string) => void;
  onApproval?: (approved: boolean, approvalId: string) => void;
  writtenPaths?: ReadonlySet<string> | readonly string[];
};

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

  const toolNode = renderToolPart(key, part, onApproval);
  if (toolNode !== undefined) {
    return toolNode;
  }

  if (part.type === "step-start") {
    return null;
  }

  if (typeof part.type === "string" && part.type.startsWith("data-")) {
    // Whitelist only — no dashed JSON dump for unknown product parts.
    if (!DATA_PART_WHITELIST.has(part.type)) {
      return null;
    }

    const gateNode = renderGatePart(key, part, {
      isLatestAssistant,
      onChoice,
    });
    if (gateNode !== undefined) {
      return gateNode;
    }

    const planNode = renderPlanPart(key, part, { writtenPaths });
    if (planNode !== undefined) {
      return planNode;
    }

    const subagentNode = renderSubagentPart(key, part);
    if (subagentNode !== undefined) {
      return subagentNode;
    }

    const progressNode = renderProgressPart(key, part, {
      writtenPaths,
      hasDataPlan,
    });
    if (progressNode !== undefined) {
      return progressNode;
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
  const chrome = extractRunTimelineChrome(message.parts ?? []);

  return (
    <>
      {chrome.phaseSteps.length > 0 ? (
        <RunPhaseStrip
          label={chrome.phaseLabel ?? "Wiki Run"}
          steps={chrome.phaseSteps}
          defaultOpen={isLatestAssistant}
        />
      ) : null}
      {chrome.pages.length > 0 ? (
        <RunPagesQueue pages={chrome.pages} />
      ) : null}
      {chrome.sources.length > 0 ? (
        <RunSourcesPanel sources={chrome.sources} />
      ) : null}
      {chrome.hasPlan ? (
        <RunCheckpoint
          label="Plan Spec confirmed / proposed"
          testId="session-checkpoint-plan"
        />
      ) : null}
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
      {chrome.produceDone ? (
        <RunCheckpoint
          label="Ready to publish"
          testId="session-checkpoint-done"
        />
      ) : null}
    </>
  );
}
