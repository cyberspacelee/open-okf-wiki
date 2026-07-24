/**
 * Agent Workspace transcript — chat track + thin product strips.
 *
 * Produce trail nests under the parent wiki_produce tool card (Claude/OpenCode
 * subagent style). Flat end-of-timeline dump only as cold-load fallback.
 */

import { BotIcon, ChevronRightIcon, CircleAlertIcon, FilterIcon, UserIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
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
import { ProduceTrail } from "../components/ProduceTrail";
import { ToolExecutionCard } from "../components/ToolExecutionCard";
import type { ProduceUnit } from "../hooks/project/produce";
import {
  formatProductCardContent,
  produceUnitsActive,
  WIKI_PRODUCE_TOOL_NAME,
} from "../hooks/project-agent-events";
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
  pendingGate?: PendingGate | null;
  gateBusy?: boolean;
  onResumeGate?: (input: ResumeGateInput) => void | Promise<void>;
  phase?: string | null;
  onStartWikiRun?: () => void;
  emptyActions?: boolean;
  /** Parent-visible produce units (last-by-unitId). */
  produceUnits?: ProduceUnit[];
  /** AgentTree focus target — open + scroll produce card. */
  focusedUnitId?: string | null;
  /** When true (or auto with produce), prefer run-focused timeline. */
  runFocusDefault?: boolean;
};

