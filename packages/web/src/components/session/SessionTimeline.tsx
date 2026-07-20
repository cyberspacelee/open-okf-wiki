import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { ToolCallCard } from "./ToolCallCard";
import type { SessionTimelineItem } from "./types";

export function SessionTimeline({ items }: { items: SessionTimelineItem[] }) {
  if (items.length === 0) {
    return (
      <p className="muted" data-testid="session-timeline-empty">
        Run output will appear here (markdown, tools, subagents).
      </p>
    );
  }

  return (
    <div className="session-timeline" data-testid="session-timeline">
      {items.map((item) => {
        if (item.kind === "text") {
          return (
            <div key={item.id} className="session-timeline__item session-timeline__text">
              <MemoizedMarkdown id={item.id} content={item.text} />
            </div>
          );
        }
        if (item.kind === "tool") {
          return (
            <div key={item.id} className="session-timeline__item">
              <ToolCallCard
                toolName={item.toolName}
                toolCallId={item.toolCallId}
                toolState={item.toolState}
                inputSummary={item.inputSummary}
                outputSummary={item.outputSummary}
                nodeId={item.nodeId}
              />
            </div>
          );
        }
        return (
          <div
            key={item.id}
            className="session-timeline__item session-timeline__status muted small mono"
            data-testid="session-status-line"
          >
            {item.message}
          </div>
        );
      })}
    </div>
  );
}
