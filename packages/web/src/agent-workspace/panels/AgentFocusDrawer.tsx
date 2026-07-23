/**
 * Work surface focus: live produce-child stream (planner / leaf / …).
 * Main chat only shows chips; this drawer hosts thinking / tools / text.
 */

import {
  ChevronRightIcon,
  Loader2Icon,
  SparklesIcon,
  WrenchIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import type { AgentStream, AgentToolCall } from "../hooks/useSessionAgent";
import {
  formatPayloadText,
} from "../hooks/project-agent-events";
import { AgentMarkdown } from "../transcript/AgentMarkdown";

export type AgentFocusDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focused agent id (planner, leaf-*, …). */
  agentId: string | null;
  role?: string;
  task?: string;
  stream: AgentStream | null;
  /** Fallback body when no live stream yet (receipt / span detail). */
  fallbackDetail?: string;
  className?: string;
};

function ToolBlock({ tool }: { tool: AgentToolCall }) {
  const { t } = useI18n();
  const input = formatPayloadText(tool.input);
  const output = formatPayloadText(tool.output);
  return (
    <Collapsible
      defaultOpen={tool.status === "running" || tool.status === "error"}
      className="w-full min-w-0 rounded-md border border-border/80 bg-muted/30"
    >
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/60">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
        <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono font-medium">
          {tool.name}
        </span>
        <Badge
          variant={
            tool.status === "error"
              ? "destructive"
              : tool.status === "done"
                ? "secondary"
                : "outline"
          }
          className="shrink-0"
        >
          {tool.status}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 border-t border-border/60 px-2.5 py-2">
        {input ? (
          <div className="mb-2 flex min-w-0 flex-col gap-0.5">
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t.agentWorkspace.toolInput}
            </div>
            <pre className="okf-code-snippet">{input}</pre>
          </div>
        ) : null}
        {output ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t.agentWorkspace.toolOutput}
            </div>
            <pre className="okf-code-snippet">{output}</pre>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AgentStreamBody({
  stream,
  fallbackDetail,
}: {
  stream: AgentStream | null;
  fallbackDetail?: string;
}) {
  const { t } = useI18n();
  const streaming = stream?.status === "streaming";
  const thinking = stream?.thinking?.trim();
  const content = stream?.content?.trim();
  const tools = stream?.tools ?? [];
  const fallback = fallbackDetail?.trim();

  if (!stream && !fallback) {
    return (
      <p className="text-xs text-muted-foreground">
        {t.agentWorkspace.subagentNoDetail}
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {thinking ? (
        <Collapsible
          defaultOpen={streaming}
          className="w-full min-w-0 rounded-md border border-border/70 bg-muted/20"
        >
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50">
            <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
            <SparklesIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 font-medium">
              {streaming
                ? t.agentWorkspace.thinkingStreaming
                : t.agentWorkspace.thinking}
            </span>
            {streaming ? <Spinner className="size-3" /> : null}
          </CollapsibleTrigger>
          <CollapsibleContent className="min-w-0 border-t border-border/50 px-2.5 py-2">
            <pre className="okf-code-snippet text-muted-foreground">
              {thinking}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {tools.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          {tools.map((tool) => (
            <ToolBlock key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}

      {content ? (
        <div className="min-w-0 text-sm leading-relaxed">
          <AgentMarkdown content={content} streaming={streaming} />
        </div>
      ) : null}

      {!content && !thinking && tools.length === 0 && fallback ? (
        <pre className="okf-code-snippet">{formatPayloadText(fallback)}</pre>
      ) : null}

      {streaming && !content && !thinking && tools.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          {t.agentWorkspace.thinkingStreaming}
        </div>
      ) : null}

      {stream?.errorMessage ? (
        <p className="text-xs text-destructive whitespace-pre-wrap break-words">
          {stream.errorMessage}
        </p>
      ) : null}
    </div>
  );
}

export function AgentFocusDrawer({
  open,
  onOpenChange,
  agentId,
  role,
  task,
  stream,
  fallbackDetail,
  className,
}: AgentFocusDrawerProps) {
  const { t } = useI18n();
  const title = [role ?? stream?.role, agentId ?? stream?.agentId]
    .filter(Boolean)
    .join(" · ");
  const status = stream?.status ?? (fallbackDetail ? "done" : "streaming");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn("flex w-full flex-col sm:max-w-lg", className)}
        data-testid="agent-focus-drawer"
      >
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2 font-mono text-sm">
            <span className="min-w-0 break-all">{title || t.agentWorkspace.roleAssistant}</span>
            <Badge
              variant={
                status === "error"
                  ? "destructive"
                  : status === "streaming"
                    ? "default"
                    : "secondary"
              }
              className="normal-case"
            >
              {status}
            </Badge>
          </SheetTitle>
          <SheetDescription>
            {task || t.agentWorkspace.subagentPreviewHint}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
          <div className="min-w-0 pr-2">
            <AgentStreamBody stream={stream} fallbackDetail={fallbackDetail} />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
