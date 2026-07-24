/** Transcript projected exclusively from Pi messages and tool lifecycle events. */

import type { AgentResumeGateCommand } from "@okf-wiki/contract";
import { BotIcon, ChevronRightIcon, CircleAlertIcon, UserIcon } from "lucide-react";
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
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
import { ToolExecutionCard } from "../components/ToolExecutionCard";
import type { AgentMessage, AgentToolCall } from "../hooks/useSessionAgent";
import { AgentMarkdown } from "./AgentMarkdown";

export type TranscriptProps = {
  messages: AgentMessage[];
  onResumeGate: (command: AgentResumeGateCommand) => Promise<void>;
  className?: string;
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

function ChatMessage({
  message,
  onResumeGate,
}: {
  message: AgentMessage;
  onResumeGate: (command: AgentResumeGateCommand) => Promise<void>;
}) {
  const { t } = useI18n();
  const isUser = message.role === "user";
  const isError = message.status === "error" || Boolean(message.errorMessage);
  const isStreaming = message.status === "streaming";
  const toolsById = new Map((message.tools ?? []).map((tool) => [tool.id, tool]));
  const useParts = !isUser && Boolean(message.parts?.length);

  const renderTool = (tool: AgentToolCall) => (
    <ToolExecutionCard key={tool.id} tool={tool} onResumeGate={onResumeGate} />
  );

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

  const waiting =
    isStreaming && !message.content.trim() && !message.thinking?.trim() && !message.tools?.length;

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
          {isUser ? <UserIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
          <span>{isUser ? t.agentWorkspace.roleUser : t.agentWorkspace.roleAssistant}</span>
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
          <Bubble
            variant={isUser ? "default" : isError ? "destructive" : "outline"}
            align={isUser ? "end" : "start"}
            className={cn(!isUser && "w-full max-w-full min-w-0")}
          >
            <BubbleContent className={cn(!isUser && "w-full max-w-full min-w-0")}>
              {useParts ? (
                <div className="flex min-w-0 w-full flex-col gap-2" data-testid="message-parts">
                  {message.parts!.map((part, index) => {
                    if (part.type === "thinking") {
                      return (
                        <ThinkingBlock
                          key={`thinking-${index}`}
                          thinking={part.thinking}
                          streaming={
                            isStreaming &&
                            message.thinkingStatus === "streaming" &&
                            index === message.parts!.length - 1
                          }
                        />
                      );
                    }
                    if (part.type === "text") {
                      return part.text.trim() ? (
                        <AgentMarkdown
                          key={`text-${index}`}
                          content={part.text}
                          streaming={isStreaming && index === message.parts!.length - 1}
                        />
                      ) : null;
                    }
                    const tool = toolsById.get(part.toolId);
                    return tool ? renderTool(tool) : null;
                  })}
                </div>
              ) : message.content ? (
                isUser ? (
                  <div className="whitespace-pre-wrap break-words">{message.content}</div>
                ) : (
                  <AgentMarkdown content={message.content} streaming={isStreaming} />
                )
              ) : waiting ? (
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

              {!useParts && message.tools?.length ? (
                <div className="mt-2 flex min-w-0 w-full flex-col gap-1">
                  {message.tools.map(renderTool)}
                </div>
              ) : null}
            </BubbleContent>
          </Bubble>
        </BubbleGroup>
      </MessageContent>
    </Message>
  );
}

export function Transcript({ messages, onResumeGate, className }: TranscriptProps) {
  const { t } = useI18n();

  if (messages.length === 0) {
    return (
      <div
        data-testid="agent-transcript-empty"
        className={cn("flex min-h-0 flex-1 items-center justify-center px-4", className)}
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
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <MessageScrollerProvider autoScroll>
        <MessageScroller data-testid="agent-transcript" className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-3 px-3 py-3 md:px-4">
              {messages.map((message) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === "user"}
                >
                  <ChatMessage message={message} onResumeGate={onResumeGate} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton aria-label={t.agentWorkspace.jumpToLatest} />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
