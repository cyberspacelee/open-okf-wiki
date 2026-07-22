/**
 * Agent Workspace transcript — user / assistant / tool / product cards.
 * shadcn chat primitives: MessageScroller + Message + Bubble (ADR 0030 UI).
 * Projects Pi text, thinking, tools, and provider errors (never silent empty).
 */

import type { ReactNode } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  SparklesIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
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
import { useI18n } from "../../../i18n";
import type {
  AgentMessage,
  AgentProductMeta,
  AgentToolCall,
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
};

function ToolCard({ tool }: { tool: AgentToolCall }) {
  const { t } = useI18n();
  return (
    <Collapsible
      defaultOpen={tool.status === "running" || tool.status === "error"}
      className="rounded-md border border-border/80 bg-muted/30"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/60">
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
      <CollapsibleContent className="border-t border-border/60 px-2.5 py-2">
        {tool.input ? (
          <div className="mb-2">
            <div className="mb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {t.agentWorkspace.toolInput}
            </div>
            <pre className="overflow-x-auto rounded bg-background/80 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {tool.input}
            </pre>
          </div>
        ) : null}
        {tool.output ? (
          <div>
            <div className="mb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {t.agentWorkspace.toolOutput}
            </div>
            <pre className="overflow-x-auto rounded bg-background/80 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {tool.output}
            </pre>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

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
        <div className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {thinking}
        </div>
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
    case "agent_span":
      return product.role ?? "agent";
    case "defects":
      return product.clean ? "review:ok" : "review:defects";
    default: {
      const _exhaustive: never = product.kind;
      return String(_exhaustive);
    }
  }
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
}: {
  message: AgentMessage;
  showGateActions: boolean;
  pendingGate: PendingGate | null;
  gateBusy: boolean;
  onResumeGate?: (input: ResumeGateInput) => void | Promise<void>;
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
            product?.kind === "gate" &&
              "border-primary/30 bg-primary/5",
            isError && "border-destructive/40 bg-destructive/5 text-destructive",
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
                      : product.kind === "agent_span"
                        ? "Agent"
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
          {message.content ? (
            <div className="whitespace-pre-wrap">{message.content}</div>
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
      className="max-w-full"
    >
      <MessageContent className="max-w-[min(100%,42rem)]">
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

        <BubbleGroupInner>
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
              className={cn(!isUser && "w-full max-w-full")}
            >
              <BubbleContent
                className={cn(
                  !isUser && "w-full max-w-full",
                  isError && "w-full",
                )}
              >
                {message.content ? (
                  isUser ? (
                    <div className="whitespace-pre-wrap">{message.content}</div>
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
                  <div className="mt-2 flex flex-col gap-1.5">
                    {message.tools.map((tool) => (
                      <ToolCard key={tool.id} tool={tool} />
                    ))}
                  </div>
                ) : null}
              </BubbleContent>
            </Bubble>
          ) : null}
        </BubbleGroupInner>
      </MessageContent>
    </Message>
  );
}

/** Local stack for thinking + body bubbles. */
function BubbleGroupInner({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-2">{children}</div>;
}

export function Transcript({
  messages,
  className,
  pendingGate = null,
  gateBusy = false,
  onResumeGate,
}: TranscriptProps) {
  const { t } = useI18n();

  // Only the latest matching gate card shows actions (avoid stale buttons).
  let activeGateMessageId: string | null = null;
  if (pendingGate) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (
        m.product?.kind === "gate" &&
        m.product.gate === pendingGate.gate
      ) {
        activeGateMessageId = m.id;
        break;
      }
    }
  }

  if (messages.length === 0) {
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
            {messages.map((m) => (
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
