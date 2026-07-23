/**
 * Markdown body for agent transcript cards.
 * Streamdown + @streamdown/code (Shiki). Code chrome is styled via
 * data-streamdown selectors in index.css (single outer border).
 */

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { memo } from "react";
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
      className={cn("session-markdown agent-markdown min-w-0 break-words", className)}
    >
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        plugins={streamdownPlugins}
        /* Chat density: no line numbers; copy only (download is noisy in timeline). */
        lineNumbers={false}
        controls={{
          code: { copy: true, download: false },
          table: true,
          mermaid: true,
        }}
        className="size-full space-y-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      >
        {content}
      </Streamdown>
    </div>
  );
});
