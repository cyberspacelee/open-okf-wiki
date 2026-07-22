/**
 * Tool call parts (non-agent) on the Session timeline.
 */

import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { isAgentToolName, toolNameFromPart } from "../session-tool-utils";
import { renderSessionToolPart } from "../tool-render";
import { SubagentCard } from "../SubagentCard";

export type ToolPartApproval = (
  approved: boolean,
  approvalId: string,
) => void;

export function renderToolOrAgent(
  key: string,
  part: UIMessage["parts"][number],
  onApproval?: ToolPartApproval,
): ReactNode {
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

export function renderToolPart(
  key: string,
  part: UIMessage["parts"][number],
  onApproval?: ToolPartApproval,
): ReactNode {
  if (part.type === "dynamic-tool" || isToolUIPart(part)) {
    return renderToolOrAgent(key, part, onApproval);
  }
  return undefined;
}
