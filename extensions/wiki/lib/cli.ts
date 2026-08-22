import type { WikiRunView } from "./producer-types.js";

const LOCAL_DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

function formatLocalDateTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? LOCAL_DATE_TIME.format(timestamp) : value;
}

export type WikiCliCommand =
  | { action: "run"; focus?: string }
  | { action: "init"; workspace?: string; language: "zh" | "en"; exclude: string[]; defaultSourceIgnores: boolean }
  | { action: "source-add"; kind: "link"; localPath: string; name?: string; workspace?: string }
  | { action: "source-add"; kind: "clone"; url: string; ref?: string; name?: string; workspace?: string }
  | { action: "status" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "cancel" };

export function parseWikiCliCommand(raw: string): WikiCliCommand {
  const values = tokenize(raw);
  if (values.length === 0) return { action: "run" };

  const action = values[0]!.toLowerCase();
  const rest = values.slice(1);
  switch (action) {
    case "init":
      return parseInit(rest);
    case "source":
      return parseSource(rest);
    case "status":
      requireNoArguments(rest, "status");
      return { action };
    case "runs":
      throw new Error("/wiki runs was removed; only the current Run is retained");
    case "pause":
      requireNoArguments(rest, "pause");
      return { action };
    case "resume":
      requireNoArguments(rest, "resume");
      return { action };
    case "cancel":
      requireNoArguments(rest, "cancel");
      return { action };
    default:
      return { action: "run", focus: joinedFocus(values) };
  }
}

function parseInit(values: string[]): Extract<WikiCliCommand, { action: "init" }> {
  let workspace: string | undefined;
  let language: "zh" | "en" = "zh";
  const exclude: string[] = [];
  let defaultSourceIgnores = true;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--lang") {
      const next = values[++index];
      if (next !== "zh" && next !== "en") throw new Error("zh or en");
      language = next;
      continue;
    }
    if (value === "--exclude") {
      const next = values[++index];
      if (!next) throw new Error("--exclude requires a value");
      exclude.push(next);
      continue;
    }
    if (value === "--no-default-ignores") {
      defaultSourceIgnores = false;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`Unknown flag: ${value}`);
    if (workspace) throw new Error("Usage: /wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]");
    workspace = value;
  }
  return { action: "init", ...(workspace ? { workspace } : {}), language, exclude, defaultSourceIgnores };
}

function parseSource(values: string[]): Extract<WikiCliCommand, { action: "source-add" }> {
  if (values[0] !== "add") throw new Error("Usage: /wiki source add link|clone ...");
  const kind = values[1];
  if (kind !== "link" && kind !== "clone") throw new Error("Usage: /wiki source add link|clone ...");
  const rest = values.slice(2);
  let name: string | undefined;
  let workspace: string | undefined;
  let ref: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (value === "--name") {
      name = rest[++index];
      if (!name) throw new Error("--name requires a value");
      continue;
    }
    if (value === "--workspace") {
      workspace = rest[++index];
      if (!workspace) throw new Error("--workspace requires a value");
      continue;
    }
    if (value === "--ref") {
      if (kind === "link") throw new Error("Unknown flag: --ref");
      ref = rest[++index];
      if (!ref) throw new Error("--ref requires a value");
      continue;
    }
    if (value.startsWith("-")) throw new Error(`Unknown flag: ${value}`);
    positional.push(value);
  }
  if (kind === "link") {
    if (positional.length !== 1) throw new Error("Usage: /wiki source add link <local-path>");
    return { action: "source-add", kind: "link", localPath: positional[0]!, ...(name ? { name } : {}), ...(workspace ? { workspace } : {}) };
  }
  if (positional.length !== 1) throw new Error("Usage: /wiki source add clone <url>");
  return {
    action: "source-add",
    kind: "clone",
    url: positional[0]!,
    ...(ref ? { ref } : {}),
    ...(name ? { name } : {}),
    ...(workspace ? { workspace } : {}),
  };
}

function requireNoArguments(values: string[], action: string): void {
  if (values.length) throw new Error(`/wiki ${action} does not accept arguments`);
}

function joinedFocus(values: string[]): string {
  return values.join(" ").trim();
}

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of raw.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? "");
  return tokens;
}

