import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { assertReadable, assertWritable, type WikiWriteGuard } from "../path-policy.js";

const PATH_KEYS = ["path", "file", "target", "dir", "directory"] as const;

export function candidateTools(guard: WikiWriteGuard, allowed?: readonly string[]): ToolDefinition<any, any, any>[] {
  const allow = allowed ? new Set(allowed) : undefined;
  const tools = [
    wrap("read", createReadToolDefinition(guard.workspaceRoot), guard, "read"),
    wrap("grep", createGrepToolDefinition(guard.workspaceRoot), guard, "read"),
    wrap("find", createFindToolDefinition(guard.workspaceRoot), guard, "read"),
    wrap("ls", createLsToolDefinition(guard.workspaceRoot), guard, "read"),
    wrap("write", createWriteToolDefinition(guard.workspaceRoot), guard, "write"),
    wrap("edit", createEditToolDefinition(guard.workspaceRoot), guard, "write"),
  ];
  return allow ? tools.filter((tool) => allow.has(tool.name)) : tools;
}

function wrap(
  name: string,
  tool: ToolDefinition<any, any, any>,
  guard: WikiWriteGuard,
  mode: "read" | "write",
): ToolDefinition<any, any, any> {
  const execute = tool.execute;
  return {
    ...tool,
    name,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      remapParams(params, guard, mode);
      return await execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } as ToolDefinition<any, any, any>;
}

function remapParams(params: unknown, guard: WikiWriteGuard, mode: "read" | "write"): void {
  if (!params || typeof params !== "object") return;
  const record = params as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    if (typeof record[key] !== "string") continue;
    record[key] = mode === "write" ? assertWritable(guard, record[key]) : assertReadable(guard, record[key]);
  }
  if (Array.isArray(record.paths)) {
    record.paths = record.paths.map((value) => {
      if (typeof value !== "string") return value;
      return mode === "write" ? assertWritable(guard, value) : assertReadable(guard, value);
    });
  }
}
