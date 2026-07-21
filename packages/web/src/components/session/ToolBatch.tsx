/**
 * Collapsed group of consecutive same-name research tools — SessionCard shell.
 */

import type { UIMessage } from "ai";
import { LayersIcon } from "lucide-react";
import { renderSessionToolPart } from "./tool-render";
import { toolNameFromPart } from "./session-tool-utils";
import { toolSummaryTitle } from "./tool-summary";
import { useI18n } from "../../i18n";
import { SessionCard } from "./SessionCard";
import { sessionCardMeta } from "./session-card-styles";

export type ToolBatchProps = {
  messageId: string;
  toolName: string;
  parts: UIMessage["parts"][number][];
  startIndex: number;
  onApproval?: (approved: boolean, approvalId: string) => void;
};

export function ToolBatch({
  messageId,
  toolName,
  parts,
  startIndex,
  onApproval,
}: ToolBatchProps) {
  const { t } = useI18n();
  const n = String(parts.length);
  const tools = t.session.tools;
  const batchTitle = (() => {
    switch (toolName) {
      case "list_source":
        return tools.batchListedDirs.replace("{n}", n);
      case "read_source":
        return tools.batchReadSources.replace("{n}", n);
      case "list_skill":
        return tools.batchListedSkill.replace("{n}", n);
      case "read_skill":
        return tools.batchReadSkill.replace("{n}", n);
      case "list_wiki":
        return tools.batchListedWiki.replace("{n}", n);
      case "read_wiki":
        return tools.batchReadWiki.replace("{n}", n);
      default:
        return tools.batchGeneric
          .replace("{name}", toolName)
          .replace("{n}", n);
    }
  })();
  const previews = parts.slice(0, 4).map((part) => {
    const name = toolNameFromPart(part) ?? toolName;
    const input = "input" in part ? part.input : undefined;
    const output = "output" in part ? part.output : undefined;
    const state =
      "state" in part && typeof part.state === "string"
        ? part.state
        : "output-available";
    return toolSummaryTitle(name, input, output, state);
  });

  return (
    <SessionCard
      title={batchTitle}
      icon={<LayersIcon className="size-4" />}
      status="completed"
      defaultOpen={false}
      data-testid="session-tool-batch"
      dataAttrs={{ "tool-name": toolName, count: String(parts.length) }}
    >
      <p className={`truncate ${sessionCardMeta}`}>
        {previews.join(" · ")}
        {parts.length > 4 ? " …" : ""}
      </p>
      <div className="min-w-0 space-y-2">
        {parts.map((part, offset) => {
          const name = toolNameFromPart(part) ?? toolName;
          return renderSessionToolPart({
            key: `${messageId}-batch-${startIndex + offset}`,
            part,
            toolName: name,
            onApproval,
          });
        })}
      </div>
    </SessionCard>
  );
}
