/**
 * Unified Session timeline card shell.
 * AI Elements Tool/Plan remain available; product timeline cards go through here
 * so Tool / Workflow / Phase / Batch / Subagent share one chrome.
 */

import type { ComponentProps, ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  sessionCardAdvancedSummary,
  sessionCardBadge,
  sessionCardBody,
  sessionCardHeader,
  sessionCardIcon,
  sessionCardMono,
  sessionCardShell,
  sessionCardShellFailed,
  sessionCardTitle,
} from "./session-card-styles";

export type SessionCardStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "idle"
  | "custom";

const STATUS_BADGE: Partial<
  Record<
    SessionCardStatus,
    { label: string; variant: "secondary" | "destructive" | "outline" }
  >
> = {
  pending: { label: "Pending", variant: "secondary" },
  running: { label: "Running", variant: "secondary" },
  completed: { label: "Completed", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  denied: { label: "Denied", variant: "outline" },
  idle: { label: "Idle", variant: "secondary" },
};

export type SessionCardProps = {
  title: string;
  icon?: ReactNode;
  status?: SessionCardStatus;
  /** Override badge label (e.g. i18n phase name). */
  statusLabel?: string;
  /** Extra badge(s) after status (e.g. Subagent). */
  badges?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  failed?: boolean;
  children?: ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  "data-testid"?: string;
  /** Extra data-* attributes for e2e */
  dataAttrs?: Record<string, string | undefined>;
};

export function SessionCard({
  title,
  icon,
  status,
  statusLabel,
  badges,
  defaultOpen = false,
  open,
  onOpenChange,
  failed,
  children,
  className,
  headerClassName,
  bodyClassName,
  "data-testid": testId,
  dataAttrs,
}: SessionCardProps) {
  const isFailed = failed || status === "failed";
  const badgeSpec = status ? STATUS_BADGE[status] : undefined;
  const label = statusLabel ?? badgeSpec?.label;
  const variant = isFailed
    ? "destructive"
    : (badgeSpec?.variant ?? "secondary");

  const collapsibleProps =
    open !== undefined
      ? { open, onOpenChange }
      : { defaultOpen };

  return (
    <Collapsible
      {...collapsibleProps}
      className={cn(
        sessionCardShell,
        isFailed && sessionCardShellFailed,
        className,
      )}
      data-testid={testId}
      {...Object.fromEntries(
        Object.entries(dataAttrs ?? {})
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => [
            k.startsWith("data-") ? k : `data-${k}`,
            v as string,
          ]),
      )}
    >
      <CollapsibleTrigger
        className={cn(sessionCardHeader, headerClassName)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {icon ? (
            <span className={cn(sessionCardIcon, isFailed && "text-destructive")}>
              {icon}
            </span>
          ) : null}
          <span className={sessionCardTitle}>{title}</span>
          {label ? (
            <Badge variant={variant} className={sessionCardBadge}>
              {label}
            </Badge>
          ) : null}
          {badges}
        </div>
        {children ? (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        ) : null}
      </CollapsibleTrigger>
      {children ? (
        <CollapsibleContent className={cn(sessionCardBody, bodyClassName)}>
          {children}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

/** Advanced raw dump — always nested, never default wall. */
export function SessionCardAdvanced({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="min-w-0" open={defaultOpen || undefined}>
      <summary className={sessionCardAdvancedSummary}>{label}</summary>
      <div className="mt-1.5 min-w-0">{children}</div>
    </details>
  );
}

export function SessionCardMono({
  children,
  className,
  ...props
}: ComponentProps<"pre">) {
  return (
    <pre className={cn(sessionCardMono, className)} {...props}>
      {children}
    </pre>
  );
}

export { sessionCardCode } from "./session-card-styles";
