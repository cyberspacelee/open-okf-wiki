import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { wikiToolRejected } from "../wiki-reject.js";

const JSON_SCHEMA_PREFER = { type: "json_schema", strict: "prefer" } as const;

const emptyParameters = Type.Object({}, { additionalProperties: false });

export const WIKI_DELEGATE_CANCEL_REASON_CODES = ["superseded", "blocked", "user_requested"] as const;
export type WikiDelegateCancelReasonCode = typeof WIKI_DELEGATE_CANCEL_REASON_CODES[number];

function createEmptyParamsWikiTool(
  name: string,
  label: string,
  description: string,
  promptSnippet: string,
  promptGuidelines: string[],
  run: () => unknown | Promise<unknown>,
): ToolDefinition<any, any, any> {
  return {
    name,
    label,
    description,
    promptSnippet,
    promptGuidelines,
    parameters: emptyParameters,
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      return await run();
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiPlanTool(save: () => Promise<unknown>): ToolDefinition<any, any, any> {
  return createEmptyParamsWikiTool(
    "wiki_plan",
    "Submit Wiki plan",
    "Accept the WikiSpec from the Run's fixed plan file.",
    "Accept the prepared WikiSpec",
    ["Prepare the plan file before calling wiki_plan."],
    async () => {
      try {
        return toolResult(await save());
      } catch (error) {
        rejectWikiTool("wiki_plan", error);
      }
    },
  );
}

export function createWikiTaxonomyTool(save: () => Promise<unknown>): ToolDefinition<any, any, any> {
  return createEmptyParamsWikiTool(
    "wiki_taxonomy",
    "Accept Wiki taxonomy",
    "Accept the taxonomy from the Run's fixed taxonomy file.",
    "Accept the prepared taxonomy",
    ["Prepare the taxonomy file after discovery."],
    async () => {
      try { return toolResult(await save()); }
      catch (error) { rejectWikiTool("wiki_taxonomy", error); }
    },
  );
}

export function createWikiDelegateStartTool(start: () => Promise<unknown>): ToolDefinition<any, any, any> {
  return createEmptyParamsWikiTool(
    "wiki_delegate_start",
    "Start Wiki tasks",
    "Start the unique next wave derived from durable Run state.",
    "Start the next ready Wiki wave",
    ["Prepare the discovery file before the first wave."],
    async () => {
      const result = await start();
      return toolResult(result);
    },
  );
}

export function createWikiDelegateCollectTool(
  collect: (options: { until: "any" | "all"; timeoutSeconds?: number }) => Promise<unknown>,
): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_collect",
    label: "Collect Wiki tasks",
    description: "Collect completed receipts from an asynchronous Wiki task batch, optionally waiting for any or all pending tasks.",
    promptSnippet: "Collect receipts from a started Wiki task batch",
    promptGuidelines: [
      "Use timeoutSeconds 0 for a non-blocking status check.",
      "Omit timeoutSeconds to wait until until is satisfied.",
    ],
    parameters: Type.Object({
      until: StringEnum(["any", "all"]),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try {
        const input = params as { until: "any" | "all"; timeoutSeconds?: number };
        return toolResult(await collect({ until: input.until, timeoutSeconds: input.timeoutSeconds }));
      } catch (error) {
        rejectWikiTool("wiki_delegate_collect", error);
      }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiDelegateCancelTool(
  cancel: (reasonCode?: WikiDelegateCancelReasonCode) => Promise<unknown>,
): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_cancel",
    label: "Cancel Wiki tasks",
    description: "Cancel the current Wiki wave.",
    promptSnippet: "Cancel the current Wiki wave",
    parameters: Type.Object({
      reasonCode: Type.Optional(StringEnum([...WIKI_DELEGATE_CANCEL_REASON_CODES])),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try {
        const input = params as { reasonCode?: WikiDelegateCancelReasonCode };
        return toolResult(await cancel(input.reasonCode));
      } catch (error) {
        rejectWikiTool("wiki_delegate_cancel", error);
      }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiFinishTool(finish: () => unknown | Promise<unknown>): ToolDefinition<any, any, any> {
  return createEmptyParamsWikiTool(
    "wiki_finish",
    "Finish Wiki workflow",
    "Finish after the candidate Wiki is complete and sufficiently grounded.",
    "Finish after the candidate Wiki is complete and reviewed",
    ["Call wiki_finish only after current passing reviews."],
    async () => {
      try {
        return toolResult(await finish());
      } catch (error) {
        rejectWikiTool("wiki_finish", error);
      }
    },
  );
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

function rejectWikiTool(tool: string, error: unknown): never {
  if (error instanceof Error && error.message.startsWith(`${tool} rejected:`)) throw error;
  throw wikiToolRejected(tool, error instanceof Error ? error.message : String(error));
}
