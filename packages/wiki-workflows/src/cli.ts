import type {
  WikiAgentInspection,
  WikiAgentTarget,
  WikiRunProgress,
  WikiRunView,
} from "./producer-types.js";
import {
  projectWikiAgentLines,
  projectWikiRunObservability,
} from "./ui/observability.js";
import { formatLocalDateTime } from "./ui/time-format.js";

export type WikiCliCommand =
  | { action: "run"; focus?: string }
  | { action: "init"; workspace?: string; language: "zh" | "en"; exclude: string[]; defaultSourceIgnores: boolean }
  | { action: "source-add"; kind: "link"; localPath: string; name?: string; workspace?: string }
  | { action: "source-add"; kind: "clone"; url: string; ref?: string; name?: string; workspace?: string }
  | { action: "status"; runId?: string; target?: WikiAgentTarget; process?: boolean }
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
      return withOptionalRunId(action, optionalRunId(rest, "resume"));
    case "cancel":
      return withOptionalRunId(action, optionalRunId(rest, "cancel"));
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
const BATCH_TARGET = /^batch-(\d+)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

function parseStatus(values: string[]): Extract<WikiCliCommand, { action: "status" }> {
  let runId: string | undefined;
  let target: WikiAgentTarget | undefined;
  let process = false;
  let extra = false;
  for (const value of values) {
    if (value === "--process") {
      process = true;
      continue;
    }
    if (runId === undefined) {
      if (!SAFE_ID.test(value)) throw new Error("Invalid Wiki run id");
      runId = value;
      continue;
    }
    if (target === undefined) {
      if (value !== "lead" && !BATCH_TARGET.test(value)) throw new Error("Wiki agent target must be lead or batch-N/task-id");
      target = parseAgentTarget(value);
      continue;
    }
    extra = true;
  }
  if (extra || (process && !target) || (target && !runId)) {
    throw new Error("Usage: /wiki status [run-id] [lead|batch-N/task-id] [--process]");
  }
  return {
    action: "status",
    ...(runId ? { runId } : {}),
    ...(target ? { target } : {}),
    ...(process ? { process } : {}),
  };
}

function parseAgentTarget(value: string): WikiAgentTarget {
  if (value === "lead") return { kind: "lead" };
  const match = BATCH_TARGET.exec(value);
  if (!match) throw new Error("Wiki agent target must be lead or batch-N/task-id");
  return { kind: "task", batch: Number(match[1]), taskId: match[2]! };
}

export function renderWikiRun(run: WikiRunView | undefined): string {
  if (!run) return "Wiki: no run.";
  if (!run.progress) {
    const focus = run.focus ? ` | ${run.focus}` : "";
    const error = run.error ? `\n${run.error}` : "";
    return `Wiki ${run.id} | ${run.status}${focus}${error}`;
  }
  return renderWikiRunCard(run, run.progress);
}

export function renderWikiSnapshot(run: WikiRunView): string {
  return `${renderWikiRun(run)}\n\nsnapshot as of ${formatLocalDateTime(run.updatedAt)}`;
}

function renderWikiRunCard(run: WikiRunView, progress: WikiRunProgress): string {
  const semantics = projectWikiRunObservability(run);
  const elapsed = formatElapsed(run.createdAt, run.completedAt ?? run.updatedAt);
  const elapsedPart = elapsed ? `  [${elapsed}]` : "";
  const lines: string[] = [`Wiki ${run.id}  ${semantics.status.marker} ${semantics.status.label}${elapsedPart}`];

  const stageSegments = [`stage  ${semantics.stage?.label ?? progress.stage}`];
  if (semantics.batch) {
    stageSegments.push(`batch ${semantics.batch.batch}`);
    const { completed, total, running } = semantics.batch;
    stageSegments.push(`${completed}/${total} done${running > 0 ? `, ${running} running` : ""}`);
  }
  lines.push(stageSegments.join(" · "));

  if (run.focus) lines.push(`focus  ${run.focus}`);

  if (run.pause) {
    const retry = run.pause.retryAt ? ` · retry at ${formatLocalDateTime(run.pause.retryAt)}` : "";
    lines.push(`pause  ${run.pause.reason}${retry}`);
    if (run.pause.summary) lines.push(`       ${run.pause.summary}`);
  }

  if (run.error) lines.push(`error  ${run.error}`);

  if (semantics.batch && semantics.batch.tasks.length > 0) {
    lines.push("");
    for (const task of semantics.batch.tasks) {
      const attempt = `  [attempt ${task.attempt}]`;
      const activity = task.activity ? `  ·  ${task.activity}` : "";
      lines.push(`  ${task.marker} ${task.role}  ${task.identity}${attempt}${activity}`);
    }
  }

  const last = textValue(progress.lastMessage);
  if (last) lines.push(`last  ${last}`);

  return lines.join("\n");
}

