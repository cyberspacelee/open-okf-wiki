/**
 * Nested card for Mastra subagent / agent-as-tool calls — SessionCard shell.
 */

import { Badge } from "@/components/ui/badge";
import { BotIcon } from "lucide-react";
import type { UIMessage } from "ai";
import { MessageResponse } from "@/components/ai-elements/message";
import { agentDisplayName } from "./session-tool-utils";
import { useI18n } from "../../i18n";
import {
  SessionCard,
  type SessionCardStatus,
} from "./SessionCard";
import { sessionCardBadge, sessionCardMeta } from "./session-card-styles";

type ToolPart = UIMessage["parts"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function summaryFromOutput(output: unknown): string | undefined {
  if (typeof output === "string" && output.trim()) {
    return output.length > 600 ? `${output.slice(0, 600)}…` : output;
  }
  if (!isRecord(output)) {
    return undefined;
  }
  for (const key of ["summary", "text", "result", "findings", "content"]) {
    const v = output[key];
    if (typeof v === "string" && v.trim()) {
      return v.length > 600 ? `${v.slice(0, 600)}…` : v;
    }
  }
  try {
    const s = JSON.stringify(output, null, 2);
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return undefined;
  }
}

function scopeFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  for (const key of [
    "prompt",
    "message",
    "scope",
    "query",
    "task",
    "instructions",
  ]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim().replace(/\s+/g, " ");
      return t.length > 120 ? `${t.slice(0, 120)}…` : t;
    }
  }
  return undefined;
}

function stateToStatus(state: string): SessionCardStatus {
  if (
    state === "input-streaming" ||
    state === "input-available" ||
    state === "approval-requested"
  ) {
    return "running";
  }
  if (state === "output-error") {
    return "failed";
  }
  return "completed";
}

export type SubagentCardProps = {
  part: ToolPart;
  toolName: string;
  partKey: string;
};

export function SubagentCard({ part, toolName, partKey }: SubagentCardProps) {
  const { t } = useI18n();
  const tools = t.session.tools;
  const state =
    "state" in part && typeof part.state === "string"
      ? part.state
      : "output-available";
  const input = "input" in part ? part.input : undefined;
  const output = "output" in part ? part.output : undefined;
  const errorText =
    "errorText" in part ? (part.errorText as string | undefined) : undefined;
  const label = agentDisplayName(toolName);
  const scope = scopeFromInput(input);
  const summary = summaryFromOutput(output);
  const cardStatus = stateToStatus(state);
  const running = cardStatus === "running";
  const title = scope ? `${label}: ${scope}` : label;

  return (
    <SessionCard
      key={partKey}
      title={title}
      icon={<BotIcon className="size-4" />}
      status={cardStatus}
      defaultOpen={running || Boolean(errorText)}
      failed={cardStatus === "failed"}
      data-testid="session-subagent-part"
      dataAttrs={{ "agent-name": toolName }}
      badges={
        <Badge variant="secondary" className={sessionCardBadge}>
          {tools.subagent}
        </Badge>
      }
    >
      {scope ? (
        <p className={sessionCardMeta}>
          <span className="font-medium text-foreground">{tools.scope}: </span>
          {scope}
        </p>
      ) : null}
      {errorText ? (
        <p className="whitespace-pre-wrap break-words text-xs text-destructive">
          {errorText}
        </p>
      ) : summary ? (
        <div
          className="max-h-56 overflow-y-auto rounded-md border bg-muted/20 p-3"
          data-testid="session-subagent-summary"
        >
          <MessageResponse className="size-full text-xs [&>*:first-child]:mt-0">
            {summary}
          </MessageResponse>
        </div>
      ) : (
        <p className={sessionCardMeta}>
          {running ? tools.subagentRunning : tools.noReceipt}
        </p>
      )}
    </SessionCard>
  );
}
