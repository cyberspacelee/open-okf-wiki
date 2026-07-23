/**
 * Shared work-unit body: thinking / tools / text / waiting.
 * Single body host for timeline expand (ADR 0031 UI cut).
 */

import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "../../i18n";
import type { WorkUnitView } from "../hooks/useSessionAgent";
import {
  formatPayloadText,
  workUnitHasBody,
  workUnitToolsToAgentTools,
} from "../hooks/project-agent-events";
import { AgentMarkdown } from "../transcript/AgentMarkdown";
import { ToolExecutionCard } from "./ToolExecutionCard";

export type WorkUnitBodyProps = {
  unit: WorkUnitView | null;
  fallbackDetail?: string;
};

export function WorkUnitBody({ unit, fallbackDetail }: WorkUnitBodyProps) {
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
    <div className="flex min-w-0 flex-col gap-2">
      {thinking ? (
        <Collapsible
          defaultOpen={!settled || running}
          className="w-full min-w-0 rounded-md border border-border/60 bg-muted/15"
        >
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40">
            <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
            <span className="min-w-0 flex-1 font-medium">
              {running && !settled
                ? t.agentWorkspace.thinkingStreaming
                : t.agentWorkspace.thinking}
            </span>
            {running && !settled ? <Spinner className="size-3" /> : null}
          </CollapsibleTrigger>
          <CollapsibleContent className="min-w-0 border-t border-border/40 px-2 py-2">
            <pre className="okf-code-snippet text-muted-foreground">
              {thinking}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {tools.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
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