function formatElapsed(start: string, end: string): string | undefined {
  const created = Date.parse(start);
  const finished = Date.parse(end);
  if (!Number.isFinite(created) || !Number.isFinite(finished) || finished < created) return undefined;
  const totalSeconds = Math.floor((finished - created) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

export function renderWikiRuns(runs: readonly WikiRunView[]): string {
  if (runs.length === 0) return "Wiki runs: none.";
  return ["Wiki runs", ...runs.map((run) => {
    const focus = run.focus ? ` | ${run.focus}` : "";
    const updated = run.updatedAt ? `${formatLocalDateTime(run.updatedAt)} | ` : "";
    return `${updated}${run.id} | ${run.status}${focus}`;
  })].join("\n");
}

export function renderWikiAgent(
  inspection: WikiAgentInspection,
  tab: "overview" | "process" | "output" = "overview",
): string {
  return projectWikiAgentLines(inspection, tab)
    .map((line) => line.map((span) => span.text).join(""))
    .join("\n");
}

export function wikiCliHelp(): string {
  return [
    "Usage:",
    "  /wiki [focus]",
    "  /wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]",
    "  /wiki source add link <local-path> [--name <name>] [--workspace <dir>]",
    "  /wiki source add clone <url> [--ref <ref>] [--name <name>] [--workspace <dir>]",
    "  /wiki status [run-id] [lead|batch-N/task-id] [--process]",
    "  /wiki runs",
    "  /wiki pause",
    "  /wiki resume [run-id]",
    "  /wiki cancel [run-id]",
  ].join("\n");
}

function parseInit(values: string[]): Extract<WikiCliCommand, { action: "init" }> {
  let workspace: string | undefined;
  let language: "zh" | "en" = "zh";
  let languageSet = false;
  let defaultSourceIgnores = true;
  let ignoresSet = false;
  const exclude: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--lang") {
      if (languageSet) throw new Error("--lang may be specified only once");
      const selected = optionValue(values, ++index, "--lang");
      if (selected !== "zh" && selected !== "en") throw new Error("--lang must be zh or en");
      language = selected;
      languageSet = true;
    } else if (value === "--exclude") {
      exclude.push(optionValue(values, ++index, "--exclude"));
    } else if (value === "--no-default-ignores") {
      if (ignoresSet) throw new Error("--no-default-ignores may be specified only once");
      defaultSourceIgnores = false;
      ignoresSet = true;
    } else if (value.startsWith("--")) {
      throw new Error(`Unknown /wiki init option: ${value}`);
    } else if (workspace === undefined) {
      workspace = value;
    } else {
      throw new Error("Usage: /wiki init [workspace] [--lang zh|en] [--exclude <glob>]... [--no-default-ignores]");
    }
  }
  return { action: "init", ...(workspace ? { workspace } : {}), language, exclude, defaultSourceIgnores };
}

function parseSource(values: string[]): Extract<WikiCliCommand, { action: "source-add" }> {
  if (values[0] !== "add" || (values[1] !== "link" && values[1] !== "clone") || !values[2]) {
    throw new Error("Usage: /wiki source add link <local-path> | clone <url>");
  }
  const kind = values[1];
  const target = values[2];
  let name: string | undefined;
  let workspace: string | undefined;
  let ref: string | undefined;
  for (let index = 3; index < values.length; index += 1) {
    const option = values[index]!;
    if (option === "--name") {
      if (name !== undefined) throw new Error("--name may be specified only once");
      name = optionValue(values, ++index, "--name");
    } else if (option === "--workspace") {
      if (workspace !== undefined) throw new Error("--workspace may be specified only once");
      workspace = optionValue(values, ++index, "--workspace");
    } else if (option === "--ref" && kind === "clone") {
      if (ref !== undefined) throw new Error("--ref may be specified only once");
      ref = optionValue(values, ++index, "--ref");
    } else {
      throw new Error(`Unknown /wiki source add ${kind} option: ${option}`);
    }
  }
  const common = { action: "source-add" as const, kind, ...(name ? { name } : {}), ...(workspace ? { workspace } : {}) };
  return kind === "link" ? { ...common, kind, localPath: target } : { ...common, kind, url: target, ...(ref ? { ref } : {}) };
}

function optionValue(values: string[], index: number, option: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function tokenize(input: string): string[] {
  const values: string[] = [];
  for (const match of input.matchAll(/"([^\"]*)"|'([^']*)'|(\S+)/g)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return values;
}

function joinedFocus(values: string[]): string | undefined {
  return values.join(" ").trim() || undefined;
}

function optionalRunId(values: string[], action: string): string | undefined {
  if (values.length > 1) throw new Error(`Usage: /wiki ${action} [run-id]`);
  const value = values[0];
  if (value && !SAFE_ID.test(value)) {
    throw new Error("Invalid Wiki run id");
  }
  return value;
}

function requireNoArguments(values: string[], action: string): void {
  if (values.length > 0) throw new Error(`/wiki ${action} does not accept arguments`);
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
