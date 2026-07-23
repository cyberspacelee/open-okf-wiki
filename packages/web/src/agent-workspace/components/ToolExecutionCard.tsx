/**
 * Shared tool call chrome for transcript + Work surface focus drawer.
 *
 * Header: verb + key arg (pi-web / OpenCode style) — not a raw JSON dump.
 * Body: primary content; full payload only when no structured summary exists.
 */

import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import {
  formatPayloadText,
  formatToolDisplay,
  type AgentToolCall,
} from "../hooks/project-agent-events";

export type ToolExecutionCardProps = {
  tool: AgentToolCall;
  /**
   * When the parent work unit is settled, keep completed tools collapsed.
   * Omit on the main transcript (open only for running/error).
   * Pass `false` while a unit is still active so non-done tools expand.
   */
  settled?: boolean;
};

function toolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "shell" || lower === "run") {
    return TerminalIcon;
  }
  if (
    lower === "read" ||
    lower === "write" ||
    lower === "edit" ||
    lower === "ls" ||
    lower === "list"
  ) {
    return FileIcon;
  }
  if (lower === "grep" || lower === "find" || lower === "glob") {
    return SearchIcon;
  }
  return WrenchIcon;
}

function StatusGlyph({ status }: { status: AgentToolCall["status"] }) {
  if (status === "running" || status === "pending") {
    return <Spinner className="size-3 shrink-0 text-primary" />;
  }
  if (status === "error") {
    return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />;
  }
  if (status === "done") {
    return <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />;
  }
  return null;
}

export function ToolExecutionCard({ tool, settled }: ToolExecutionCardProps) {
  const { t } = useI18n();
  const display = formatToolDisplay(tool.name, tool.input);
  const output = formatPayloadText(tool.output);
  const openDefault =
    tool.status === "running" ||
    tool.status === "error" ||
    (settled === false && tool.status !== "done");
  const Icon = toolIcon(tool.name);
  const hasBody = Boolean(display.body || display.details || output);

  return (
    <Collapsible
      defaultOpen={openDefault}
      className="w-full min-w-0 rounded-md border border-border/80 bg-muted/30"
      data-testid="tool-execution-card"
      data-tool-name={tool.name}
      data-tool-status={tool.status}
    >
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/60">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
        <StatusGlyph status={tool.status} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{display.title}</span>
          {display.subtitle ? (
            <span className="ml-1.5 text-muted-foreground">
              {display.subtitle}
            </span>
          ) : null}
        </span>
        <Badge
          variant={
            tool.status === "error"
              ? "destructive"
              : tool.status === "done"
                ? "secondary"
                : "outline"
          }
          className={cn("shrink-0 normal-case", tool.status === "running" && "animate-pulse")}
        >
          {tool.status}
        </Badge>
      </CollapsibleTrigger>
      {hasBody ? (
        <CollapsibleContent className="min-w-0 overflow-hidden border-t border-border/60 px-2.5 py-2">
          {display.body ? (
            <div className="mb-2 flex min-w-0 max-w-full flex-col gap-0.5">
              <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {t.agentWorkspace.toolInput}
              </div>
              <pre className="okf-code-snippet">{display.body}</pre>
            </div>
          ) : null}
          {display.details ? (
            <div className="mb-2 flex min-w-0 max-w-full flex-col gap-0.5">
              <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {t.agentWorkspace.toolDetails}
              </div>
              <pre className="okf-code-snippet">{display.details}</pre>
            </div>
          ) : null}
          {output ? (
            <div className="flex min-w-0 max-w-full flex-col gap-0.5">
              <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {t.agentWorkspace.toolOutput}
              </div>
              <pre className="okf-code-snippet">{output}</pre>
            </div>
          ) : null}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