export function formatToolCall(tool: string, args: unknown): string {
  const record = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  const pathArg = String(record.path ?? record.file ?? record.file_path ?? record.target ?? "");
  switch (tool) {
    case "read": {
      const offset = typeof record.offset === "number" ? record.offset : undefined;
      const limit = typeof record.limit === "number" ? record.limit : undefined;
      let text = pathArg || "...";
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : "";
        text += `:${start}${end ? `-${end}` : ""}`;
      }
      return `read ${text}`;
    }
    case "write":
      return `write ${pathArg || "..."}`;
    case "edit":
      return `edit ${pathArg || "..."}`;
    case "ls":
      return `ls ${pathArg || "."}`;
    case "find":
      return `find ${String(record.pattern ?? "*")} in ${pathArg || "."}`;
    case "grep":
      return `grep /${String(record.pattern ?? "")}/ in ${pathArg || "."}`;
    case "subagent": {
      if (Array.isArray(record.tasks) && record.tasks.length) {
        const names = record.tasks
          .map((task) => task && typeof task === "object" && "agent" in task ? String((task as { agent?: unknown }).agent ?? "") : "")
          .filter(Boolean)
          .join(",");
        return `subagent ${names || `parallel (${record.tasks.length})`}`;
      }
      return `subagent ${String(record.agent ?? "...")}`;
    }
    case "db_tables":
      return typeof record.query === "string" && record.query ? `db_tables ${record.query}` : "db_tables";
    case "db_describe": {
      const tables = Array.isArray(record.tables) ? record.tables.map(String).join(",") : "";
      return tables ? `db_describe ${tables}` : "db_describe";
    }
    case "todo":
      return `todo ${String(record.action ?? "")}`.trim();
    case "publish":
      return "publish";
    default: {
      const preview = args === undefined ? "" : JSON.stringify(args);
      if (!preview || preview === "{}") return tool;
      return preview.length > 50 ? `${tool} ${preview.slice(0, 50)}...` : `${tool} ${preview}`;
    }
  }
}

export function renderWikiLive(run: WikiRunView): string[] {
  const heading = `Wiki ${run.id} | ${run.status}${run.focus ? ` | ${run.focus}` : ""}`;
  const lines = [heading];
  for (const task of run.tasks ?? []) {
    if (task.status === "in_progress") lines.push(`in_progress  ${task.id}  ${truncate(task.content, 60)}`);
  }
  for (const agent of run.agents ?? []) {
    if (agent.status !== "running") continue;
    const current = agent.tools.find((tool) => tool.status === "running") ?? agent.tools.at(-1);
    lines.push(current
      ? `◆ ${agent.agent} · ${formatToolCall(current.tool, current.args)}`
      : `running  ${agent.agent}`);
  }
  return lines.slice(0, 6);
}

export function renderWikiRun(run: WikiRunView | undefined): string {
  if (!run) return "Wiki: no run.";
  const focus = run.focus ? ` | ${run.focus}` : "";
  const goal = run.goal && run.goal !== run.focus ? `\n  goal  ${truncate(run.goal, 80)}` : "";
  const error = run.error ? `\n${run.error}` : "";
  const tasks = run.tasks?.length
    ? `\n${run.tasks.map((task) => `  ${task.status}  ${task.id}  ${truncate(task.content, 80)}`).join("\n")}`
    : "";
  const agents = run.agents?.length
    ? `\n${run.agents.map((agent) => agentLines(agent)).join("\n")}`
    : "";
  const pages = run.pageCount !== undefined ? ` | ${run.pageCount} pages` : "";
  return `Wiki ${run.id} | ${run.status}${focus}${pages}${goal}${tasks}${agents}${error}`;
}

function agentLines(agent: NonNullable<WikiRunView["agents"]>[number]): string {
  const task = agent.task ? `  ${truncate(agent.task, 80)}` : "";
  const current = agent.tools.find((tool) => tool.status === "running") ?? agent.tools.at(-1);
  const tool = current ? `  ${toolMarker(current.status)} ${formatToolCall(current.tool, current.args)}` : "";
  return `  ${agent.status}  ${agent.agent}${task}${tool}`;
}

function toolMarker(status: "running" | "complete" | "failed"): string {
  if (status === "complete") return "✓";
  if (status === "failed") return "✗";
  return "◆";
}

export function wikiFooterStatus(run: WikiRunView): string {
  if (run.status !== "running") return `wiki ${run.status}`;
  const flying = (run.agents ?? []).filter((agent) => agent.status === "running");
  for (const agent of flying) {
    const current = agent.tools.find((tool) => tool.status === "running");
    if (current) return `wiki running · ${agent.agent} · ${formatToolCall(current.tool, current.args)}`;
  }
  if (flying.length) return `wiki running · ${flying.map((agent) => agent.agent).join(",")}`;
  return "wiki running";
}

export function renderWikiSnapshot(run: WikiRunView): string {
  return `${renderWikiRun(run)}\n\nsnapshot as of ${formatLocalDateTime(run.updatedAt)}`;
}

export function wikiCliHelp(): string {
  return [
    "Usage:",
    "  /wiki [focus]",
    "  /wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]",
    "  /wiki source add link <local-path> [--name <name>] [--workspace <dir>]",
    "  /wiki source add clone <url> [--ref <ref>] [--name <name>] [--workspace <dir>]",
    "  /wiki status",
    "  /wiki pause",
    "  /wiki resume",
    "  /wiki cancel",
  ].join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
