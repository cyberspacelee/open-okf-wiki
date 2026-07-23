/**
 * Tool call row — OpenCode BasicTool / pi-web specialized renderer style.
 *
 * Trigger (always visible):
 *   [status] [icon] title  subtitle  arg arg
 *
 * Expand (only when there is result / write body / console output):
 *   plain result text — NO "Input" / "Output" section labels.
 *
 * Known tools put args on the trigger line; they are never re-dumped as JSON.
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  formatToolDisplay,
  formatToolResultText,
  type AgentToolCall,
} from "../hooks/project-agent-events";

export type ToolExecutionCardProps = {
  tool: AgentToolCall;
  /**
   * When the parent work unit is settled, keep completed tools collapsed.
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
    return <Spinner className="size-3 shrink-0 text-muted-foreground" />;
  }
  if (status === "error") {
    return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />;
  }
  if (status === "done") {
    return (
      <CheckIcon className="size-3.5 shrink-0 text-success" />
    );
  }
  return null;
}

/**
 * Build expand body text.
 * OpenCode: expand children are result only (markdown/pre), never labeled Input.
 * pi-web bash: `> command\n\noutput` in one console block.
 */
function expandBody(
  kind: ReturnType<typeof formatToolDisplay>["kind"],
  opts: {
    command?: string;
    writePreview?: string;
    output: string;
    isError: boolean;
  },
): string {
  const { command, writePreview, output, isError } = opts;

  if (kind === "console") {
    // pi BashRenderer: combine command + output, no labels
    if (command && output) return `$ ${command}\n\n${output}`;
    if (command) return `$ ${command}`;
    return output;
  }

  if (kind === "write-body") {
    // Content preview then result — still no "Input"/"Output" chrome
    const parts: string[] = [];
    if (writePreview) parts.push(writePreview);
    if (output) parts.push(output);
    return parts.join("\n\n");
  }

  if (kind === "raw" && writePreview && !output) {
    return writePreview;
  }

  // output-only (and raw with result): just the result
  if (output) return output;
  if (isError) return "";
  return "";
}

export function ToolExecutionCard({ tool, settled }: ToolExecutionCardProps) {
  const display = formatToolDisplay(tool.name, tool.input);
  // Prefer already-extracted plain text; peel JSON envelopes if any remain.
  const output = formatToolResultText(tool.output) ?? "";
  const isError = tool.status === "error";
  const isRunning = tool.status === "running" || tool.status === "pending";

  const body = expandBody(display.kind, {
    command: display.command,
    writePreview: display.writePreview,
    output,
    isError,
  });

  // OpenCode: completed read is often header-only (no expand).
  // Expand when there is result text, write preview, console command, or error.
  const canExpand =
    !display.headerOnly &&
    (Boolean(body.trim()) ||
      isError ||
      (display.kind === "console" && Boolean(display.command)) ||
      (display.kind === "write-body" && Boolean(display.writePreview)));

  // Default open only while running/error — completed tools stay collapsed (OpenCode).
  const openDefault =
    isRunning ||
    isError ||
    (settled === false && tool.status !== "done" && canExpand);

  const Icon = toolIcon(tool.name);

  const trigger = (
    <div
      className={cn(
        "flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left text-xs",
        canExpand && "hover:bg-muted/50",
      )}
    >
      {canExpand ? (
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden />
      )}
      <StatusGlyph status={tool.status} />
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          isError ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate leading-5">
        <span
          className={cn(
            "font-medium",
            isRunning && "text-muted-foreground",
            isError && "text-destructive",
          )}
        >
          {display.title}
        </span>
        {display.subtitle ? (
          <span className="ml-1.5 text-muted-foreground">
            {display.subtitle}
          </span>
        ) : null}
        {display.args?.map((arg) => (
          <span
            key={arg}
            className="ml-1.5 font-mono text-[10px] text-muted-foreground/80"
          >
            {arg}
          </span>
        ))}
      </span>
    </div>
  );

  if (!canExpand) {
    // OpenCode read: single non-collapsible row
    return (
      <div
        className="w-full min-w-0 rounded-md"
        data-testid="tool-execution-card"
        data-tool-name={tool.name}
        data-tool-status={tool.status}
        data-header-only="true"
      >
        {trigger}
      </div>
    );
  }

  return (
    <Collapsible
      defaultOpen={openDefault}
      className="group w-full min-w-0 rounded-md"
      data-testid="tool-execution-card"
      data-tool-name={tool.name}
      data-tool-status={tool.status}
    >
      <CollapsibleTrigger className="w-full min-w-0 rounded-md text-left">
        {trigger}
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 overflow-hidden pl-8 pr-2 pb-1.5">
        {body.trim() ? (
          <pre
            className={cn(
              "okf-code-snippet max-h-64 overflow-auto text-[11px] leading-relaxed",
              isError && "text-destructive",
            )}
          >
            {body}
          </pre>
        ) : isRunning ? (
          <p className="text-[11px] text-muted-foreground">…</p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
