/**
 * Shared tool call chrome for transcript + Work surface focus drawer.
 * Expand/collapse + JSON pretty-print via formatPayloadText.
 */

import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useI18n } from "../../i18n";
import {
  formatPayloadText,
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

export function ToolExecutionCard({ tool, settled }: ToolExecutionCardProps) {
  const { t } = useI18n();
  const input = formatPayloadText(tool.input);
  const output = formatPayloadText(tool.output);
  const openDefault =
    tool.status === "running" ||
    tool.status === "error" ||
    (settled === false && tool.status !== "done");

  return (
    <Collapsible
      defaultOpen={openDefault}
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
