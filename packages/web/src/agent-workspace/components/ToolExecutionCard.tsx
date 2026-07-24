/**
 * Tool call row — OpenCode BasicTool / pi-web specialized renderer style.
 *
 * Trigger (always visible):
 *   [status] [icon] title  subtitle  arg arg
 *
 * Expand (only when there is a result or write body):
 *   plain result text — NO "Input" / "Output" section labels.
 *   structured details for the real wiki_produce tool.
 *
 * Known tools put args on the trigger line; they are never re-dumped as JSON.
 */

import type {
  AgentResumeGateCommand,
  WikiProduceChildSpan,
  WikiProduceToolDetails,
} from "@okf-wiki/contract";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileIcon,
  LayersIcon,
  SearchIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { formatToolDisplay, formatToolResultText } from "../hooks/project/format";
import type { AgentToolCall } from "../hooks/project/types";

const WIKI_PRODUCE_TOOL_NAME = "wiki_produce";

export type ToolExecutionCardProps = {
  tool: AgentToolCall;
  onResumeGate: (command: AgentResumeGateCommand) => Promise<void>;
  /**
   * When the parent work unit is settled, keep completed tools collapsed.
   * Pass `false` while a unit is still active so non-done tools expand.
   */
  settled?: boolean;
};

function WikiProduceDetailsPanel({
  details,
  onResumeGate,
}: {
  details: WikiProduceToolDetails;
  onResumeGate: (command: AgentResumeGateCommand) => Promise<void>;
}) {
  const { t } = useI18n();
  const gate =
    details.status === "awaiting_plan"
      ? ("plan" as const)
      : details.status === "awaiting_publication"
        ? ("publication" as const)
        : null;
  const pages = details.spec?.pages.map((page) => page.path) ?? details.pages ?? [];
  const [submitting, setSubmitting] = useState(false);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    setSubmitting(false);
    setRevising(false);
    setFeedback("");
  }, [details.runId, details.status]);

  const decide = async (action: "approve" | "deny" | "revise") => {
    if (!gate || !details.runId || submitting) return;
    if (action === "revise" && !feedback.trim()) {
      setRevising(true);
      return;
    }
    setSubmitting(true);
    try {
      await onResumeGate({
        type: "resume_gate",
        gate,
        action,
        runId: details.runId,
        ...(gate === "plan" && details.spec ? { spec: details.spec } : {}),
        ...(action === "revise" ? { feedback: feedback.trim() } : {}),
      });
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2.5"
      data-testid="wiki-produce-details"
      data-wiki-status={details.status}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium">
            {gate === "plan"
              ? t.planConfirm.title
              : gate === "publication"
                ? t.runStatus.awaiting_publication
                : details.status}
          </p>
          {details.summary ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{details.summary}</p>
          ) : null}
        </div>
        {details.runId ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {details.runId}
          </span>
        ) : null}
      </div>

      {details.spec?.summary ? (
        <p className="text-xs leading-relaxed">{details.spec.summary}</p>
      ) : null}
      {pages.length > 0 ? (
        <div>
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t.planConfirm.pagesLabel} · {pages.length}
          </p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {pages.map((page) => (
              <li key={page} className="truncate font-mono text-[10px] text-muted-foreground">
                {page}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {details.children && details.children.length > 0 ? (
        <div className="space-y-1 border-t border-border/60 pt-2" data-testid="wiki-produce-children">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t.agentWorkspace.childAgents} · {details.children.length}
          </p>
          <ul className="space-y-1">
            {details.children.map((child) => (
              <WikiProduceChildRow key={child.id} child={child} />
            ))}
          </ul>
        </div>
      ) : null}

      {gate && details.runId ? (
        <div
          className="space-y-2 border-t border-border/60 pt-2"
          data-testid={`agent-${gate}-gate`}
        >
          {revising && gate === "plan" ? (
            <Textarea
              data-testid="agent-gate-feedback"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder={t.planConfirm.revisePlaceholder}
              disabled={submitting}
              rows={2}
              className="min-h-16 text-xs"
            />
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              data-testid="agent-gate-approve"
              disabled={submitting}
              onClick={() => void decide("approve")}
            >
              {submitting
                ? t.planConfirm.working
                : gate === "plan"
                  ? t.planConfirm.approve
                  : t.planConfirm.chipPublish}
            </Button>
            {gate === "plan" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid={revising ? "agent-gate-revise-submit" : "agent-gate-revise"}
                disabled={submitting}
                onClick={() => {
                  if (!revising) setRevising(true);
                  else void decide("revise");
                }}
              >
                {revising ? t.planConfirm.reviseSubmit : t.planConfirm.revise}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="agent-gate-deny"
              disabled={submitting}
              onClick={() => void decide("deny")}
            >
              {gate === "plan" ? t.planConfirm.decline : t.planConfirm.chipKeepStaging}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WikiProduceChildRow({ child }: { child: WikiProduceChildSpan }) {
  const running = child.status === "running";
  const items = child.items ?? [];
  return (
    <Collapsible
      defaultOpen={running}
      className="rounded border border-border/50 bg-background/40"
      data-testid="wiki-produce-child"
      data-child-id={child.id}
      data-child-role={child.role}
      data-child-status={child.status}
    >
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-muted/40">
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90" />
        {running ? <Spinner className="size-3 shrink-0" /> : null}
        <span className="font-medium">{child.role}</span>
        <span className="truncate text-muted-foreground">{child.summary ?? child.status}</span>
        {child.usage?.contextTokens != null ? (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
            ctx:{child.usage.contextTokens}
          </span>
        ) : null}
      </CollapsibleTrigger>
      {items.length > 0 ? (
        <CollapsibleContent className="border-t border-border/40 px-2 py-1.5">
          <ul className="space-y-1">
            {items.map((item, index) => (
              <li
                key={`${child.id}-${index}`}
                className="font-mono text-[10px] leading-relaxed text-muted-foreground"
              >
                {item.type === "text" ? (
                  <span className="whitespace-pre-wrap break-words">{item.text}</span>
                ) : (
                  <span>
                    <span className="text-foreground/80">{item.name}</span>
                    {item.argsSummary ? (
                      <span className="text-muted-foreground"> {item.argsSummary}</span>
                    ) : null}
                    {item.status ? (
                      <span className="text-muted-foreground"> · {item.status}</span>
                    ) : null}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

function toolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower === WIKI_PRODUCE_TOOL_NAME) {
    return LayersIcon;
  }
  if (lower === "read" || lower === "write" || lower === "edit" || lower === "ls") {
    return FileIcon;
  }
  if (lower === "grep" || lower === "find") {
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
 */
function expandBody(
  kind: ReturnType<typeof formatToolDisplay>["kind"],
  opts: {
    writePreview?: string;
    output: string;
  },
): string {
  const { writePreview, output } = opts;

  if (kind === "write-body") {
    const parts: string[] = [];
    if (writePreview) parts.push(writePreview);
    if (output) parts.push(output);
    return parts.join("\n\n");
  }

  if (kind === "raw" && writePreview && !output) {
    return writePreview;
  }

  return output;
}

export function ToolExecutionCard({ tool, onResumeGate, settled }: ToolExecutionCardProps) {
  const display = formatToolDisplay(tool.name, tool.input);
  const output = formatToolResultText(tool.output) ?? "";
  const isError = tool.status === "error";
  const isRunning = tool.status === "running" || tool.status === "pending";
  const isWikiProduce = tool.name.toLowerCase() === WIKI_PRODUCE_TOOL_NAME;
  const wikiDetails = isWikiProduce ? tool.details : undefined;

  const body = expandBody(display.kind, {
    writePreview: display.writePreview,
    output,
  });

  const canExpand =
    Boolean(wikiDetails) ||
    (!display.headerOnly &&
      (Boolean(body.trim()) ||
        isError ||
        (display.kind === "write-body" && Boolean(display.writePreview))));

  const autoOpen =
    isRunning || isError || (settled === false && tool.status !== "done" && canExpand);

  const [open, setOpen] = useState(autoOpen);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

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
        {body.trim() && isWikiProduce ? (
          <pre className="okf-code-snippet max-h-32 overflow-auto text-[11px] leading-relaxed text-muted-foreground">
            {body}
          </pre>
        ) : null}
        {wikiDetails ? (
          <WikiProduceDetailsPanel details={wikiDetails} onResumeGate={onResumeGate} />
        ) : null}
        {isRunning && !body.trim() ? <p className="text-[11px] text-muted-foreground">…</p> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
