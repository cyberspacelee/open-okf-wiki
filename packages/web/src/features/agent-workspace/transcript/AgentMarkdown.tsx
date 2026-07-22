/**
 * Markdown body for agent transcript cards.
 * Reuses Streamdown (same stack as Wiki browse) with session-density styles.
 */

import { memo } from "react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

const streamdownPlugins = { cjk, code, math, mermaid };

export type AgentMarkdownProps = {
  content: string;
  /** When true, use streaming mode so incomplete fences still paint. */
  streaming?: boolean;
  className?: string;
};

export const AgentMarkdown = memo(function AgentMarkdown({
  content,
  streaming = false,
  className,
}: AgentMarkdownProps) {
  if (!content) return null;

  return (
    <div
      data-testid="agent-markdown"
      className={cn(
        "session-markdown agent-markdown min-w-0 break-words",
        className,
      )}
    >
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        plugins={streamdownPlugins}
        className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      >
        {content}
      </Streamdown>
    </div>
  );
});
