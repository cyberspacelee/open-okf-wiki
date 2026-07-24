/**
 * Expandable parent-visible produce unit card (framework bridge trail).
 * Empty/running without message/tools → waiting, not "thinking".
 */

import { CheckIcon, ChevronRightIcon, CircleAlertIcon, LayersIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import type { ProduceUnit, ProduceUnitTool } from "../hooks/project/produce";
import { ToolExecutionCard } from "./ToolExecutionCard";

export type ProduceUnitCardProps = {
  unit: ProduceUnit;
  className?: string;
};

function StatusGlyph({ status }: { status: string }) {
  if (status === "running" || status === "pending") {
    return <Spinner className="size-3 shrink-0 text-muted-foreground" />;
  }
  if (status === "failed") {
    return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />;
  }
  if (status === "settled") {
    return <CheckIcon className="size-3.5 shrink-0 text-success" />;
  }
  return null;
}

function toolToAgentCall(tool: ProduceUnitTool) {
  const state = tool.state.toLowerCase();
  let status: "pending" | "running" | "done" | "error" = "pending";
  if (state.includes("error") || state.includes("fail")) status = "error";
  else if (state.includes("result") || state.includes("done") || state.includes("complete")) {
    status = "done";
  } else if (state.includes("run") || state.includes("call") || state.includes("start")) {
    status = "running";
  }
  return {
    id: tool.toolCallId,
    name: tool.toolName,
    input: tool.input !== undefined ? JSON.stringify(tool.input) : undefined,
    output:
      tool.errorText ??
      (tool.output !== undefined
        ? typeof tool.output === "string"
          ? tool.output
          : JSON.stringify(tool.output)
        : undefined),
    status,
  };
}

export function ProduceUnitCard({ unit, className }: ProduceUnitCardProps) {
  const { t } = useI18n();
  const isRunning = unit.status === "running" || unit.status === "pending";
  const isError = unit.status === "failed";
  const settled = unit.status === "settled" || unit.status === "failed";
  const tools = unit.tools ?? [];
  const messageText = unit.message?.text?.trim() || "";
  const messageThinking = unit.message?.thinking?.trim() || "";
  const summary = unit.summary?.trim() || "";
  const error = unit.error?.trim() || "";
  const hasDetail =
    Boolean(messageText) ||
    Boolean(messageThinking) ||
    Boolean(summary) ||
    Boolean(error) ||
    tools.length > 0 ||
    Boolean(unit.receiptPath);

  const openDefault = isRunning || isError;

  const title =
    unit.task?.trim() ||
    t.agentWorkspace.produceUnitRole[unit.role as keyof typeof t.agentWorkspace.produceUnitRole] ||
    String(unit.role);

  const statusLabel =
    t.agentWorkspace.produceUnitStatus[
      unit.status as keyof typeof t.agentWorkspace.produceUnitStatus
    ] ?? String(unit.status).replace(/_/g, " ");

  return (
    <Collapsible
      defaultOpen={openDefault}
      className={cn(
        "group w-full min-w-0 max-w-[min(100%,42rem)] rounded-lg border text-xs",
        isError
          ? "border-destructive/40 bg-destructive/5"
          : isRunning
            ? "border-border/60 bg-muted/15"
            : "border-border/60 bg-muted/20",
        className,
      )}
      data-testid="produce-unit-card"
      data-unit-id={unit.unitId}
      data-unit-role={unit.role}
      data-unit-status={unit.status}
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/40">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
        <StatusGlyph status={String(unit.status)} />
        <LayersIcon
          className={cn(
            "size-3.5 shrink-0",
            isError ? "text-destructive" : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 flex-1 truncate">
          <span className={cn("font-medium", isError && "text-destructive")}>{title}</span>
          <span className="ml-1.5 text-muted-foreground">{statusLabel}</span>
          {unit.role ? (
            <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/80">
              {unit.role}
            </span>
          ) : null}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 border-t border-border/40 px-2.5 py-2">
        {!hasDetail && isRunning ? (
          <div
            className="flex items-center gap-2 text-muted-foreground"
            data-testid="produce-unit-waiting"
          >
            <Spinner className="size-3" />
            <span>{t.agentWorkspace.waitingForEvents}</span>
          </div>
        ) : null}
        {!hasDetail && !isRunning ? <p className="text-muted-foreground">{statusLabel}</p> : null}
        {summary ? <p className="mb-1 whitespace-pre-wrap break-words">{summary}</p> : null}
        {error ? (
          <p className="mb-1 whitespace-pre-wrap break-words text-destructive">{error}</p>
        ) : null}
        {messageText ? (
          <p className="mb-1 whitespace-pre-wrap break-words text-muted-foreground">
            {messageText}
          </p>
        ) : null}
        {messageThinking ? (
          <pre className="okf-code-snippet mb-1 max-h-32 overflow-auto text-[11px] text-muted-foreground">
            {messageThinking}
          </pre>
        ) : null}
        {unit.receiptPath ? (
          <p className="mb-1 font-mono text-[10px] text-muted-foreground">{unit.receiptPath}</p>
        ) : null}
        {tools.length > 0 ? (
          <div className="mt-1 flex min-w-0 flex-col gap-0.5">
            {tools.map((tool) => (
              <ToolExecutionCard
                key={tool.toolCallId}
                tool={toolToAgentCall(tool)}
                settled={settled}
              />
            ))}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
