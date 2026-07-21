/**
 * Session message adapter: durable schemaVersion-2 SessionMessage ↔ AI SDK UIMessage.
 * Rows are already UIMessage-shaped (id/role/parts); this path applies operator
 * tool projection (truncate) so full write/read payloads do not re-inflate the UI.
 * No legacy part migrate (ADR 0027).
 */

import type { UIMessage } from "ai";
import type { SessionMessage } from "@okf-wiki/contract";
import { projectSessionToolPart } from "./ui-projection.js";

/** Convert durable SessionMessage rows to AI SDK UIMessage shape. */
export function sessionMessagesToUIMessages(
  messages: SessionMessage[],
): UIMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: (m.parts ?? []).map((raw) => {
      const p = projectSessionToolPart(raw);
      if (p.type === "text" && "text" in p) {
        return {
          type: "text" as const,
          text: p.text,
          ...("state" in p && p.state ? { state: p.state } : {}),
        };
      }
      if (p.type === "reasoning" && "text" in p) {
        return {
          type: "reasoning" as const,
          text: p.text,
          ...("state" in p && p.state ? { state: p.state } : {}),
        } as UIMessage["parts"][number];
      }
      if (p.type === "dynamic-tool") {
        const tool = p as {
          type: string;
          toolCallId?: string;
          toolName?: string;
          state?: string;
          input?: unknown;
          output?: unknown;
          errorText?: string;
        };
        return {
          type: "dynamic-tool" as const,
          toolCallId: tool.toolCallId ?? "dynamic",
          toolName: tool.toolName ?? "tool",
          state: (tool.state as "output-available") ?? "output-available",
          input: tool.input,
          output: tool.output,
          errorText: tool.errorText,
        } as UIMessage["parts"][number];
      }
      if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const tool = p as {
          type: string;
          toolCallId?: string;
          toolName?: string;
          state?: string;
          input?: unknown;
          output?: unknown;
          errorText?: string;
        };
        return {
          type: tool.type as `tool-${string}`,
          toolCallId: tool.toolCallId ?? tool.type,
          state: (tool.state as "output-available") ?? "output-available",
          input: tool.input,
          output: tool.output,
          errorText: tool.errorText,
        } as UIMessage["parts"][number];
      }
      if (typeof p.type === "string" && p.type.startsWith("data-")) {
        const dataPart = p as { type: string; id?: string; data?: unknown };
        return {
          type: dataPart.type as `data-${string}`,
          id: dataPart.id,
          data: dataPart.data,
        } as UIMessage["parts"][number];
      }
      if (p.type === "step-start") {
        return { type: "step-start" as const };
      }
      if (p.type === "source-url" || p.type === "file") {
        return p as UIMessage["parts"][number];
      }
      return { type: "text" as const, text: JSON.stringify(p) };
    }),
  }));
}

/** Convert AI SDK UI messages to durable SessionMessage rows (lossy-safe). */
export function uiMessagesToSessionMessages(
  messages: UIMessage[],
): SessionMessage[] {
  return messages.map((m) => {
    const parts: SessionMessage["parts"] = [];
    for (const p of m.parts ?? []) {
      if (p.type === "text") {
        parts.push({
          type: "text",
          text: p.text,
          ...("state" in p && p.state
            ? { state: p.state as "streaming" | "done" }
            : {}),
        });
        continue;
      }
      if (p.type === "reasoning") {
        parts.push({
          type: "reasoning",
          text: "text" in p ? String(p.text ?? "") : "",
          ...("state" in p && p.state
            ? { state: p.state as "streaming" | "done" }
            : {}),
        });
        continue;
      }
      if (p.type === "step-start") {
        parts.push({ type: "step-start" });
        continue;
      }
      if (p.type === "dynamic-tool") {
        parts.push(
          projectSessionToolPart({
            type: "dynamic-tool",
            toolCallId: "toolCallId" in p ? String(p.toolCallId ?? "") : "",
            toolName: "toolName" in p ? String(p.toolName ?? "tool") : "tool",
            state:
              "state" in p ? (p.state as string) : "output-available",
            input: "input" in p ? p.input : undefined,
            output: "output" in p ? p.output : undefined,
            errorText: "errorText" in p ? (p.errorText as string | undefined) : undefined,
          } as SessionMessage["parts"][number]),
        );
        continue;
      }
      if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        parts.push(
          projectSessionToolPart({
            type: p.type,
            toolCallId: "toolCallId" in p ? String(p.toolCallId ?? "") : "",
            toolName:
              "toolName" in p
                ? String(p.toolName ?? p.type.slice(5))
                : p.type.slice(5),
            state:
              "state" in p
                ? (p.state as string)
                : "output-available",
            input: "input" in p ? p.input : undefined,
            output: "output" in p ? p.output : undefined,
            errorText:
              "errorText" in p ? (p.errorText as string | undefined) : undefined,
          } as SessionMessage["parts"][number]),
        );
        continue;
      }
      if (typeof p.type === "string" && p.type.startsWith("data-")) {
        parts.push({
          type: p.type,
          id: "id" in p && typeof p.id === "string" ? p.id : undefined,
          data: "data" in p ? p.data : undefined,
        } as SessionMessage["parts"][number]);
        continue;
      }
      if (p.type === "source-url" || p.type === "file") {
        parts.push(p as SessionMessage["parts"][number]);
        continue;
      }
    }
    if (parts.length === 0) {
      parts.push({ type: "text", text: "(empty)" });
    }
    return {
      id: m.id,
      role: m.role as SessionMessage["role"],
      parts,
      createdAt: new Date().toISOString(),
    };
  });
}
