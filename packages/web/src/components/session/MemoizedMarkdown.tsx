import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Split markdown into stable blocks so streaming re-renders only touch new tails.
 * Inspired by AI SDK memoized markdown cookbook.
 */
function parseMarkdownIntoBlocks(markdown: string): string[] {
  // Prefer blank-line paragraph splits for streaming stability without pulling `marked`.
  const parts = markdown.split(/\n{2,}/);
  return parts.length > 0 ? parts : [markdown];
}

const MemoizedMarkdownBlock = memo(
  function MemoizedMarkdownBlock({ content }: { content: string }) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    );
  },
  (prev, next) => prev.content === next.content,
);

export const MemoizedMarkdown = memo(function MemoizedMarkdown({
  id,
  content,
}: {
  id: string;
  content: string;
}) {
  const blocks = useMemo(() => parseMarkdownIntoBlocks(content), [content]);
  return (
    <div className="session-markdown" data-testid="session-markdown">
      {blocks.map((block, i) => (
        <MemoizedMarkdownBlock key={`${id}-b${i}`} content={block} />
      ))}
    </div>
  );
});
