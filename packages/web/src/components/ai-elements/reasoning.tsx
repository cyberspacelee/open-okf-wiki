"use client";

/**
 * AI Elements–style collapsible reasoning block (ADR 0026).
 * Default collapsed; open while streaming.
 */

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
};

export function Reasoning({
  className,
  isStreaming = false,
  open: openProp,
  defaultOpen,
  onOpenChange,
  children,
  ...props
}: ReasoningProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(
    defaultOpen ?? isStreaming,
  );
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : uncontrolledOpen;

  useEffect(() => {
    if (controlled) {
      return;
    }
    if (isStreaming) {
      setUncontrolledOpen(true);
    }
  }, [isStreaming, controlled]);

  return (
    <Collapsible
      open={open}
      onOpenChange={(next, eventDetails) => {
        if (!controlled) {
          setUncontrolledOpen(next);
        }
        onOpenChange?.(next, eventDetails);
      }}
      className={cn(
        "group not-prose mb-2 w-full rounded-md border border-dashed bg-muted/30",
        className,
      )}
      data-testid="session-reasoning"
      {...props}
    >
      {children}
    </Collapsible>
  );
}

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title?: string;
};

export function ReasoningTrigger({
  className,
  title = "Thinking",
  children,
  ...props
}: ReasoningTriggerProps) {
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <BrainIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{title}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </>
      )}
    </CollapsibleTrigger>
  );
}

export type ReasoningContentProps = {
  className?: string;
  children: ReactNode;
};

export function ReasoningContent({ className, children }: ReasoningContentProps) {
  return (
    <CollapsibleContent
      className={cn(
        "border-t border-dashed px-3 py-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap",
        className,
      )}
      data-testid="session-reasoning-content"
    >
      {children}
    </CollapsibleContent>
  );
}
