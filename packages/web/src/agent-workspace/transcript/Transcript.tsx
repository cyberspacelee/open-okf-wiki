/**
 * Agent Workspace transcript — user / assistant / tool / product cards.
 * shadcn chat primitives: MessageScroller + Message + Bubble (ADR 0030 UI).
 * Projects Pi text, thinking, tools, and provider errors (never silent empty).
 */

import {
  BotIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  SparklesIcon,
  UserIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import {
  Bubble,
  BubbleContent,
  BubbleGroup,
} from "@/components/ui/bubble";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { ToolExecutionCard } from "../components/ToolExecutionCard";
import type {
  AgentMessage,
  AgentProductMeta,
  PendingGate,
  ResumeGateInput,
} from "../hooks/useSessionAgent";
import { AgentMarkdown } from "./AgentMarkdown";
import { GateActions } from "./GateActions";

export type TranscriptProps = {
  messages: AgentMessage[];
  className?: string;
  /** Active HITL gate — actions render on the matching product gate card. */
  pendingGate?: PendingGate | null;
  gateBusy?: boolean;
  onResumeGate?: (input: ResumeGateInput) => void | Promise<void>;
  /** Optional: load full receipts when previewing spans. */
  workspaceId?: string;
  rootPath?: string;
  /**
   * Open Work surface for a produce agent (planner / leaf).
   * Main timeline only shows chips — streams live in the focus drawer.
   */
  onOpenAgent?: (input: {
    agentId: string;
    role?: string;
    task?: string;
    detail?: string;
  }) => void;
};

function ThinkingBlock({
  thinking,
  streaming,
}: {
  thinking: string;
  streaming?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Collapsible
      defaultOpen={streaming}
      className="rounded-md border border-border/70 bg-muted/20"
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
      <CollapsibleContent className="border-t border-border/50 px-2.5 py-2">
        <pre className="okf-code-snippet text-muted-foreground">{thinking}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function productBadgeLabel(product: AgentProductMeta): string {
  switch (product.kind) {
    case "run_phase":
      return product.phase ?? "phase";
    case "gate":
      return product.gate ? `gate:${product.gate}` : "gate";
    case "run_link":
      return "run";
    case "progress":
      return product.phase ?? "progress";
    case "plan_progress":
      return "spec pages";
    case "work_run":
      return product.phase ?? "work";
    case "defects":
      return product.clean ? "review:ok" : "review:defects";
    default: {
      const _exhaustive: never = product.kind;
      return String(_exhaustive);
    }
  }
}

function WorkRunCard({
  product,
  onOpenAgent,
}: {
  product: AgentProductMeta;
  onOpenAgent?: TranscriptProps["onOpenAgent"];
}) {
  const agents = product.agents ?? [];
  const running = agents.filter(
    (a) => a.status === "running" || a.status === "pending",
  ).length;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="work-run-chip">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">
          Work · Wiki Run {(product.runId ?? "—").slice(0, 8)}
        </span>
        {product.phase ? (
          <Badge variant="outline" className="normal-case text-[10px]">
            {product.phase}
          </Badge>
        ) : null}
        {running > 0 ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Spinner className="size-3" />
            {running} running
          </span>
        ) : null}
      </div>
      <ul className="flex min-w-0 flex-col gap-1">
        {agents.map((a) => {
          const isRunning =
            a.status === "running" || a.status === "pending";
          return (
            <li key={a.agentId}>
              <button
                type="button"
                className={cn(
                  "flex w-full min-w-0 items-start gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
                  isRunning
                    ? "border-primary/30 bg-primary/5 hover:bg-primary/10"
                    : "border-border/70 bg-background/60 hover:bg-muted/50",
                )}
                onClick={() =>
                  onOpenAgent?.({
                    agentId: a.agentId,
                    role: a.role,
                    task: a.task,
                    detail: a.detail,
                  })
                }
                data-testid="work-run-agent"
                data-agent-id={a.agentId}
              >
                {isRunning ? (
                  <Spinner className="mt-0.5 size-3 shrink-0 text-primary" />
                ) : (
                  <span className="mt-0.5 size-3 shrink-0 rounded-full bg-muted-foreground/40" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px] normal-case">
                      {a.role}
                    </Badge>
                    <Badge
                      variant={
                        a.status === "failed"
                          ? "destructive"
                          : a.status === "settled" ||
                              a.status === "complete" ||
                              a.status === "done"
                            ? "secondary"
                            : "default"
                      }
                      className="text-[10px] normal-case"
                    >
                      {a.status}
                    </Badge>
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                      {a.agentId}
                    </span>
                  </div>
                  {a.task ? (
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                      {a.task}
                    </p>
                  ) : null}
                </div>
                <EyeIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </li>
          );
        })}
      </ul>
      {agents.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Waiting for units…</p>
      ) : null}
    </div>
  );
}

function productBadgeVariant(
  product: AgentProductMeta,
): "default" | "secondary" | "destructive" | "outline" {
  if (product.kind === "gate") return "default";
  if (product.kind === "run_phase") {
    if (product.phase === "failed") return "destructive";
    if (product.phase === "done" || product.phase === "cancelled") {
      return "secondary";
    }
    return "outline";
  }
  return "secondary";
}

function MessageCard({
  message,
  showGateActions,
  pendingGate,
  gateBusy,
  onResumeGate,
  onOpenAgent,
}: {
  message: AgentMessage;
  showGateActions: boolean;
  pendingGate: PendingGate | null;
  gateBusy: boolean;
  onResumeGate?: (input: ResumeGateInput) => void | Promise<void>;
  onOpenAgent?: TranscriptProps["onOpenAgent"];
}) {
  const { t } = useI18n();
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isTool = message.role === "tool";
  const product = message.product;
  const isError =
    message.status === "error" || Boolean(message.errorMessage);
  const isStreaming = message.status === "streaming";
  const hasBody =
    Boolean(message.content?.trim()) ||
    Boolean(message.thinking?.trim()) ||
    Boolean(message.tools?.length) ||
    isError;

  if (isSystem && !product && message.status === "aborted") {
    return (
      <Marker
        data-testid="agent-message"
        data-role="system"
        data-status="aborted"
        variant="separator"
        role="status"
      >
        <MarkerContent>{message.content}</MarkerContent>
      </Marker>
    );
  }

  if (isSystem || isTool) {
    return (
      <div
        data-testid="agent-message"
        data-role={message.role}
        data-product-kind={product?.kind}
        data-status={message.status}
        className="flex flex-col items-center gap-1.5"
      >
        <div
          className={cn(
            "w-full max-w-[min(100%,42rem)] rounded-lg border px-2.5 py-2 text-xs",
            product
              ? "border-border/70 bg-muted/30"
              : "border-dashed border-border bg-muted/40 text-muted-foreground",
            product?.kind === "gate" && "border-primary/30 bg-primary/5",
            isError && "border-destructive/40 bg-destructive/5 text-destructive",
            product?.kind === "run_phase" &&
              product.phase === "failed" &&
              "border-destructive/40 bg-destructive/5",
            product?.kind === "work_run" && "border-primary/25 bg-primary/5",
          )}
        >
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] font-medium tracking-wide uppercase opacity-70">
            <span>
              {product
                ? product.kind === "gate"
                  ? "Product gate"
                  : product.kind === "run_phase"
                    ? "Run phase"
                    : product.kind === "progress"
                      ? "Progress"
                      : product.kind === "plan_progress"
                        ? "Spec queue"
                        : product.kind === "work_run"
                          ? "Work"
                          : product.kind === "defects"
                            ? "Review"
                            : "Run link"
                : isTool
                  ? t.agentWorkspace.roleTool
                  : t.agentWorkspace.roleSystem}
            </span>
            {product ? (
              <Badge
                variant={productBadgeVariant(product)}
                className="normal-case tracking-normal"
              >
                {productBadgeLabel(product)}
              </Badge>
            ) : null}
            {product?.runId ? (
              <span className="font-mono normal-case tracking-normal opacity-80">
                {product.runId.slice(0, 8)}
              </span>
            ) : null}
            {isError ? (
              <Badge variant="destructive" className="normal-case tracking-normal">
                {t.agentWorkspace.statusError}
              </Badge>
            ) : null}
          </div>
          {product?.kind === "work_run" ? (
            <WorkRunCard product={product} onOpenAgent={onOpenAgent} />
          ) : message.content ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : null}
          {showGateActions && pendingGate && onResumeGate ? (
            <GateActions
              pending={pendingGate}
              busy={gateBusy}
              onResume={onResumeGate}
              compact
              className="mt-2 border-t border-border/50 pt-2"
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <Message
      data-testid="agent-message"
      data-role={message.role}
      data-status={message.status}
      align={isUser ? "end" : "start"}
      className="max-w-full min-w-0"
    >
      <MessageContent className="max-w-[min(100%,42rem)] min-w-0">
        <MessageHeader className="gap-2">
          {isUser ? (
            <>
              <UserIcon className="size-3.5" />
              <span>{t.agentWorkspace.roleUser}</span>
            </>
          ) : (
            <>
              <BotIcon className="size-3.5" />
              <span>{t.agentWorkspace.roleAssistant}</span>
            </>
          )}
          {isStreaming ? (
            <Badge variant="outline" className="normal-case tracking-normal">
              streaming
            </Badge>
          ) : null}
          {isError ? (
            <Badge variant="destructive" className="normal-case tracking-normal">
              <CircleAlertIcon data-icon="inline-start" />
              {t.agentWorkspace.statusError}
            </Badge>
          ) : null}
        </MessageHeader>

        <BubbleGroup className="min-w-0 w-full">
          {message.thinking ? (
            <ThinkingBlock
              thinking={message.thinking}
              streaming={message.thinkingStatus === "streaming"}
            />
          ) : null}

          {hasBody || isStreaming ? (
            <Bubble
              variant={
                isUser ? "default" : isError ? "destructive" : "outline"
              }
              align={isUser ? "end" : "start"}
              className={cn(!isUser && "w-full max-w-full min-w-0")}
            >
              <BubbleContent
                className={cn(
                  !isUser && "w-full max-w-full min-w-0",
                  isError && "w-full",
                )}
              >
                {message.content ? (
                  isUser ? (
                    <div className="whitespace-pre-wrap break-words">
                      {message.content}
                    </div>
                  ) : (
                    <AgentMarkdown
                      content={message.content}
                      streaming={isStreaming}
                    />
                  )
                ) : isStreaming ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Spinner className="size-3.5" />
                    <span className="text-xs">
                      {t.agentWorkspace.statusBusy}
                    </span>
                  </div>
                ) : isError ? (
                  <div className="whitespace-pre-wrap">
                    {message.errorMessage ?? t.agentWorkspace.statusError}
                  </div>
                ) : null}

                {message.tools && message.tools.length > 0 ? (
                  <div className="mt-2 flex min-w-0 w-full flex-col gap-1.5">
                    {message.tools.map((tool) => (
                      <ToolExecutionCard key={tool.id} tool={tool} />
                    ))}
                  </div>
                ) : null}
              </BubbleContent>
            </Bubble>
          ) : null}
        </BubbleGroup>
      </MessageContent>
    </Message>
  );
}

export function Transcript({
  messages,
  className,
  pendingGate = null,
  gateBusy = false,
  onResumeGate,
  onOpenAgent,
}: TranscriptProps) {
  const { t } = useI18n();

  // Main timeline: parent Pi + product cards only (work units live in drawer).
  const timeline = messages;

  // Only the latest matching gate card shows actions (avoid stale buttons).
  let activeGateMessageId: string | null = null;
  if (pendingGate) {
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const m = timeline[i]!;
      if (
        m.product?.kind === "gate" &&
        m.product.gate === pendingGate.gate
      ) {
        activeGateMessageId = m.id;
        break;
      }
    }
  }

  if (timeline.length === 0) {
    return (
      <div
        data-testid="agent-transcript-empty"
        className={cn(
          "flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4",
          className,
        )}
      >
        <Empty className="border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>{t.agentWorkspace.emptyTitle}</EmptyTitle>
            <EmptyDescription>
              {t.agentWorkspace.emptyDescription}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller
        data-testid="agent-transcript"
        className={cn("min-h-0 flex-1", className)}
      >
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-3 px-3 py-3 md:px-4">
            {timeline.map((m) => (
              <MessageScrollerItem
                key={m.id}
                messageId={m.id}
                scrollAnchor={m.role === "user"}
              >
                <MessageCard
                  message={m}
                  showGateActions={m.id === activeGateMessageId}
                  pendingGate={pendingGate}
                  gateBusy={gateBusy}
                  onResumeGate={onResumeGate}
                  onOpenAgent={onOpenAgent}
                />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton aria-label={t.agentWorkspace.jumpToLatest} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
