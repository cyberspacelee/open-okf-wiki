/**
 * Agent Workspace transcript — user / assistant / tool / product cards.
 * No AI SDK / ai-elements; plain shadcn Card + Collapsible.
 */

import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
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

function productBadgeLabel(product: AgentProductMeta): string {
  switch (product.kind) {
    case "run_phase":
      return product.phase ?? "phase";
    case "gate":
      return product.gate ? `gate:${product.gate}` : "gate";
    case "run_link":
      return "run";
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

  return (
    <div
      data-testid="agent-message"
      data-role={message.role}
      data-product-kind={product?.kind}
      className={cn(
        "flex flex-col gap-1.5",
        isUser && "items-end",
        isSystem && "items-center",
      )}
    >
      <div
        className={cn(
          "max-w-[min(100%,42rem)] rounded-lg px-3 py-2 text-sm leading-relaxed",
          isUser && "bg-primary text-primary-foreground",
          message.role === "assistant" &&
            "w-full border border-border/80 bg-card",
          isSystem &&
            !product &&
            "border border-dashed border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
          isSystem &&
            product &&
            "w-full max-w-[min(100%,42rem)] border border-border/70 bg-muted/30 px-2.5 py-2 text-xs",
          isSystem &&
            product?.kind === "gate" &&
            "border-amber-500/40 bg-amber-500/5",
          isTool && "w-full border border-border/80 bg-muted/20",
        )}
      >
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] font-medium tracking-wide uppercase opacity-70">
          <span>
            {product
              ? product.kind === "gate"
                ? "Product gate"
                : product.kind === "run_phase"
                  ? "Run phase"
                  : "Run link"
              : isUser
                ? t.agentWorkspace.roleUser
                : isSystem
                  ? t.agentWorkspace.roleSystem
                  : isTool
                    ? t.agentWorkspace.roleTool
                    : t.agentWorkspace.roleAssistant}
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
          {message.status &&
          message.status !== "done" &&
          !product ? (
            <Badge variant="outline" className="normal-case tracking-normal">
              {message.status}
            </Badge>
          ) : null}
        </div>
        {message.content ? (
          message.role === "assistant" ? (
            <AgentMarkdown
              content={message.content}
              streaming={message.status === "streaming"}
            />
          ) : (
            <div className="whitespace-pre-wrap">{message.content}</div>
          )
        ) : null}
        {message.tools && message.tools.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1.5">
            {message.tools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
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
          "flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center",
          className,
        )}
      >
        <p className="text-sm font-medium">{t.agentWorkspace.emptyTitle}</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {t.agentWorkspace.emptyDescription}
        </p>
      </div>
    );
  }

  return (
    <ScrollArea
      data-testid="agent-transcript"
      className={cn("min-h-0 flex-1", className)}
    >
      <div className="flex flex-col gap-3 px-3 py-3 md:px-4">
        {messages.map((m) => (
          <MessageCard
            key={m.id}
            message={m}
            showGateActions={m.id === activeGateMessageId}
            pendingGate={pendingGate}
            gateBusy={gateBusy}
            onResumeGate={onResumeGate}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
