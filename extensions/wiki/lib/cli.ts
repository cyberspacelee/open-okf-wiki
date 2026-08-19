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
  | { action: "status"; runId?: string }
  | { action: "runs" }
  | { action: "pause" }
  | { action: "resume"; runId?: string }
  | { action: "cancel"; runId?: string };

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
      return parseStatus(rest);
    case "runs":
      requireNoArguments(rest, "runs");
      return { action };
    case "pause":
      requireNoArguments(rest, "pause");
      return { action };
    case "resume":
      return withOptionalRunId("resume", optionalRunId(rest, "resume"));
    case "cancel":
      return withOptionalRunId("cancel", optionalRunId(rest, "cancel"));
    default:
      return { action: "run", focus: joinedFocus(values) };
  }
}

function withOptionalRunId<T extends "resume" | "cancel">(
  action: T,
  runId: string | undefined,
): Extract<WikiCliCommand, { action: T }> {
  return (runId ? { action, runId } : { action }) as Extract<WikiCliCommand, { action: T }>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseStatus(values: string[]): Extract<WikiCliCommand, { action: "status" }> {
  if (values.length > 1) throw new Error("Usage: /wiki status [run-id]");
  if (values[0] && !SAFE_ID.test(values[0])) throw new Error("Invalid Wiki run id");
  return values[0] ? { action: "status", runId: values[0] } : { action: "status" };
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

function optionalRunId(values: string[], action: string): string | undefined {
  if (values.length > 1) throw new Error(`Usage: /wiki ${action} [run-id]`);
  if (values[0] && !SAFE_ID.test(values[0])) throw new Error("Invalid Wiki run id");
  return values[0];
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

export function renderWikiRun(run: WikiRunView | undefined): string {
  if (!run) return "Wiki: no run.";
  const focus = run.focus ? ` | ${run.focus}` : "";
  const error = run.error ? `\n${run.error}` : "";
  const agents = run.agents?.length
    ? `\n${run.agents.map((agent) => `  ${agent.status}  ${agent.agent}  ${truncate(agent.task, 80)}`).join("\n")}`
    : "";
  const pages = run.pageCount !== undefined ? ` | ${run.pageCount} pages` : "";
  return `Wiki ${run.id} | ${run.status}${focus}${pages}${agents}${error}`;
}

export function renderWikiSnapshot(run: WikiRunView): string {
  return `${renderWikiRun(run)}\n\nsnapshot as of ${formatLocalDateTime(run.updatedAt)}`;
}

export function renderWikiRuns(runs: readonly WikiRunView[]): string {
  if (runs.length === 0) return "Wiki runs: none.";
  return ["Wiki runs", ...runs.map((run) => {
    const focus = run.focus ? ` | ${run.focus}` : "";
    const updated = run.updatedAt ? `${formatLocalDateTime(run.updatedAt)} | ` : "";
    return `${updated}${run.id} | ${run.status}${focus}`;
  })].join("\n");
}

export function wikiCliHelp(): string {
  return [
    "Usage:",
    "  /wiki [focus]",
    "  /wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]",
    "  /wiki source add link <local-path> [--name <name>] [--workspace <dir>]",
    "  /wiki source add clone <url> [--ref <ref>] [--name <name>] [--workspace <dir>]",
    "  /wiki status [run-id]",
    "  /wiki runs",
    "  /wiki pause",
    "  /wiki resume [run-id]  (does not restore Pi sessions; run /wiki again)",
    "  /wiki cancel [run-id]",
  ].join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
