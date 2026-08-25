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
import {
  assertReadableEntry,
  assertReadableNativeEntry,
  assertWritable,
  pathIsIgnored,
  workspaceRelativePath,
  type WikiWriteGuard,
} from "../path-policy.js";
import {
  formatBoard,
  replaceBoard,
  type WikiBoardStore,
  type WikiTaskStatus,
} from "../board.js";
import type { WikiCatalog, WikiCatalogRegistry } from "../catalog.js";

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

export function createCatalogTools(catalogs: WikiCatalogRegistry): ToolDefinition<any, any, any>[] {
  const available = [...catalogs.keys()].sort();
  if (!available.length) return [];
  const catalogDescription = `Catalog name. Available: ${available.join(", ")}`;
  return [
    {
      name: "db_tables",
      label: "Catalog tables",
      description: "List openGauss tables in one assigned Catalog. Optional query fuzzy-matches names. Use this before db_describe. Do not invent tables.",
      parameters: Type.Object({
        catalog: Type.String({ description: catalogDescription }),
        query: Type.Optional(Type.String({ description: "Fuzzy table name or glob (user, order%, pay*)" })),
      }),
      async execute(_id, params) {
        const input = params as { catalog?: string; query?: string };
        try {
          const catalog = assignedCatalog(catalogs, input.catalog);
          const text = `Catalog ${input.catalog}\n${await catalog.listTables(input.query)}`;
          return { content: [{ type: "text", text }], details: { catalog: input.catalog, text } };
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
      description: "Describe columns, keys, and indexes in one assigned Catalog. Pass specific names or fuzzy patterns. At most 20 tables per call.",
      parameters: Type.Object({
        catalog: Type.String({ description: catalogDescription }),
        tables: Type.Array(Type.String({ description: "Table name or fuzzy pattern" }), { minItems: 1 }),
      }),
      async execute(_id, params) {
        const input = params as { catalog?: string; tables?: string[] };
        try {
          const catalog = assignedCatalog(catalogs, input.catalog);
          const described = await catalog.describeTables(input.tables ?? []);
          const text = `Catalog ${input.catalog}\n${described.text}`;
          return {
            content: [{ type: "text", text }],
            details: { ...described, catalog: input.catalog, text },
          };
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

function assignedCatalog(catalogs: WikiCatalogRegistry, name: unknown): WikiCatalog {
  if (typeof name !== "string" || !catalogs.has(name)) {
    throw new Error(`Unknown or unavailable Catalog: ${String(name)}`);
  }
  return catalogs.get(name)!;
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
    description: toolDescription(name, tool.description),
    parameters: workspacePathParameters(tool.parameters),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mappedParams = structuredClone(params);
      try {
        if (mode === "read") applyDefaultReadRoot(name, mappedParams, guard);
        await remapParams(mappedParams, guard, mode);
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true,
        };
      }
      try {
        const result = await execute(toolCallId, mappedParams, signal, onUpdate, ctx);
        if (mode === "read" && (name === "grep" || name === "find" || name === "ls")) {
          return await normalizePathResult(name, mappedParams, result, guard);
        }
        return mode === "write" ? restoreModelPaths(result, mappedParams, params) : result;
      } catch (error) {
        return {
          content: [{ type: "text", text: toolError(name, params, mappedParams, error, guard) }],
          details: {},
          isError: true,
        };
      }
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
  record.path = ".";
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

async function normalizePathResult(
  name: "grep" | "find" | "ls",
  params: unknown,
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
  guard: WikiWriteGuard,
): Promise<{ content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }> {
  const searchRoot = searchRootOf(params) ?? guard.workspaceRoot;
  const content = result.content;
  if (!Array.isArray(content) || result.isError) return result;
  const next = await Promise.all(content.map(async (part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const text = await normalizePathText(name, part.text, searchRoot, guard);
    return { ...part, text };
  }));
  return { ...result, content: next };
}

function searchRootOf(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  return typeof record.path === "string" ? record.path : undefined;
}

async function normalizePathText(
  kind: "grep" | "find" | "ls",
  text: string,
  searchRoot: string,
  guard: WikiWriteGuard,
): Promise<string> {
  const kept: string[] = [];
  const searchIsDirectory = kind !== "grep" || await stat(searchRoot).then((entry) => entry.isDirectory(), () => false);
  for (const line of text.split("\n")) {
    const parsed = resultPath(kind, line);
    if (!parsed) {
      kept.push(line);
      continue;
    }
    try {
      const absolute = kind === "grep" && !searchIsDirectory
        ? searchRoot
        : path.resolve(searchRoot, parsed.path);
      await assertReadableNativeEntry(guard, absolute);
      const canonical = workspaceRelativePath(guard, absolute);
      if (canonical) kept.push(`${canonical}${parsed.suffix}`);
    } catch {
      // Search output is untrusted until each result resolves inside the evidence view.
    }
  }
  return kept.join("\n");
}

function resultPath(kind: "grep" | "find" | "ls", line: string): { path: string; suffix: string } | undefined {
  if (kind === "grep") {
    const match = /^(.*?)(:\d+:|-\d+-)(.*)$/.exec(line);
    return match?.[1] ? { path: match[1], suffix: `${match[2]}${match[3]}` } : undefined;
  }
  const trimmed = line.trim();
  if (
    !trimmed
    || trimmed === "No files found matching pattern"
    || /^\[(?:\d+ (?:results|entries) limit reached|[^\]]+ limit reached)(?:\.|\])/.test(trimmed)
    || trimmed === "(empty directory)"
  ) return undefined;
  return { path: trimmed.replace(/\/$/, ""), suffix: "" };
}

function restoreModelPaths(
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
  mappedParams: unknown,
  modelParams: unknown,
): typeof result {
  if (!isRecord(mappedParams) || !isRecord(modelParams) || !Array.isArray(result.content)) return result;
  const replacements: Array<[string, string]> = [];
  for (const key of PATH_KEYS) {
    if (typeof mappedParams[key] === "string" && typeof modelParams[key] === "string") {
      replacements.push([mappedParams[key], modelParams[key]]);
    }
  }
  if (!replacements.length) return result;
  return {
    ...result,
    content: result.content.map((part) => part.type === "text" && typeof part.text === "string"
      ? { ...part, text: replacements.reduce((text, [native, model]) => text.replaceAll(native, model), part.text) }
      : part),
  };
}

function toolError(
  name: string,
  params: unknown,
  mappedParams: unknown,
  error: unknown,
  guard: WikiWriteGuard,
): string {
  const location = isRecord(params)
    ? PATH_KEYS.map((key) => params[key]).find((value): value is string => typeof value === "string")
    : undefined;
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? ` (${error.code})`
    : "";
  const message = error instanceof Error ? sanitizeError(error.message, guard, mappedParams, params) : "";
  return `${name} failed${location ? ` for ${location}` : ""}${code}${message ? `: ${message}` : ""}`;
}

function sanitizeError(error: string, guard: WikiWriteGuard, mappedParams: unknown, modelParams: unknown): string {
  const replacements: Array<[string, string]> = [
    [guard.candidateRoot, "wiki"],
    [guard.handoffsRoot, path.relative(guard.workspaceRoot, guard.handoffsRoot).replaceAll("\\", "/")],
    ...guard.sources.flatMap((source): Array<[string, string]> => [
      [source.realPath, source.logicalPath],
      [path.join(guard.workspaceRoot, ...source.logicalPath.split("/")), source.logicalPath],
    ]),
    [guard.workspaceRoot, "."],
  ];
  if (isRecord(mappedParams) && isRecord(modelParams)) {
    for (const key of PATH_KEYS) {
      if (typeof mappedParams[key] === "string" && typeof modelParams[key] === "string") {
        replacements.push([mappedParams[key], modelParams[key]]);
      }
    }
  }
  return replacements
    .sort(([left], [right]) => right.length - left.length)
    .reduce((text, [native, model]) => {
      const posix = native.replaceAll("\\", "/");
      return text.replaceAll(native, model).replaceAll(posix, model);
    }, error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function toolDescription(name: string, description: string): string {
  const output = name === "find"
    ? " Results are full paths from the Workspace root."
    : name === "ls"
      ? " Results are full paths from the Workspace root; directory paths have no trailing slash."
      : name === "grep"
        ? " Result file paths are full paths from the Workspace root."
        : "";
  const corrected = name === "find"
    ? description.replace(" Returns matching file paths relative to the search directory.", "")
    : name === "ls"
      ? description.replace(" Returns entries sorted alphabetically, with '/' suffix for directories.", " Returns entries sorted alphabetically.")
      : description;
  return `${corrected}${output} Paths must be POSIX Workspace-relative with no leading slash (for example, repo-name/src/main.ts).`;
}

function workspacePathParameters(parameters: unknown): unknown {
  const copy = structuredClone(parameters);
  if (!isRecord(copy) || !isRecord(copy.properties)) return copy;
  for (const key of PATH_KEYS) {
    const property = copy.properties[key];
    if (isRecord(property)) {
      property.description = "POSIX Workspace-relative path with no leading slash (for example, repo-name/src/main.ts)";
    }
  }
  return copy;
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
