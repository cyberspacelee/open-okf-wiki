"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";
// Keep AI Elements Tool chrome aligned with SessionCard tokens when used outside Session.
import {
  sessionCardBody,
  sessionCardShell,
} from "@/components/session/session-card-styles";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(sessionCardShell, className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full min-w-0 items-center justify-between gap-4 p-3",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-sm">
          {title ?? derivedName}
        </span>
        <span className="shrink-0">{getStatusBadge(state)}</span>
      </div>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      sessionCardBody,
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

/** Cap JSON dumps so tool cards stay scannable and do not inflate layout. */
const MAX_JSON_CHARS = 2_400;

function formatJsonForTool(value: unknown): string {
  try {
    const s = JSON.stringify(value, null, 2);
    if (s.length <= MAX_JSON_CHARS) {
      return s;
    }
    return `${s.slice(0, MAX_JSON_CHARS)}\n… [truncated ${s.length - MAX_JSON_CHARS} chars]`;
  } catch {
    return String(value);
  }
}

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div
    className={cn("min-w-0 max-w-full space-y-1.5 overflow-hidden", className)}
    {...props}
  >
    <h4 className="font-medium text-xs text-muted-foreground">Parameters</h4>
    <div className="min-w-0 max-w-full overflow-x-auto rounded-md bg-muted/50 text-xs">
      <CodeBlock
        code={formatJsonForTool(input)}
        language="json"
        className="text-xs [&_pre]:p-3 [&_pre]:text-xs [&_code]:text-xs"
      />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output: ReactNode = null;

  const codeClass = "text-xs [&_pre]:p-3 [&_pre]:text-xs [&_code]:text-xs";
  if (typeof output === "object" && output !== null && !isValidElement(output)) {
    Output = (
      <CodeBlock
        code={formatJsonForTool(output)}
        language="json"
        className={codeClass}
      />
    );
  } else if (typeof output === "string") {
    const text =
      output.length > MAX_JSON_CHARS
        ? `${output.slice(0, MAX_JSON_CHARS)}\n… [truncated]`
        : output;
    Output = (
      <CodeBlock
        code={text}
        language={"plaintext" as never}
        className={codeClass}
      />
    );
  } else if (output !== undefined && output !== null) {
    Output = (
      <pre className="m-0 max-w-full overflow-x-auto whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed">
        {String(output)}
      </pre>
    );
  }

  return (
    <div
      className={cn("min-w-0 max-w-full space-y-1.5 overflow-hidden", className)}
      {...props}
    >
      <h4 className="font-medium text-xs text-muted-foreground">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "min-w-0 max-w-full overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText ? (
          <div className="whitespace-pre-wrap break-words p-3 text-xs">
            {errorText}
          </div>
        ) : null}
        {Output}
      </div>
    </div>
  );
};
