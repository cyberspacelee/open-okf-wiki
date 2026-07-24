/**
 * Read-only operator tool: answer meta questions (context budget, sources)
 * without starting a Wiki Run.
 */

import { Type } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { resolveContextBudget } from "./context-budget.js";

export const SESSION_STATUS_TOOL_NAME = "session_status" as const;

export type CreateSessionStatusToolInput = {
  workspace: WorkspaceConfig;
  model?: Model<any>;
  maxContextTokens?: number;
  contextTargetTokens?: number;
};

const sessionStatusParameters = Type.Object({}, { additionalProperties: false });

/**
 * Lightweight status tool for the Operator Session.
 * Never freezes sources or starts wiki_produce.
 */
export function createSessionStatusTool(
  input: CreateSessionStatusToolInput,
): ToolDefinition<typeof sessionStatusParameters, Record<string, unknown>> {
  return defineTool({
    name: SESSION_STATUS_TOOL_NAME,
    label: "Session status",
    description: [
      "Report operator session and workspace status: model id, context window,",
      "operational context budget, source count, planConfirm, and wiki language.",
      "Use for questions about context size, tokens, configuration, or readiness.",
      "Do NOT use this tool to produce or refresh the Wiki.",
    ].join(" "),
    promptSnippet: "Read-only session/workspace status (context, sources, config)",
    promptGuidelines: [
      "Prefer session_status for context/token/config questions.",
      "Never call wiki_produce when the operator only asks for status or context size.",
    ],
    parameters: sessionStatusParameters,
    async execute(_toolCallId, _args) {
      const budget = resolveContextBudget({
        maxContextTokens: input.maxContextTokens ?? input.model?.contextWindow,
        contextTargetTokens:
          input.contextTargetTokens ?? input.workspace.limits?.contextTargetTokens,
      });
      const payload = {
        workspaceId: input.workspace.id,
        workspaceName: input.workspace.name,
        modelId: input.model?.id ?? input.workspace.model.id,
        modelProvider: input.model?.provider,
        contextWindow: budget.contextWindow,
        contextTargetTokens: budget.contextTarget,
        sourceCount: input.workspace.sources.length,
        sourceIds: input.workspace.sources.map((s) => s.id),
        planConfirm: input.workspace.planConfirm === true,
        wikiLanguage: input.workspace.wikiLanguage ?? "en",
        skillPath: input.workspace.skillPath ?? null,
      };
      const text = [
        `Workspace: ${payload.workspaceName} (${payload.workspaceId})`,
        `Model: ${payload.modelId}${payload.modelProvider ? ` @ ${payload.modelProvider}` : ""}`,
        `Context window: ${payload.contextWindow} tokens`,
        `Context target (compaction): ${payload.contextTargetTokens} tokens`,
        `Sources: ${payload.sourceCount} (${payload.sourceIds.join(", ") || "none"})`,
        `Plan confirm: ${payload.planConfirm}`,
        `Wiki language: ${payload.wikiLanguage}`,
      ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: payload,
      };
    },
  });
}
