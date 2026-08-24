import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { exists } from "../files.js";
import { Type } from "typebox";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { assertReadableEntry, assertWritable, pathIsIgnored, type WikiWriteGuard } from "../path-policy.js";
import {
  formatBoard,
  replaceBoard,
  type WikiBoardStore,
  type WikiTaskStatus,
} from "../board.js";
import type { WikiCatalog } from "../catalog.js";

const PATH_KEYS = ["path", "file", "target", "dir", "directory"] as const;

export function candidateTools(guard: WikiWriteGuard, allowed?: readonly string[]): ToolDefinition<any, any, any>[] {
  const allow = allowed ? new Set(allowed) : undefined;
  const tools = [
    wrap("read", createReadToolDefinition(guard.workspaceRoot), guard, "read"),
    wrap("grep", createGrepToolDefinition(guard.workspaceRoot), guard, "read"),
    wrap("find", createFindToolDefinition(guard.workspaceRoot), guard, "read"),
    wrap("ls", createLsToolDefinition(guard.workspaceRoot, { operations: lsOperations(guard) }), guard, "read"),
    wrap("write", createWriteToolDefinition(guard.workspaceRoot), guard, "write"),
    wrap("edit", createEditToolDefinition(guard.workspaceRoot), guard, "write"),
  ];
  return allow ? tools.filter((tool) => allow.has(tool.name)) : tools;
}

export function createTodoTool(store: WikiBoardStore): ToolDefinition<any, any, any> {
  return {
    name: "todo",
    label: "Board",
    description: "Read or replace the Run Board. The Board is the source of truth for the goal and remaining work after compaction or resume. Write the full task list. At most one task may be in_progress.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("write")]),
      goal: Type.Optional(Type.String({ description: "Run goal kept across compaction" })),
      tasks: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Type.String({ description: "Stable task id; assigned if omitted" })),
        content: Type.String({ description: "What remains to do" }),
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
          Type.Literal("failed"),
        ]),
        note: Type.Optional(Type.String({ description: "Short progress note that must survive compaction" })),
      }))),
    }),
    async execute(_id, params) {
      const input = params as {
        action?: "list" | "write";
        goal?: string;
        tasks?: Array<{ id?: string; content: string; status: WikiTaskStatus; note?: string }>;
      };
      try {
        const current = await store.read();
        const board = input.action === "write"
          ? await store.write(replaceBoard(current, { goal: input.goal, tasks: input.tasks ?? current.tasks }))
          : current;
        return { content: [{ type: "text", text: formatBoard(board) }], details: board };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true,
        };
      }
    },
  } as ToolDefinition<any, any, any>;
}

export function createCatalogTools(catalog: WikiCatalog): ToolDefinition<any, any, any>[] {
  return [
    {
      name: "db_tables",
      label: "Catalog tables",
      description: "List openGauss tables in the configured Catalog. Optional query fuzzy-matches names. Use this before db_describe. Do not invent tables.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Fuzzy table name or glob (user, order%, pay*)" })),
      }),
      async execute(_id, params) {
        const query = (params as { query?: string }).query;
        try {
          const text = await catalog.listTables(query);
          return { content: [{ type: "text", text }], details: { text } };
        } catch (error) {
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            details: {},
            isError: true,
          };
        }
      },
    } as ToolDefinition<any, any, any>,
    {
      name: "db_describe",
      label: "Catalog describe",
      description: "Describe columns, keys, and indexes for matching Catalog tables. Pass specific names or fuzzy patterns. At most 20 tables per call.",
      parameters: Type.Object({
        tables: Type.Array(Type.String({ description: "Table name or fuzzy pattern" }), { minItems: 1 }),
      }),
      async execute(_id, params) {
        const tables = (params as { tables?: string[] }).tables ?? [];
        try {
          const described = await catalog.describeTables(tables);
          return { content: [{ type: "text", text: described.text }], details: described };
        } catch (error) {
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            details: {},
            isError: true,
          };
        }
      },
    } as ToolDefinition<any, any, any>,
  ];
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
      try {
        if (mode === "read") applyDefaultReadRoot(name, params, guard);
        await remapParams(params, guard, mode);
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true,
        };
      }
      const result = await execute(toolCallId, params, signal, onUpdate, ctx);
      if (mode === "read" && (name === "grep" || name === "find")) {
        return await filterSearchResult(name, params, result, guard);
      }
      return result;
    },
  } as ToolDefinition<any, any, any>;
}

function applyDefaultReadRoot(name: string, params: unknown, guard: WikiWriteGuard): void {
  if (name !== "grep" && name !== "find" && name !== "ls") return;
  if (!params || typeof params !== "object") return;
  const record = params as Record<string, unknown>;
  const hasPath = PATH_KEYS.some((key) => typeof record[key] === "string")
    || (Array.isArray(record.paths) && record.paths.some((value) => typeof value === "string"));
  if (hasPath) return;
  const implicit = guard.sources.length === 1 && guard.sources[0]?.logicalPath === ".";
  if (!implicit) throw new Error(`${name} requires an explicit path in a multi-Source Workspace`);
  record.path = guard.workspaceRoot;
}

function lsOperations(guard: WikiWriteGuard) {
  return {
    exists,
    stat,
    async readdir(absolutePath: string) {
      const entries = await readdir(absolutePath);
      return entries.filter((entry) => !pathIsIgnored(guard, path.join(absolutePath, entry)));
    },
  };
}

async function filterSearchResult(
  name: "grep" | "find",
  params: unknown,
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
  guard: WikiWriteGuard,
): Promise<{ content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }> {
  const searchRoot = searchRootOf(params) ?? guard.workspaceRoot;
  const content = result.content;
  if (!Array.isArray(content) || result.isError) return result;
  const next = await Promise.all(content.map(async (part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const text = await filterSearchText(name, part.text, searchRoot, guard);
    return { ...part, text };
  }));
  return { ...result, content: next };
}

function searchRootOf(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  return typeof record.path === "string" ? record.path : undefined;
}

async function filterSearchText(kind: "grep" | "find", text: string, searchRoot: string, guard: WikiWriteGuard): Promise<string> {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const relative = kind === "find" ? findPath(line) : grepPath(line);
    if (!relative) {
      kept.push(line);
      continue;
    }
    try {
      await assertReadableEntry(guard, path.resolve(searchRoot, relative));
      kept.push(line);
    } catch {
      // Search output is untrusted until each result resolves inside the evidence view.
    }
  }
  return kept.join("\n");
}

function findPath(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("No files")) return undefined;
  return trimmed;
}

function grepPath(line: string): string | undefined {
  const match = /^(.*?)(?::\d+:|-\d+-)/.exec(line);
  return match?.[1] || undefined;
}

async function remapParams(params: unknown, guard: WikiWriteGuard, mode: "read" | "write"): Promise<void> {
  if (!params || typeof params !== "object") return;
  const record = params as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    if (typeof record[key] !== "string") continue;
    record[key] = mode === "write"
      ? assertWritable(guard, record[key])
      : await assertReadableEntry(guard, record[key]);
  }
  if (Array.isArray(record.paths)) {
    record.paths = await Promise.all(record.paths.map(async (value) => {
      if (typeof value !== "string") return value;
      return mode === "write" ? assertWritable(guard, value) : await assertReadableEntry(guard, value);
    }));
  }
}
