/**
 * Project Mastra fullStream chunks into operator-safe Session stream parts.
 * Keeps secrets and large file bodies out of the UI channel.
 */

import type { ToolPartState } from "@okf-wiki/contract";

export type WikiStreamPart = {
  type: "text" | "tool" | "tool_result" | "part" | "log";
  partType?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolState?: ToolPartState;
  inputSummary?: string;
  outputSummary?: string;
  nodeId?: string;
  message?: string;
};

const MAX_TEXT = 4000;
const MAX_SUMMARY = 400;

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

/** Redact obvious secrets and collapse whitespace for UI summaries. */
export function sanitizeSummary(raw: unknown, max = MAX_SUMMARY): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else {
    try {
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
  }
  text = text
    .replace(/\bsk-[a-zA-Z0-9-]{10,}\b/g, "[redacted-key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "api_key=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  // Prefer paths over full file bodies in tool args.
  if (text.length > max * 2 && /"content"\s*:/.test(text)) {
    text = text.replace(/"content"\s*:\s*"(?:\\.|[^"\\]){20,}"/g, '"content":"[omitted]"');
  }
  return truncate(text, max);
}

function pickToolName(chunk: Record<string, unknown>): string | undefined {
  const payload = chunk.payload as Record<string, unknown> | undefined;
  const name =
    (typeof chunk.toolName === "string" && chunk.toolName) ||
    (typeof payload?.toolName === "string" && payload.toolName) ||
    (typeof payload?.name === "string" && payload.name) ||
    undefined;
  return name ? String(name).slice(0, 128) : undefined;
}

function pickToolCallId(chunk: Record<string, unknown>): string | undefined {
  const payload = chunk.payload as Record<string, unknown> | undefined;
  const id =
    (typeof chunk.toolCallId === "string" && chunk.toolCallId) ||
    (typeof payload?.toolCallId === "string" && payload.toolCallId) ||
    (typeof payload?.id === "string" && payload.id) ||
    undefined;
  return id ? String(id).slice(0, 128) : undefined;
}

/**
 * Map one Mastra stream chunk to zero or more operator-safe parts.
 * Unknown / reasoning chunks are dropped (no CoT in UI by default).
 */
export function projectMastraChunk(chunk: unknown): WikiStreamPart[] {
  if (!chunk || typeof chunk !== "object") {
    return [];
  }
  const c = chunk as Record<string, unknown>;
  const type = typeof c.type === "string" ? c.type : "";
  const payload =
    c.payload && typeof c.payload === "object"
      ? (c.payload as Record<string, unknown>)
      : {};

  switch (type) {
    case "text-delta": {
      const text =
        (typeof payload.text === "string" && payload.text) ||
        (typeof c.text === "string" && c.text) ||
        "";
      if (!text) {
        return [];
      }
      return [
        {
          type: "text",
          partType: "text",
          text: truncate(text, MAX_TEXT),
          nodeId: "root",
        },
      ];
    }
    case "tool-call":
    case "tool-call-input-streaming-start": {
      const toolName = pickToolName(c) ?? "tool";
      const toolCallId = pickToolCallId(c);
      const args = payload.args ?? payload.input ?? c.args;
      return [
        {
          type: "tool",
          partType: `tool-${toolName}`,
          toolName,
          toolCallId,
          toolState: type === "tool-call" ? "input-available" : "input-streaming",
          inputSummary: sanitizeSummary(args),
          nodeId: inferNodeId(toolName),
        },
      ];
    }
    case "tool-result": {
      const toolName = pickToolName(c) ?? "tool";
      const toolCallId = pickToolCallId(c);
      const result = payload.result ?? payload.output ?? c.result;
      return [
        {
          type: "tool_result",
          partType: `tool-${toolName}`,
          toolName,
          toolCallId,
          toolState: "output-available",
          outputSummary: sanitizeSummary(result),
          nodeId: inferNodeId(toolName),
        },
      ];
    }
    case "tool-error":
    case "error": {
      const toolName = pickToolName(c);
      const err =
        (typeof payload.error === "string" && payload.error) ||
        (typeof payload.message === "string" && payload.message) ||
        (typeof c.message === "string" && c.message) ||
        "error";
      if (toolName) {
        return [
          {
            type: "tool_result",
            partType: `tool-${toolName}`,
            toolName,
            toolCallId: pickToolCallId(c),
            toolState: "output-error",
            outputSummary: sanitizeSummary(err),
            nodeId: inferNodeId(toolName),
          },
        ];
      }
      return [{ type: "log", message: sanitizeSummary(err) ?? "error" }];
    }
    case "step-start":
    case "step-finish":
    case "finish":
    case "start":
      return [];
    default:
      // Drop reasoning / raw provider chunks from operator UI.
      if (type.startsWith("reasoning") || type.startsWith("source")) {
        return [];
      }
      return [];
  }
}

function inferNodeId(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes("domain") || n.includes("delegate_domain")) {
    return "domain";
  }
  if (n.includes("leaf") || n.includes("delegate_leaf")) {
    return "leaf";
  }
  if (n.includes("review")) {
    return "reviewer";
  }
  return "root";
}

/** Synthetic fixture stream for e2e (no live model). */
export function* fixtureStreamParts(runId: string): Generator<WikiStreamPart> {
  yield {
    type: "text",
    partType: "text",
    text: `## Wiki Run\n\nStarting fixture generation for \`${runId}\`.\n`,
    nodeId: "root",
  };
  yield {
    type: "tool",
    partType: "tool-list_source",
    toolName: "list_source",
    toolCallId: "fixture-list-1",
    toolState: "input-available",
    inputSummary: 'path=""',
    nodeId: "root",
  };
  yield {
    type: "tool_result",
    partType: "tool-list_source",
    toolName: "list_source",
    toolCallId: "fixture-list-1",
    toolState: "output-available",
    outputSummary: "entries: [README.md, src/]",
    nodeId: "root",
  };
  yield {
    type: "tool",
    partType: "tool-delegate_domain",
    toolName: "delegate_domain",
    toolCallId: "fixture-domain-1",
    toolState: "input-available",
    inputSummary: "scope=core",
    nodeId: "domain",
  };
  yield {
    type: "tool_result",
    partType: "tool-delegate_domain",
    toolName: "delegate_domain",
    toolCallId: "fixture-domain-1",
    toolState: "output-available",
    outputSummary: "receipt: analysis/core.md (fixture)",
    nodeId: "domain",
  };
  yield {
    type: "tool",
    partType: "tool-write_wiki",
    toolName: "write_wiki",
    toolCallId: "fixture-write-1",
    toolState: "input-available",
    inputSummary: 'path="overview.md"',
    nodeId: "root",
  };
  yield {
    type: "tool_result",
    partType: "tool-write_wiki",
    toolName: "write_wiki",
    toolCallId: "fixture-write-1",
    toolState: "output-available",
    outputSummary: "wrote overview.md",
    nodeId: "root",
  };
  yield {
    type: "tool",
    partType: "tool-reviewer",
    toolName: "reviewer",
    toolCallId: "fixture-review-1",
    toolState: "input-available",
    inputSummary: "pages=1",
    nodeId: "reviewer",
  };
  yield {
    type: "tool_result",
    partType: "tool-reviewer",
    toolName: "reviewer",
    toolCallId: "fixture-review-1",
    toolState: "output-available",
    outputSummary: "NO_DEFECTS",
    nodeId: "reviewer",
  };
  yield {
    type: "text",
    partType: "text",
    text: "\nFixture wiki page staged. Ready for publication review.\n",
    nodeId: "root",
  };
}
