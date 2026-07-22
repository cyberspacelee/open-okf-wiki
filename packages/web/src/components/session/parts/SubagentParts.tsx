/**
 * Subagent / agent-span chrome on the Session timeline.
 */

import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { SubagentCard } from "../SubagentCard";

export function renderSubagentPart(
  key: string,
  part: UIMessage["parts"][number],
): ReactNode {
  if (part.type === "data-agent-span") {
    const data = "data" in part ? part.data : undefined;
    if (data && typeof data === "object") {
      const d = data as {
        agentId?: string;
        role?: string;
        status?: string;
        promptSummary?: string;
        error?: string;
      };
      const agentId = String(d.agentId ?? "agent");
      const status = String(d.status ?? "running");
      // Synthetic tool part so SubagentCard can render role chrome.
      const synthetic = {
        type: "dynamic-tool" as const,
        toolCallId: key,
        toolName: agentId,
        state:
          status === "running"
            ? ("input-available" as const)
            : status === "failed"
              ? ("output-error" as const)
              : ("output-available" as const),
        input: d.promptSummary
          ? { prompt: d.promptSummary }
          : { prompt: agentId },
        output:
          status === "complete"
            ? { summary: "Delegation complete" }
            : status === "failed"
              ? undefined
              : undefined,
        errorText: d.error,
      };
      return (
        <SubagentCard
          key={key}
          part={synthetic as UIMessage["parts"][number]}
          toolName={agentId}
          partKey={key}
        />
      );
    }
    return null;
  }

  if (part.type === "data-tool-agent") {
    const data = "data" in part ? part.data : undefined;
    const toolName =
      data && typeof data === "object" && "name" in data
        ? String((data as { name?: unknown }).name ?? "agent")
        : "agent";
    return (
      <SubagentCard
        key={key}
        part={
          {
            type: "dynamic-tool",
            toolCallId: key,
            toolName,
            state: "output-available",
            input: data,
            output:
              data && typeof data === "object" && "result" in data
                ? (data as { result?: unknown }).result
                : data,
          } as UIMessage["parts"][number]
        }
        toolName={toolName}
        partKey={key}
      />
    );
  }

  return undefined;
}
