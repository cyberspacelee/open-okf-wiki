import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isSafeWikiPagePath } from "./path.js";
import { templateMatchesFilename, type WikiTemplate, type WikiTemplatePack } from "./templates.js";
import { writeTargetAllows, type WikiWriteTarget } from "./write-target.js";

const STATUSES = ["pending", "in_progress", "completed"] as const;
type WriterTodoStatus = (typeof STATUSES)[number];

export interface WriterTodoItem {
  path: string;
  status: WriterTodoStatus;
}

export function createWriterTodoTracker(
  target: WikiWriteTarget,
  options: { templates?: WikiTemplatePack; implicit?: boolean } = {},
) {
  let items: WriterTodoItem[] | undefined;
  const tool = {
    name: "todo",
    label: "Writer Todo",
    description: "Plan and update every Candidate page in this write assignment. Write the complete page list before authoring, keep at most one item in_progress, and mark a page completed only after rereading it against its active contract.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("write")]),
      items: Type.Optional(Type.Array(Type.Object({
        path: Type.String({ description: "Workspace-relative wiki/... Markdown path" }),
        status: Type.Union(STATUSES.map((status) => Type.Literal(status))),
      }))),
    }),
    async execute(_id, params) {
      try {
        const input = params as { action?: "list" | "write"; items?: WriterTodoItem[] };
        if (input.action === "write") items = parseItems(input.items, target, options);
        return {
          content: [{ type: "text", text: formatItems(items) }],
          details: { items: items ?? [] },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true,
        };
      }
    },
  } as ToolDefinition<any, any, any>;
  return {
    tool,
    snapshot: () => items ? structuredClone(items) : [],
    assertComplete(files: readonly string[]) {
      if (!items?.length) throw new Error("Writer must create a page Todo before completing the assignment");
      const remaining = items.filter((item) => item.status !== "completed");
      if (remaining.length) throw new Error(`Writer Todo is incomplete: ${remaining.map((item) => item.path).join(", ")}`);
      const planned = new Set(items.map((item) => item.path.slice("wiki/".length)));
      const missing = [...planned].filter((page) => !files.includes(page));
      if (missing.length) throw new Error(`Writer Todo completed pages are missing from the Candidate: ${missing.join(", ")}`);
      const untracked = files.filter((page) => !planned.has(page));
      if (untracked.length) throw new Error(`Writer Todo does not cover target pages: ${untracked.join(", ")}`);
    },
  };
}

function parseItems(
  value: WriterTodoItem[] | undefined,
  target: WikiWriteTarget,
  options: { templates?: WikiTemplatePack; implicit?: boolean },
): WriterTodoItem[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Writer Todo requires at least one page");
  const seen = new Set<string>();
  let active = 0;
  const parsed = value.map((item, index) => {
    if (!item || typeof item.path !== "string" || !STATUSES.includes(item.status)) {
      throw new Error(`Writer Todo item ${index} is invalid`);
    }
    const page = item.path.trim();
    if (!page.startsWith("wiki/") || !isSafeWikiPagePath(page.slice("wiki/".length))) {
      throw new Error(`Writer Todo path is not a safe wiki/... page: ${page}`);
    }
    if (!writeTargetAllows(target, page.slice("wiki/".length))) {
      throw new Error(`Writer Todo path is outside ${target.mode}:${target.path}: ${page}`);
    }
    if (options.templates) assertTemplatePlacement(page, target, options.templates, options.implicit ?? false);
    if (seen.has(page)) throw new Error(`Writer Todo path is duplicated: ${page}`);
    seen.add(page);
    if (item.status === "in_progress") active += 1;
    return { path: page, status: item.status };
  });
  if (active > 1) throw new Error("Writer Todo may have at most one in_progress page");
  return parsed;
}

function assertTemplatePlacement(
  page: string,
  target: WikiWriteTarget,
  pack: WikiTemplatePack,
  implicit: boolean,
): void {
  const relative = page.slice("wiki/".length);
  const filename = relative.split("/").at(-1)!;
  const contracts = pack.templates.filter((template) => templateMatchesFilename(template, filename));
  if (!contracts.length) throw new Error(`No active page contract matches Writer Todo path: ${page}`);
  const allowed = placementAt(relative, target, implicit);
  if (contracts.some((template) => templatePlacement(template).some((scope) => allowed.has(scope)))) return;
  const contract = contracts[0]!;
  throw new Error(`${contract.id} is not allowed at ${page}; expected ${expectedPath(contract, target)}`);
}

function placementAt(relative: string, target: WikiWriteTarget, implicit: boolean): Set<string> {
  if (target.path === "wiki-root") return new Set(implicit ? ["wiki", "repo"] : ["wiki"]);
  const prefix = `${target.path}/`;
  const local = relative.startsWith(prefix) ? relative.slice(prefix.length) : "";
  const depth = local.split("/").length;
  if (target.mode === "directory") return new Set(["repo"]);
  return new Set(depth === 1 ? ["domain"] : depth === 2 ? ["concept"] : []);
}

function templatePlacement(template: WikiTemplate): string[] {
  return template.altitudes ?? (template.scope ? [template.scope] : []);
}

function expectedPath(template: WikiTemplate, target: WikiWriteTarget): string {
  const filename = template.filename.replace("{slug}", "<topic>");
  if (template.scope === "concept") return `wiki/${target.path}/<concept>/${filename}`;
  return target.path === "wiki-root" ? `wiki/${filename}` : `wiki/${target.path}/${filename}`;
}

function formatItems(items: readonly WriterTodoItem[] | undefined): string {
  if (!items?.length) return "Writer Todo: not planned.";
  const completed = items.filter((item) => item.status === "completed").length;
  return [
    `Writer Todo: ${completed}/${items.length} completed.`,
    ...items.map((item) => `${item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]"} ${item.path}`),
  ].join("\n");
}
