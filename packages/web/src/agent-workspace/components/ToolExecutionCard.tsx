/**
 * Tool call row — OpenCode BasicTool / pi-web specialized renderer style.
 *
 * Trigger (always visible):
 *   [status] [icon] title  subtitle  arg arg
 *
 * Expand (only when there is result / write body / console output / nested trail):
 *   plain result text — NO "Input" / "Output" section labels.
 *   optional nested React node (wiki_produce → ProduceTrail).
 *
 * Known tools put args on the trigger line; they are never re-dumped as JSON.
 */

import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileIcon,
  LayersIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  type AgentToolCall,
  formatToolDisplay,
  formatToolResultText,
  WIKI_PRODUCE_TOOL_NAME,
} from "../hooks/project-agent-events";

export type ToolExecutionCardProps = {
  tool: AgentToolCall;
  /**
   * When the parent work unit is settled, keep completed tools collapsed.
   * Pass `false` while a unit is still active so non-done tools expand.
   */
  settled?: boolean;
  /**
   * Nested trail (e.g. produce units under wiki_produce).
   * When set, the card always expands to host the trail.
   */
  nested?: ReactNode;
  /** Force open while nested work is active (running produce units). */
  nestedActive?: boolean;
};

function toolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower === WIKI_PRODUCE_TOOL_NAME || lower === "wiki_produce") {
    return LayersIcon;
  }
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
    return <CheckIcon className="size-3.5 shrink-0 text-success" />;
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
    if (command && output) return `$ ${command}\n\n${output}`;
    if (command) return `$ ${command}`;
    return output;
  }

  if (kind === "write-body") {
    const parts: string[] = [];
    if (writePreview) parts.push(writePreview);
    if (output) parts.push(output);
    return parts.join("\n\n");
  }

  if (kind === "raw" && writePreview && !output) {
    return writePreview;
  }

  if (output) return output;
  if (isError) return "";
  return "";
}

export function ToolExecutionCard({
  tool,
  settled,
  nested,
  nestedActive = false,
}: ToolExecutionCardProps) {
  const display = formatToolDisplay(tool.name, tool.input);
  const output = formatToolResultText(tool.output) ?? "";
  const isError = tool.status === "error";
  const isRunning = tool.status === "running" || tool.status === "pending";
  const hasNested = Boolean(nested);
  const isWikiProduce =
    tool.name === WIKI_PRODUCE_TOOL_NAME || tool.name.toLowerCase() === "wiki_produce";

  const body = expandBody(display.kind, {
    command: display.command,
    writePreview: display.writePreview,
    output,
    isError,
  });

  // Expand when result exists, or when hosting a nested produce trail.
  const canExpand =
    hasNested ||
    (!display.headerOnly &&
      (Boolean(body.trim()) ||
        isError ||
        (display.kind === "console" && Boolean(display.command)) ||
        (display.kind === "write-body" && Boolean(display.writePreview))));

  const autoOpen =
    isRunning ||
    isError ||
    nestedActive ||
    (settled === false && tool.status !== "done" && canExpand) ||
    // wiki_produce with nested units: open while nested active, else closed when done
    (hasNested && (isRunning || nestedActive));

  const [open, setOpen] = useState(autoOpen);
  useEffect(() => {
    if (autoOpen) setOpen(true);
    else if (hasNested && !isRunning && !nestedActive && !isError) setOpen(false);
  }, [autoOpen, hasNested, isRunning, nestedActive, isError]);

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
        className={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")}
      />
      <span className="min-w-0 flex-1 truncate leading-5">
        <span
          className={cn(
            "font-medium",
            isRunning && "text-muted-foreground",
            isError && "text-destructive",
          )}
        >
          {isWikiProduce ? "wiki_produce" : display.title}
        </span>
        {display.subtitle ? (
          <span className="ml-1.5 text-muted-foreground">{display.subtitle}</span>
        ) : null}
        {display.args?.map((arg) => (
          <span key={arg} className="ml-1.5 font-mono text-[10px] text-muted-foreground/80">
            {arg}
          </span>
        ))}
      </span>
    </div>
  );

  if (!canExpand) {
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
      open={open}
      onOpenChange={setOpen}
      className="group w-full min-w-0 rounded-md"
      data-testid="tool-execution-card"
      data-tool-name={tool.name}
      data-tool-status={tool.status}
      data-has-nested={hasNested ? "true" : undefined}
    >
      <CollapsibleTrigger className="w-full min-w-0 rounded-md text-left">
        {trigger}
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 overflow-hidden pl-4 pr-1 pb-1.5 sm:pl-6">
        {body.trim() && !isWikiProduce ? (
          <pre
            className={cn(
              "okf-code-snippet max-h-64 overflow-auto text-[11px] leading-relaxed",
              isError && "text-destructive",
            )}
          >
            {body}
          </pre>
        ) : null}
        {body.trim() && isWikiProduce && !hasNested ? (
          <pre className="okf-code-snippet max-h-32 overflow-auto text-[11px] leading-relaxed text-muted-foreground">
            {body}
          </pre>
        ) : null}
        {isRunning && !body.trim() && !hasNested ? (
          <p className="text-[11px] text-muted-foreground">…</p>
        ) : null}
        {hasNested ? (
          <div className="mt-1 min-w-0" data-testid="tool-nested-trail">
            {nested}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
