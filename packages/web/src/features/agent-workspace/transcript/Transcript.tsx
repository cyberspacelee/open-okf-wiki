/**
 * Agent Workspace transcript — user / assistant / tool / product cards.
 * shadcn chat primitives: MessageScroller + Message + Bubble (ADR 0030 UI).
 * Projects Pi text, thinking, tools, and provider errors (never silent empty).
 */

import { useState } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
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
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { useI18n } from "../../../i18n";
import { getRunReceipt } from "../../../api";
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
  /** Optional: load full receipts when previewing spans. */
  workspaceId?: string;
  rootPath?: string;
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
    case "plan_progress":
      return "spec pages";
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

/** Click-to-preview subagent card (Claude Code / pi-subagent-ui style peek). */
function AgentSpanCard({
  product,
  content,
  workspaceId,
  rootPath,
}: {
  product: AgentProductMeta;
  content: string;
  workspaceId?: string;
  rootPath?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState(
    product.detail?.trim() ||
      product.task?.trim() ||
      product.label?.trim() ||
      content,
  );
  const title = [
    product.role ?? "agent",
    product.agentId,
    product.status,
  ]
    .filter(Boolean)
    .join(" · ");

  async function openPreview() {
    setOpen(true);
    setBody(
      product.detail?.trim() ||
        product.task?.trim() ||
        product.label?.trim() ||
        content,
    );
    const runId = product.runId;
    const nodeId =
      product.agentId ||
      (product.receiptPath
        ? product.receiptPath.replace(/^.*\//, "").replace(/\.json$/i, "")
        : undefined);
    if (!workspaceId || !runId || !nodeId) return;
    setLoading(true);
    try {
      const res = await getRunReceipt(workspaceId, runId, nodeId, rootPath);
      const r = res.receipt;
      setBody(
        [
          `nodeId: ${r.nodeId}`,
          `status: ${r.status}`,
          `scope: ${r.scope}`,
          r.parentId ? `parentId: ${r.parentId}` : null,
          "",
          "## Summary",
          r.summary || "(empty)",
          "",
          r.findings?.length
            ? `## Findings\n${r.findings.map((f) => `- ${f}`).join("\n")}`
            : null,
          r.openQuestions?.length
            ? `## Open questions\n${r.openQuestions.map((q) => `- ${q}`).join("\n")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch {
      // Keep SSE detail.
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="whitespace-pre-wrap">{content}</div>
        {product.parentId ? (
          <div className="text-[10px] text-muted-foreground">
            parent: <span className="font-mono">{product.parentId}</span>
          </div>
        ) : null}
        {product.receiptPath ? (
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {product.receiptPath}
          </div>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 self-start px-2 text-xs"
          onClick={() => void openPreview()}
          data-testid="agent-span-preview"
        >
          <EyeIcon data-icon="inline-start" />
          {t.agentWorkspace.viewSubagent}
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col sm:max-w-lg"
          data-testid="agent-span-sheet"
        >
          <SheetHeader>
            <SheetTitle className="font-mono text-sm">{title}</SheetTitle>
            <SheetDescription>
              {product.task ||
                product.label ||
                t.agentWorkspace.subagentPreviewHint}
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
            {loading ? (
              <div className="text-xs text-muted-foreground">
                {t.agentWorkspace.agentTreeLoading}
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {body || t.agentWorkspace.subagentNoDetail}
              </pre>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
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
  workspaceId,
  rootPath,
}: {
  message: AgentMessage;
  showGateActions: boolean;
  pendingGate: PendingGate | null;
  gateBusy: boolean;
  onResumeGate?: (input: ResumeGateInput) => void | Promise<void>;
  workspaceId?: string;
  rootPath?: string;
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
          {product?.kind === "agent_span" ? (
            <AgentSpanCard
              product={product}
              content={message.content ?? ""}
              workspaceId={workspaceId}
              rootPath={rootPath}
            />
          ) : message.content ? (
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

        <BubbleGroup>
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
  workspaceId,
  rootPath,
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
                  workspaceId={workspaceId}
                  rootPath={rootPath}
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
