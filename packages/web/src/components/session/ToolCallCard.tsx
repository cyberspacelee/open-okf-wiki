import type { ToolPartState } from "./types";

export type ToolCallCardProps = {
  toolName: string;
  toolCallId?: string;
  toolState?: ToolPartState;
  inputSummary?: string;
  outputSummary?: string;
  nodeId?: string;
};

function stateLabel(state?: ToolPartState): string {
  switch (state) {
    case "input-streaming":
      return "input…";
    case "input-available":
      return "running";
    case "output-available":
      return "done";
    case "output-error":
      return "error";
    default:
      return "tool";
  }
}

export function ToolCallCard({
  toolName,
  toolCallId,
  toolState,
  inputSummary,
  outputSummary,
  nodeId,
}: ToolCallCardProps) {
  const isSubagent =
    toolName.includes("delegate") ||
    toolName.includes("domain") ||
    toolName.includes("leaf") ||
    toolName.includes("reviewer") ||
    nodeId === "domain" ||
    nodeId === "leaf" ||
    nodeId === "reviewer";

  return (
    <div
      className={`session-tool-card${isSubagent ? " session-tool-card--subagent" : ""}`}
      data-testid={isSubagent ? "session-subagent-card" : "session-tool-card"}
      data-tool-name={toolName}
      data-tool-state={toolState ?? ""}
      data-node-id={nodeId ?? "root"}
    >
      <div className="session-tool-card__header">
        <span className="session-tool-card__name mono">{toolName}</span>
        <span className="session-tool-card__state muted small">{stateLabel(toolState)}</span>
        {nodeId && nodeId !== "root" ? (
          <span className="session-tool-card__node muted small">{nodeId}</span>
        ) : null}
      </div>
      {inputSummary ? (
        <div className="session-tool-card__row mono small">
          <span className="muted">in</span> {inputSummary}
        </div>
      ) : null}
      {outputSummary ? (
        <div className="session-tool-card__row mono small">
          <span className="muted">out</span> {outputSummary}
        </div>
      ) : null}
      {toolCallId ? (
        <div className="session-tool-card__id muted mono small">{toolCallId}</div>
      ) : null}
    </div>
  );
}
