/**
 * Work surface focus: product work_unit body (planner / leaf / …).
 * Main chat only shows chips; this drawer hosts thinking / tools / text.
 *
 * Empty running units show waitingForEvents — never "Thinking".
 */

import {
  ChevronRightIcon,
  Loader2Icon,
  SparklesIcon,
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
import { ToolExecutionCard } from "../components/ToolExecutionCard";
import type { WorkUnitView } from "../hooks/useSessionAgent";
import {
  formatPayloadText,
  workUnitHasBody,
  workUnitToolsToAgentTools,
} from "../hooks/project-agent-events";
import { AgentMarkdown } from "../transcript/AgentMarkdown";

export type AgentFocusDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focused unit id (planner, leaf-*, …). */
  unitId: string | null;
  role?: string;
  task?: string;
  unit: WorkUnitView | null;
  /** Fallback body when no unit fold yet (receipt summary). */
  fallbackDetail?: string;
  className?: string;
};

export function AgentUnitBody({
  unit,
  fallbackDetail,
}: {
  unit: WorkUnitView | null;
  fallbackDetail?: string;
}) {
  const { t } = useI18n();
  const running = unit?.status === "running" || unit?.status === "pending";
  const settled = unit?.status === "settled" || unit?.status === "failed";
  const thinking = unit?.message?.thinking?.trim();
  const text = unit?.message?.text?.trim();
  const summary = unit?.summary?.trim();
  const tools = workUnitToolsToAgentTools(unit?.tools);
  const fallback = fallbackDetail?.trim();
  const hasBody = workUnitHasBody(unit);

  if (!unit && !fallback) {
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
          defaultOpen={!settled || running}
          className="w-full min-w-0 rounded-md border border-border/70 bg-muted/20"
        >
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50">
            <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
            <SparklesIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 font-medium">
              {running && !settled
                ? t.agentWorkspace.thinkingStreaming
                : t.agentWorkspace.thinking}
            </span>
            {running && !settled ? <Spinner className="size-3" /> : null}
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
            <ToolExecutionCard
              key={tool.id}
              tool={tool}
              settled={settled}
            />
          ))}
        </div>
      ) : null}

      {text ? (
        <div className="min-w-0 text-sm leading-relaxed">
          <AgentMarkdown content={text} streaming={running && !settled} />
        </div>
      ) : null}

      {settled && summary && !text ? (
        <div className="min-w-0 text-sm leading-relaxed">
          <AgentMarkdown content={summary} />
        </div>
      ) : null}

      {!hasBody && fallback ? (
        <pre className="okf-code-snippet">{formatPayloadText(fallback)}</pre>
      ) : null}

      {/* Empty running unit: waiting, never "Thinking". */}
      {running && !hasBody && !fallback ? (
        <div
          className="flex items-center gap-2 text-xs text-muted-foreground"
          data-testid="waiting-for-events"
        >
          <Loader2Icon className="size-3.5 animate-spin" />
          {t.agentWorkspace.waitingForEvents}
        </div>
      ) : null}

      {unit?.status === "failed" && unit.error ? (
        <p className="text-xs text-destructive whitespace-pre-wrap break-words">
          {unit.error}
        </p>
      ) : null}
    </div>
  );
}

export function AgentFocusDrawer({
  open,
  onOpenChange,
  unitId,
  role,
  task,
  unit,
  fallbackDetail,
  className,
}: AgentFocusDrawerProps) {
  const { t } = useI18n();
  const title = [role ?? unit?.role, unitId ?? unit?.unitId]
    .filter(Boolean)
    .join(" · ");
  const status =
    unit?.status ?? (fallbackDetail ? "settled" : "running");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          "flex w-full min-w-0 flex-col overflow-hidden sm:max-w-lg",
          className,
        )}
        data-testid="work-unit-drawer"
      >
        <SheetHeader className="min-w-0">
          <SheetTitle className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-sm">
            <span className="min-w-0 break-all">
              {title || t.agentWorkspace.roleAssistant}
            </span>
            <Badge
              variant={
                status === "failed"
                  ? "destructive"
                  : status === "running" || status === "pending"
                    ? "default"
                    : "secondary"
              }
              className="normal-case"
            >
              {status}
            </Badge>
          </SheetTitle>
          <SheetDescription className="min-w-0 break-words">
            {task || unit?.task || t.agentWorkspace.subagentPreviewHint}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 min-w-0 flex-1 px-4 pb-4">
          <div className="min-w-0 max-w-full pr-2">
            <AgentUnitBody unit={unit} fallbackDetail={fallbackDetail} />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
