/**
 * Single visual system for Session timeline cards.
 * Tool / CodeMode / Workflow / Phase / Batch / Subagent all use these tokens
 * via <SessionCard /> — do not invent parallel text-[11px] densities.
 */

/** Outer card shell */
export const sessionCardShell =
  "group not-prose mb-2 w-full min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-card";

export const sessionCardShellFailed =
  "border-destructive/40 bg-destructive/5";

/** Header row */
export const sessionCardHeader =
  "flex w-full min-w-0 items-center justify-between gap-3 p-3 text-left hover:bg-muted/40";

/** Title in header */
export const sessionCardTitle =
  "min-w-0 flex-1 truncate font-medium text-sm text-foreground";

/** Leading icon */
export const sessionCardIcon = "size-4 shrink-0 text-muted-foreground";

/** Expanded body */
export const sessionCardBody =
  "min-w-0 max-w-full space-y-2 overflow-hidden border-t px-3 py-3 text-xs text-muted-foreground";

/** Meta / helper line */
export const sessionCardMeta = "text-xs text-muted-foreground";

/** Mono dump */
export const sessionCardMono =
  "m-0 max-h-28 max-w-full min-w-0 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground";

/** Status badge */
export const sessionCardBadge = "shrink-0 gap-1 rounded-full text-xs";

/** Nested advanced summary */
export const sessionCardAdvancedSummary =
  "cursor-pointer text-xs text-muted-foreground hover:text-foreground";

/** Code block density inside card bodies */
export const sessionCardCode =
  "text-xs [&_pre]:p-3 [&_pre]:text-xs [&_code]:text-xs";
