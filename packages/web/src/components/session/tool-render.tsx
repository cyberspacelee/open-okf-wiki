/**
 * Tool part → SessionCard + registered body.
 * AI Elements Tool shell is replaced by SessionCard for timeline consistency;
 * ToolInput/ToolOutput remain for compact generic dumps.
 */

import type { UIMessage } from "ai";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { toolSummaryTitle } from "./tool-summary";
import { renderToolBody } from "./tool-bodies";
import { SessionCard, type SessionCardStatus } from "./SessionCard";

export { toolSummaryTitle } from "./tool-summary";
export { unwrapToolPayload } from "./session-tool-utils";
export { TOOL_BODY_REGISTRY, renderToolBody } from "./tool-bodies";

type ToolPart = UIMessage["parts"][number];

function mapToolStateToCardStatus(
  state: string,
): SessionCardStatus {
  switch (state) {
    case "input-streaming":
      return "pending";
    case "input-available":
    case "approval-requested":
      return "running";
    case "output-available":
    case "approval-responded":
      return "completed";
    case "output-error":
      return "failed";
    case "output-denied":
      return "denied";
    default:
      return "completed";
  }
}

function statusIcon(status: SessionCardStatus) {
  switch (status) {
    case "running":
      return <ClockIcon className="size-4 animate-pulse" />;
    case "pending":
      return <CircleIcon className="size-4" />;
    case "failed":
      return <XCircleIcon className="size-4 text-destructive" />;
    case "denied":
      return <XCircleIcon className="size-4 text-orange-600" />;
    case "completed":
      return <CheckCircleIcon className="size-4 text-green-600" />;
    default:
      return <WrenchIcon className="size-4" />;
  }
}

export type RenderToolPartOptions = {
  key: string;
  part: ToolPart;
  toolName: string;
  onApproval?: (approved: boolean, approvalId: string) => void;
};

/**
 * Render one tool UI part. Returns null for suppressed HITL fakes.
 */
export function renderSessionToolPart({
  key,
  part,
  toolName,
  onApproval,
}: RenderToolPartOptions) {
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

  const input = "input" in part ? part.input : undefined;
  const output = "output" in part ? part.output : undefined;
  const errorText =
    "errorText" in part ? (part.errorText as string | undefined) : undefined;

  const title = toolSummaryTitle(toolName, input, output, state);
  const cardStatus = mapToolStateToCardStatus(state);
  const defaultOpen =
    state === "input-streaming" ||
    state === "input-available" ||
    state === "output-error";

  return (
    <SessionCard
      key={key}
      title={title}
      icon={statusIcon(cardStatus)}
      status={cardStatus}
      defaultOpen={defaultOpen}
      failed={cardStatus === "failed"}
      data-testid="session-tool-part"
      dataAttrs={{ "tool-name": toolName }}
    >
      {renderToolBody({
        toolName,
        input,
        output,
        errorText,
      })}
    </SessionCard>
  );
}