function ThinkingBlock({ thinking, streaming }: { thinking: string; streaming?: boolean }) {
  const { t } = useI18n();
  return (
    <Collapsible
      defaultOpen={streaming}
      className="w-full min-w-0 rounded-md border border-border/60 bg-muted/15"
    >
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/40">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90" />
        <span className="min-w-0 flex-1 font-medium">
          {streaming ? t.agentWorkspace.thinkingStreaming : t.agentWorkspace.thinking}
        </span>
        {streaming ? <Spinner className="size-3" /> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 border-t border-border/40 px-2.5 py-2">
        <pre className="okf-code-snippet text-muted-foreground">{thinking}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function productKindLabel(product: AgentProductMeta, t: ReturnType<typeof useI18n>["t"]): string {
  switch (product.kind) {
    case "gate":
      return t.agentWorkspace.cardGate;
    case "run_phase":
      return t.agentWorkspace.cardPhase;
    case "plan_progress":
      return t.agentWorkspace.cardPages;
    case "defects":
      return t.agentWorkspace.cardReview;
    case "run_link":
      return t.agentWorkspace.cardRun;
    default:
      return t.agentWorkspace.cardRun;
  }
}

function isWikiProduceTool(tool: AgentToolCall): boolean {
  return tool.name === WIKI_PRODUCE_TOOL_NAME || tool.name.toLowerCase() === "wiki_produce";
}

function messageHasWikiProduce(m: AgentMessage): boolean {
  if (m.tools?.some(isWikiProduceTool)) return true;
  if (!m.parts?.length || !m.tools?.length) return false;
  const byId = new Map(m.tools.map((t) => [t.id, t]));
  return m.parts.some((p) => p.type === "tool" && byId.has(p.toolId) && isWikiProduceTool(byId.get(p.toolId)!));
}

/** Run-focus: product strips, user turns, and messages that carry tools (esp. wiki_produce). */
function filterRunFocus(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((m) => {
    if (m.product) return true;
    if (m.role === "user") return true;
    if (m.role === "system") return true;
    if (m.status === "error") return true;
    if (m.tools && m.tools.length > 0) return true;
    if (m.parts?.some((p) => p.type === "tool")) return true;
    return false;
  });
}

function messagesHaveWikiProduce(messages: AgentMessage[]): boolean {
  return messages.some(messageHasWikiProduce);
}

/** Only the latest wiki_produce tool hosts the live produce trail (no duplicates). */
function lastWikiProduceToolId(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const tools = messages[i]!.tools ?? [];
    for (let j = tools.length - 1; j >= 0; j -= 1) {
      if (isWikiProduceTool(tools[j]!)) return tools[j]!.id;
    }
  }
  return null;
}

function ProductStrip({
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
  const product = message.product;
  if (!product) return null;

  const isError =
    message.status === "error" || (product.kind === "run_phase" && product.phase === "failed");
  const isGate = product.kind === "gate";

  return (
    <div
      data-testid="agent-message"
      data-role="system"
      data-product-kind={product.kind}
      data-status={message.status}
      className="flex min-w-0 w-full flex-col items-center gap-1.5"
    >
      <div
        className={cn(
          "w-full min-w-0 max-w-[min(100%,42rem)] rounded-lg border px-2.5 py-2 text-xs",
          isGate
            ? "border-primary/35 bg-primary/5"
            : isError
              ? "border-destructive/40 bg-destructive/5"
              : "border-border/60 bg-muted/20",
        )}
      >
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/80">{productKindLabel(product, t)}</span>
          {product.kind === "run_phase" && product.phase ? (
            <span>
              {t.agentWorkspace.phases[product.phase as keyof typeof t.agentWorkspace.phases] ??
                product.phase.replace(/_/g, " ")}
            </span>
          ) : null}
          {isGate && product.gate ? (
            <span>
              {product.gate === "plan" ? t.agentWorkspace.gatePlan : t.agentWorkspace.gatePublish}
            </span>
          ) : null}
        </div>
        {(() => {
          const body = formatProductCardContent(product, t.agentWorkspace, message.content);
          return body ? <div className="whitespace-pre-wrap break-words">{body}</div> : null;
        })()}
        {showGateActions && pendingGate && onResumeGate ? (
          <GateActions
            pending={pendingGate}
            busy={gateBusy}
            onResume={onResumeGate}
            compact
            className="mt-2 border-t border-border/40 pt-2"
          />
        ) : null}
      </div>
    </div>
  );
}

function ChatMessage({
  message,
  produceUnits,
  focusedUnitId,
  hostProduceToolId,
}: {
  message: AgentMessage;
  produceUnits: ProduceUnit[];
  focusedUnitId: string | null;
  /** Only this tool id hosts the nested produce trail. */
  hostProduceToolId: string | null;
}) {
  const { t } = useI18n();
  const isUser = message.role === "user";
  const isError = message.status === "error" || Boolean(message.errorMessage);
  const isStreaming = message.status === "streaming";
  const toolsById = new Map((message.tools ?? []).map((tool) => [tool.id, tool]));
  const parts = message.parts;
  const useParts = Boolean(parts?.length) && !isUser;
  const produceActive = produceUnitsActive(produceUnits);
  const hasBody =
    Boolean(message.content?.trim()) ||
    Boolean(message.thinking?.trim()) ||
    Boolean(message.tools?.length) ||
    Boolean(parts?.length) ||
    isError;

  const renderTool = (tool: AgentToolCall) => {
    const isHost = hostProduceToolId !== null && tool.id === hostProduceToolId;
    return (
      <ToolExecutionCard
        key={tool.id}
        tool={tool}
        nested={
          isHost && produceUnits.length > 0 ? (
            <ProduceTrail units={produceUnits} focusedUnitId={focusedUnitId} />
          ) : undefined
        }
        nestedActive={isHost && produceActive}
      />
    );
  };

  if (message.role === "system" && message.status === "aborted") {
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

  if (message.role === "system" || message.role === "tool") {
    return (
      <div
        data-testid="agent-message"
        data-role={message.role}
        className="flex w-full justify-center"
      >
        <p className="max-w-[min(100%,42rem)] text-center text-xs text-muted-foreground">
          {message.content}
        </p>
      </div>
    );
  }

  const orderedBody = useParts ? (
    <div className="flex min-w-0 w-full flex-col gap-2" data-testid="message-parts">
      {parts!.map((part, i) => {
        if (part.type === "thinking") {
          return (
            <ThinkingBlock
              key={`thinking-${i}`}
              thinking={part.thinking}
              streaming={
                isStreaming && message.thinkingStatus === "streaming" && i === parts!.length - 1
              }
            />
          );
        }
        if (part.type === "text") {
          if (!part.text.trim()) return null;
          return (
            <AgentMarkdown
              key={`text-${i}`}
              content={part.text}
              streaming={isStreaming && i === parts!.length - 1}
            />
          );
        }
        const tool = toolsById.get(part.toolId);
        if (!tool) return null;
        return renderTool(tool);
      })}
      {isStreaming &&
      !message.content?.trim() &&
      !message.thinking?.trim() &&
      !message.tools?.length ? (
        <div
          className="flex items-center gap-2 text-muted-foreground"
          data-testid="waiting-for-events"
        >
          <Spinner className="size-3.5" />
          <span className="text-xs">{t.agentWorkspace.waitingForEvents}</span>
        </div>
      ) : null}
      {isError && !message.content?.trim() ? (
        <div className="whitespace-pre-wrap">{message.errorMessage ?? t.agentWorkspace.statusError}</div>
      ) : null}
    </div>
  ) : null;

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
          {isStreaming ? <Spinner className="size-3 text-muted-foreground" /> : null}
          {isError ? (
            <span className="inline-flex items-center gap-1 text-destructive">
              <CircleAlertIcon className="size-3" />
              {t.agentWorkspace.statusError}
            </span>
          ) : null}
        </MessageHeader>

        <BubbleGroup className="min-w-0 w-full">
          {!useParts && message.thinking ? (
            <ThinkingBlock
              thinking={message.thinking}
              streaming={message.thinkingStatus === "streaming"}
            />
          ) : null}

          {hasBody || isStreaming ? (
            <Bubble
              variant={isUser ? "default" : isError ? "destructive" : "outline"}
              align={isUser ? "end" : "start"}
              className={cn(!isUser && "w-full max-w-full min-w-0")}
            >
              <BubbleContent
                className={cn(!isUser && "w-full max-w-full min-w-0", isError && "w-full")}
              >
                {useParts ? (
                  orderedBody
                ) : message.content ? (
                  isUser ? (
                    <div className="whitespace-pre-wrap break-words">{message.content}</div>
                  ) : (
                    <AgentMarkdown content={message.content} streaming={isStreaming} />
                  )
                ) : isStreaming ? (
                  <div
                    className="flex items-center gap-2 text-muted-foreground"
                    data-testid="waiting-for-events"
                  >
                    <Spinner className="size-3.5" />
                    <span className="text-xs">{t.agentWorkspace.waitingForEvents}</span>
                  </div>
                ) : isError ? (
                  <div className="whitespace-pre-wrap">
                    {message.errorMessage ?? t.agentWorkspace.statusError}
                  </div>
                ) : null}

                {!useParts && message.tools && message.tools.length > 0 ? (
                  <div className="mt-2 flex min-w-0 w-full flex-col gap-1">
                    {message.tools.map((tool) => renderTool(tool))}
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
  onStartWikiRun,
  emptyActions = true,
  produceUnits = [],
  focusedUnitId = null,
  runFocusDefault,
}: TranscriptProps) {
  const { t } = useI18n();
  const hasProduce = produceUnits.length > 0;
  const nestProduce = messagesHaveWikiProduce(messages);
  const hostProduceToolId = lastWikiProduceToolId(messages);
  const [runFocus, setRunFocus] = useState(
    () => runFocusDefault ?? (hasProduce || nestProduce),
  );

  // Auto-enable run focus when produce starts (first time).
  const showRunFocusToggle = hasProduce || nestProduce || messages.some((m) => m.product);

  const visibleMessages = useMemo(
    () => (runFocus ? filterRunFocus(messages) : messages),
    [messages, runFocus],
  );

  let activeGateMessageId: string | null = null;
  if (pendingGate) {
    for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
      const m = visibleMessages[i]!;
      if (m.product?.kind === "gate" && m.product.gate === pendingGate.gate) {
        activeGateMessageId = m.id;
        break;
      }
    }
  }

  // Fallback trail only when units exist but no wiki_produce tool on the timeline.
  const showFallbackTrail = hasProduce && !nestProduce;

  if (messages.length === 0 && produceUnits.length === 0) {
    return (
      <div
        data-testid="agent-transcript-empty"
        className={cn(
          "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4",
          className,
        )}
      >
        <Empty className="border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>{t.agentWorkspace.emptyTitle}</EmptyTitle>
            <EmptyDescription>{t.agentWorkspace.emptyDescription}</EmptyDescription>
          </EmptyHeader>
        </Empty>
        {emptyActions && onStartWikiRun ? (
          <Button
            type="button"
            size="sm"
            data-testid="agent-empty-start-wiki"
            onClick={() => onStartWikiRun()}
          >
            {t.agentWorkspace.startWikiRun}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {showRunFocusToggle ? (
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border/50 px-3 py-1">
          <Button
            type="button"
            size="xs"
            variant={runFocus ? "secondary" : "ghost"}
            data-testid="transcript-run-focus"
            data-active={runFocus ? "true" : "false"}
            onClick={() => setRunFocus((v) => !v)}
            className="text-[11px]"
          >
            <FilterIcon data-icon="inline-start" className="size-3" />
            {runFocus ? t.agentWorkspace.modeWikiRun : t.agentWorkspace.modeChat}
          </Button>
        </div>
      ) : null}
      <MessageScrollerProvider autoScroll>
        <MessageScroller data-testid="agent-transcript" className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-3 px-3 py-3 md:px-4">
              {visibleMessages.map((m) => (
                <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.role === "user"}>
                  {m.product ? (
                    <ProductStrip
                      message={m}
                      showGateActions={m.id === activeGateMessageId}
                      pendingGate={pendingGate}
                      gateBusy={gateBusy}
                      onResumeGate={onResumeGate}
                    />
                  ) : (
                    <ChatMessage
                      message={m}
                      produceUnits={produceUnits}
                      focusedUnitId={focusedUnitId}
                      hostProduceToolId={hostProduceToolId}
                    />
                  )}
                </MessageScrollerItem>
              ))}
              {showFallbackTrail ? (
                <MessageScrollerItem messageId="produce-units-fallback" scrollAnchor={false}>
                  <div
                    className="flex w-full min-w-0 flex-col items-center gap-2"
                    data-testid="produce-units"
                  >
                    <p className="w-full max-w-[min(100%,42rem)] text-[11px] font-medium text-muted-foreground">
                      {t.agentWorkspace.produceUnitsTitle}
                    </p>
                    <ProduceTrail
                      units={produceUnits}
                      focusedUnitId={focusedUnitId}
                      className="max-w-[min(100%,42rem)]"
                    />
                  </div>
                </MessageScrollerItem>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton aria-label={t.agentWorkspace.jumpToLatest} />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
