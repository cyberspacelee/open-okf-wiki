/**
 * Nested card for Mastra subagent / agent-as-tool calls.
 * Uses AI Elements Task chrome for clearer multi-agent distinction.
 */

import { Badge } from "@/components/ui/badge";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from "@/components/ai-elements/task";
import { MessageResponse } from "@/components/ai-elements/message";
import type { UIMessage } from "ai";
import {
  BotIcon,
  GitBranchIcon,
  LeafIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  agentDisplayName,
  agentRoleKind,
  type AgentRoleKind,
} from "./session-tool-utils";
import { useI18n } from "../../i18n";
import { sessionCardMeta } from "./session-card-styles";

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
      return t.length > 160 ? `${t.slice(0, 160)}…` : t;
    }
  }
  return undefined;
}

function roleIcon(kind: AgentRoleKind): ReactNode {
  switch (kind) {
    case "domain":
      return <GitBranchIcon className="size-4 text-sky-600" />;
    case "leaf":
      return <LeafIcon className="size-4 text-emerald-600" />;
    case "reviewer":
      return <ShieldCheckIcon className="size-4 text-violet-600" />;
    default:
      return <BotIcon className="size-4 text-muted-foreground" />;
  }
}

function roleBadgeClass(kind: AgentRoleKind): string {
  switch (kind) {
    case "domain":
      return "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-200";
    case "leaf":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200";
    case "reviewer":
      return "border-violet-500/40 bg-violet-500/10 text-violet-800 dark:text-violet-200";
    default:
      return "";
  }
}

function stateLabel(
  state: string,
  tools: { subagentRunning: string; noReceipt: string },
): string {
  if (
    state === "input-streaming" ||
    state === "input-available" ||
    state === "approval-requested"
  ) {
    return tools.subagentRunning;
  }
  if (state === "output-error") {
    return "Failed";
  }
  return "Done";
}

export type SubagentCardProps = {
  part: ToolPart;
  toolName: string;
  partKey: string;
};

export function SubagentCard({ part, toolName, partKey: _partKey }: SubagentCardProps) {
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
  const kind = agentRoleKind(toolName);
  const label = agentDisplayName(toolName);
  const scope = scopeFromInput(input);
  const summary = summaryFromOutput(output);
  const running =
    state === "input-streaming" ||
    state === "input-available" ||
    state === "approval-requested";
  const title = scope ? `${label}: ${scope}` : label;

  return (
    <div
      className="mb-2 rounded-lg border border-border/80 bg-card/40 px-3 py-2"
      data-testid="session-subagent-part"
      data-agent-name={toolName}
      data-agent-role={kind}
    >
      <Task defaultOpen={running || Boolean(errorText)} className="w-full">
        <TaskTrigger title={title} className="w-full">
          <div className="flex w-full cursor-pointer items-center gap-2 text-sm transition-colors hover:text-foreground">
            {roleIcon(kind)}
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {title}
            </span>
            <Badge
              variant="outline"
              className={`shrink-0 text-[10px] ${roleBadgeClass(kind)}`}
            >
              {label}
            </Badge>
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {stateLabel(state, tools)}
            </Badge>
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0" />
          </div>
        </TaskTrigger>
        <TaskContent>
          <TaskItem>
            <span className={sessionCardMeta}>
              <span className="font-medium text-foreground">
                {tools.subagent}
              </span>
              {" · "}
              {toolName}
            </span>
          </TaskItem>
          {scope ? (
            <TaskItem>
              <span className="font-medium text-foreground">{tools.scope}: </span>
              {scope}
            </TaskItem>
          ) : null}
          {errorText ? (
            <TaskItem>
              <p className="whitespace-pre-wrap break-words text-xs text-destructive">
                {errorText}
              </p>
            </TaskItem>
          ) : summary ? (
            <TaskItem>
              <div
                className="max-h-56 overflow-y-auto rounded-md border bg-muted/20 p-3"
                data-testid="session-subagent-summary"
              >
                <MessageResponse className="size-full text-xs [&>*:first-child]:mt-0">
                  {summary}
                </MessageResponse>
              </div>
            </TaskItem>
          ) : (
            <TaskItem>
              <span className={sessionCardMeta}>
                {running ? tools.subagentRunning : tools.noReceipt}
              </span>
            </TaskItem>
          )}
        </TaskContent>
      </Task>
    </div>
  );
}
