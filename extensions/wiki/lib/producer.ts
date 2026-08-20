import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { inspectWiki, verifyPinnedSourcePlan, type WikiPinnedSourcePlan } from "./inspect.js";
import { exists, renamePath, writeText } from "./files.js";
import { errorMessage } from "./failures.js";
import { loadWikiWorkspace, resolveWorkspaceDatabase, type ResolvedWikiWorkspace, type WikiWorkspaceWikiConfig } from "./workspace.js";
import {
  formatIssue,
  materializeWikiIndexes,
  stampPublication,
  validateWikiTree,
} from "./wiki-okf.js";
import { writeGuardFromPlan } from "./path-policy.js";
import { candidateTools, createCatalogTools, createTodoTool } from "./pi/tools.js";
import { runWikiSession, type RunWikiSessionOptions } from "./pi/session.js";
import { createSubagentRuntime, createSubagentTool } from "./subagent.js";
import { createBoardStore, emptyBoard, formatBoard, type WikiBoard, type WikiBoardStore } from "./board.js";
import { createPostgresCatalog } from "./postgres.js";
import type { WikiCatalog } from "./catalog.js";
import {
  WikiRunResultError,
  type WikiAgentView,
  type WikiProducer,
  type WikiProducerRequest,
  type WikiProducerResult,
  type WikiRunControl,
  type WikiRunHandle,
  type WikiRunStatus,
  type WikiRunView,
  type WikiSessionActivity,
  type WikiToolView,
} from "./producer-types.js";

const LEAD_CANDIDATE_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface WikiProducerOptions {
  runLead?: (context: WikiLeadContext) => Promise<void>;
  session?: RunWikiSessionOptions;
  agentsDirectory?: string;
}

export interface WikiLeadContext {
  plan: WikiPinnedSourcePlan;
  candidateRoot: string;
  focus?: string;
  language: "zh" | "en";
  resume: boolean;
  board: WikiBoardStore;
  catalog?: WikiCatalog;
  signal: AbortSignal;
  publish(): Promise<{ ok: boolean; message: string }>;
  note(agent: string, task: string, status: "running" | "complete" | "failed"): void;
  observe(event: WikiSessionActivity): void;
}

interface RunRecord {
  id: string;
  cwd: string;
  status: WikiRunStatus;
  focus?: string;
  language: "zh" | "en";
  createdAt: string;
  updatedAt: string;
  error?: string;
  agents: Array<{ agent: string; task: string; status: "running" | "complete" | "failed" }>;
  pageCount?: number;
  candidateRoot: string;
  fingerprint: string;
  sessionFile?: string;
}

const active = new Map<string, LiveRun>();

const TOOL_LIMIT = 12;

interface LiveRun {
  record: RunRecord;
  plan: WikiPinnedSourcePlan;
  controller: AbortController;
  done: Promise<void>;
  result?: WikiProducerResult;
  board?: WikiBoard;
  agents: Map<string, WikiAgentView>;
  listeners: Set<(view: WikiRunView) => void>;
}

export function createProductionWikiProducer(options: WikiProducerOptions = {}): WikiProducer {
  return {
    async start(request) {
      const workspace = await loadWikiWorkspace(request.cwd);
      const blocking = (await listRecords(workspace.root)).find((run) => run.status === "running" || run.status === "paused");
      if (blocking) {
        throw new Error(blocking.status === "paused"
          ? `Wiki run ${blocking.id} is paused; use /wiki resume`
          : `Wiki run ${blocking.id} is already running`);
      }
      const plan = await inspectWiki(workspace.root);
      const id = randomUUID().slice(0, 8);
      const candidateRoot = path.join(workspace.root, ".okf-wiki", "runs", id, "candidate");
      await mkdir(candidateRoot, { recursive: true });
      const now = new Date().toISOString();
      const record: RunRecord = {
        id,
        cwd: workspace.root,
        status: "running",
        language: workspace.language,
        ...(request.focus ? { focus: request.focus } : {}),
        createdAt: now,
        updatedAt: now,
        agents: [],
        candidateRoot,
        fingerprint: plan.fingerprint,
      };
      await writeRecord(record);
      const live: LiveRun = emptyLive(record, plan);
      startLive(live, workspace, options, { resume: false, focus: request.focus });
      active.set(runKey(workspace.root, id), live);
      return handleFor(live, options, workspace);
    },
    async list(cwd) {
      const workspace = await loadWikiWorkspace(cwd);
      return await Promise.all((await listRecords(workspace.root)).map((record) => toViewFromRecord(record)));
    },
    async open(runId, cwd) {
      const workspace = await loadWikiWorkspace(cwd);
      const live = active.get(runKey(workspace.root, runId));
      if (live) return handleFor(live, options, workspace);
      const record = await readRecord(workspace.root, runId);
      if (!record) return undefined;
      return handleFor(emptyLive(record, await inspectWiki(workspace.root).catch(() => ({
        workspaceRoot: workspace.root,
        workspaceRealPath: workspace.root,
        configPath: workspace.configPath,
        defaultSourceIgnores: workspace.defaultSourceIgnores,
        excludes: workspace.wiki.exclude,
        sources: [],
        fingerprint: record.fingerprint,
      }))), options, workspace);
    },
  };
}

function startLive(
  live: LiveRun,
  workspace: ResolvedWikiWorkspace,
  options: WikiProducerOptions,
  flags: { resume: boolean; focus?: string },
): void {
  const record = live.record;
  const plan = live.plan;
  const controller = new AbortController();
  live.controller = controller;
  live.result = undefined;
  live.agents.set("lead", { agent: "lead", status: "running", tools: [] });
  live.done = (async () => {
    try {
      const initial = emptyBoard(flags.focus ?? "Generate a complete repository Wiki");
      const stored = createBoardStore(runDir(record.cwd, record.id), initial);
      const board = watchBoard(stored, live);
      if (!flags.resume) await board.write(initial);
      else live.board = await board.read();
      const catalog = workspace.database
        ? createPostgresCatalog(await resolveWorkspaceDatabase(workspace.database, workspace.root))
        : undefined;
      const context: WikiLeadContext = {
        plan,
        candidateRoot: record.candidateRoot,
        focus: flags.focus,
        language: record.language ?? workspace.language,
        resume: flags.resume,
        board,
        ...(catalog ? { catalog } : {}),
        signal: controller.signal,
        async publish() {
          return await publishCandidate(live, context.language);
        },
        note(agent, task, status) {
          noteAgent(live, agent, task, status);
        },
        observe(event) {
          observeTool(live, event);
        },
      };
      const runLead = options.runLead ?? defaultRunLead(options, record, workspace.wiki);
      await runLead(context);
      if (live.record.status === "running") {
        const published = await publishCandidate(live, context.language);
        if (!published.ok) throw new Error(published.message);
      }
    } catch (error) {
      if (live.record.status === "paused" || live.record.status === "cancelled") return;
      live.record.status = "failed";
      live.record.error = errorMessage(error);
      live.record.updatedAt = new Date().toISOString();
      settleLead(live, "failed");
      await writeRecord(live.record);
      emit(live);
    }
  })();
}

function defaultRunLead(
  options: WikiProducerOptions,
  record: RunRecord,
  config: WikiWorkspaceWikiConfig,
): (context: WikiLeadContext) => Promise<void> {
  return async (context) => {
    const session: RunWikiSessionOptions = {
      ...options.session,
      transientRetries: config.transientRetries,
      baseRetryDelayMs: config.baseRetryDelayMs,
      sessionTimeoutMs: config.sessionTimeoutSeconds * 1_000,
      onActivity(event) {
        context.observe(event);
      },
    };
    const runtime = await createSubagentRuntime(
      context.plan,
      context.candidateRoot,
      session,
      options.agentsDirectory,
      (agent, task, status) => context.note(agent, task, status),
      context.catalog,
      { maxConcurrency: config.maxConcurrentAgents - 1 },
    );
    const tools: ToolDefinition<any, any, any>[] = [
      ...candidateTools(writeGuardFromPlan(context.plan, context.candidateRoot), LEAD_CANDIDATE_TOOLS),
      createTodoTool(context.board),
      ...(context.catalog ? createCatalogTools(context.catalog) : []),
      createSubagentTool(runtime),
      createPublishTool(() => context.publish()),
    ];
    const prompt = await leadPrompt(context);
    await runWikiSession(context.plan.workspaceRoot, tools, prompt, context.signal, {
      ...session,
      sessionDir: path.join(runDir(record.cwd, record.id), "sessions"),
      sessionFile: record.sessionFile,
      onSessionReady(sessionFile) {
        if (!sessionFile) return;
        record.sessionFile = sessionFile;
        record.updatedAt = new Date().toISOString();
        void writeRecord(record);
      },
      async onCompaction() {
        const board = await context.board.read();
        return `The conversation was compacted. The Board is the source of truth for remaining work:\n${formatBoard(board)}`;
      },
    });
  };
}

function createPublishTool(publish: () => Promise<{ ok: boolean; message: string }>): ToolDefinition<any, any, any> {
  return {
    name: "publish",
    label: "Publish Wiki",
    description: "Validate the Candidate and install it as wiki/.",
    parameters: Type.Object({}),
    async execute() {
      const result = await publish();
      return {
        content: [{ type: "text", text: result.message }],
        details: result,
        ...(result.ok ? {} : { isError: true }),
      };
    },
  } as ToolDefinition<any, any, any>;
}

async function publishCandidate(live: LiveRun, language: "zh" | "en"): Promise<{ ok: boolean; message: string }> {
  await verifyPinnedSourcePlan(live.plan);
  const sources = new Map(live.plan.sources.map((source) => [source.scopeId, source.realPath]));
  const validation = await validateWikiTree(live.record.candidateRoot, sources);
  if (!validation.ok) {
    return { ok: false, message: validation.issues.map(formatIssue).join("\n") };
  }
  await materializeWikiIndexes(live.record.candidateRoot, language);
  const at = new Date().toISOString();
  await stampPublication(live.record.candidateRoot, at);
  const wikiRoot = path.join(live.plan.workspaceRoot, "wiki");
  if (await exists(wikiRoot)) await rm(wikiRoot, { recursive: true, force: true });
  await renamePath(live.record.candidateRoot, wikiRoot);
  live.record.status = "succeeded";
  live.record.pageCount = validation.pages.length;
  live.record.updatedAt = at;
  settleLead(live, "complete");
  await writeRecord(live.record);
  emit(live);
  const result = { id: live.record.id, wikiRoot, pages: validation.pages };
  live.result = result;
  return { ok: true, message: `Published ${validation.pages.length} pages to wiki/` };
}

function handleFor(live: LiveRun, options: WikiProducerOptions, workspace: ResolvedWikiWorkspace): WikiRunHandle {
  return {
    id: live.record.id,
    async view() {
      return await toView(live);
    },
    subscribe(listener) {
      live.listeners.add(listener);
      void toView(live).then((view) => {
        if (live.listeners.has(listener)) listener(view);
      });
      return () => { live.listeners.delete(listener); };
    },
    async control(action: WikiRunControl) {
      if (action === "resume") {
        await resumeLive(live, options, workspace);
        return await toView(live);
      }
      if (action === "pause") {
        live.record.status = "paused";
        live.controller.abort();
      } else if (action === "cancel") {
        live.record.status = "cancelled";
        live.controller.abort();
        settleLead(live, "failed");
      }
      live.record.updatedAt = new Date().toISOString();
      await writeRecord(live.record);
      emit(live);
      return await toView(live);
    },
    async result() {
      await live.done;
      if (live.result) return live.result;
      throw new WikiRunResultError(live.record.error ?? `Wiki run ${live.record.id} ${live.record.status}`, await toView(live));
    },
  };
}

async function resumeLive(
  live: LiveRun,
  options: WikiProducerOptions,
  workspace: ResolvedWikiWorkspace,
): Promise<void> {
  if (live.record.status === "running") return;
  if (live.record.status !== "paused" && live.record.status !== "failed") {
    throw new Error(`Cannot resume a ${live.record.status} Wiki run`);
  }
  if (!await exists(live.record.candidateRoot)) {
    throw new Error(`Wiki run ${live.record.id} has no Candidate to continue`);
  }
  const plan = await inspectWiki(workspace.root);
  if (plan.fingerprint !== live.record.fingerprint) {
    throw new Error("Pinned sources changed; start a new Run instead of resume");
  }
  await verifyPinnedSourcePlan(plan);
  live.plan = plan;
  live.record.status = "running";
  live.record.error = undefined;
  live.record.updatedAt = new Date().toISOString();
  await writeRecord(live.record);
  startLive(live, workspace, options, { resume: true, focus: live.record.focus });
  active.set(runKey(workspace.root, live.record.id), live);
}

async function toView(live: LiveRun): Promise<WikiRunView> {
  return toViewFrom(live.record, live.board ?? await createBoardStore(runDir(live.record.cwd, live.record.id)).read(), live.agents);
}

async function toViewFromRecord(record: RunRecord): Promise<WikiRunView> {
  return toViewFrom(record, await createBoardStore(runDir(record.cwd, record.id)).read(), new Map());
}

function toViewFrom(record: RunRecord, board: WikiBoard, agents: Map<string, WikiAgentView>): WikiRunView {
  return {
    id: record.id,
    cwd: record.cwd,
    status: record.status,
    ...(record.focus ? { focus: record.focus } : {}),
    ...(board.goal ? { goal: board.goal } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.error ? { error: record.error } : {}),
    agents: presentAgents(record, agents),
    ...(board.tasks.length ? { tasks: board.tasks } : {}),
    ...(record.pageCount !== undefined ? { pageCount: record.pageCount } : {}),
  };
}

function presentAgents(record: RunRecord, live: Map<string, WikiAgentView>): WikiAgentView[] {
  if (live.size > 0) {
    const lead = live.get("lead");
    const rest = [...live.values()].filter((agent) => agent.agent !== "lead");
    return lead ? [lead, ...rest] : rest;
  }
  const leadStatus = record.status === "succeeded"
    ? "complete"
    : record.status === "running" || record.status === "paused"
      ? "running"
      : "failed";
  return [
    { agent: "lead", status: leadStatus, tools: [] },
    ...record.agents.map((agent) => ({ agent: agent.agent, task: agent.task, status: agent.status, tools: [] })),
  ];
}

function emptyLive(record: RunRecord, plan: WikiPinnedSourcePlan): LiveRun {
  return {
    record,
    plan,
    controller: new AbortController(),
    done: Promise.resolve(),
    agents: new Map(),
    listeners: new Set(),
  };
}

function watchBoard(store: WikiBoardStore, live: LiveRun): WikiBoardStore {
  return {
    path: store.path,
    async read() {
      const board = await store.read();
      live.board = board;
      return board;
    },
    async write(board) {
      live.board = await store.write(board);
      live.record.updatedAt = new Date().toISOString();
      emit(live);
      return live.board;
    },
  };
}

function noteAgent(live: LiveRun, agent: string, task: string, status: WikiAgentView["status"]): void {
  const current = live.agents.get(agent) ?? { agent, tools: [] as WikiToolView[] };
  live.agents.set(agent, { ...current, agent, task, status, tools: current.tools });
  live.record.agents = [...live.agents.values()]
    .filter((entry) => entry.agent !== "lead")
    .map((entry) => ({ agent: entry.agent, task: entry.task ?? "", status: entry.status }));
  live.record.updatedAt = new Date().toISOString();
  void writeRecord(live.record);
  emit(live);
}

function observeTool(live: LiveRun, event: WikiSessionActivity): void {
  const name = event.scope ?? "lead";
  const current = live.agents.get(name) ?? { agent: name, status: "running" as const, tools: [] as WikiToolView[] };
  const tools = current.tools.slice();
  const index = tools.findIndex((tool) => tool.id === event.id);
  const row: WikiToolView = { id: event.id, tool: event.tool, args: event.args, status: event.status };
  if (index >= 0) tools[index] = row;
  else tools.push(row);
  live.agents.set(name, {
    ...current,
    agent: name,
    status: current.status === "complete" || current.status === "failed" ? current.status : "running",
    tools: capTools(tools),
    ...(event.usage ? { usage: event.usage } : {}),
  });
  live.record.updatedAt = new Date().toISOString();
  emit(live);
}

function capTools(tools: WikiToolView[]): WikiToolView[] {
  const running = tools.filter((tool) => tool.status === "running");
  if (tools.length <= Math.max(TOOL_LIMIT, running.length)) return tools;
  const keep = new Set(running.map((tool) => tool.id));
  for (const tool of tools.slice().reverse()) {
    if (keep.size >= Math.max(TOOL_LIMIT, running.length)) break;
    keep.add(tool.id);
  }
  return tools.filter((tool) => keep.has(tool.id));
}

function settleLead(live: LiveRun, status: WikiAgentView["status"]): void {
  const lead = live.agents.get("lead") ?? { agent: "lead", tools: [] as WikiToolView[] };
  live.agents.set("lead", { ...lead, agent: "lead", status, tools: lead.tools });
}

function emit(live: LiveRun): void {
  if (live.listeners.size === 0) return;
  void toView(live).then((view) => {
    for (const listener of live.listeners) listener(view);
  });
}

function runKey(cwd: string, id: string): string {
  return `${path.resolve(cwd)}:${id}`;
}

function runDir(cwd: string, id: string): string {
  return path.join(cwd, ".okf-wiki", "runs", id);
}

async function writeRecord(record: RunRecord): Promise<void> {
  await mkdir(runDir(record.cwd, record.id), { recursive: true });
  await writeText(path.join(runDir(record.cwd, record.id), "run.json"), `${JSON.stringify(record, null, 2)}\n`);
}

async function readRecord(cwd: string, id: string): Promise<RunRecord | undefined> {
  try {
    return JSON.parse(await readFile(path.join(runDir(cwd, id), "run.json"), "utf8")) as RunRecord;
  } catch {
    return undefined;
  }
}

async function listRecords(cwd: string): Promise<RunRecord[]> {
  const root = path.join(cwd, ".okf-wiki", "runs");
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const name of names) {
    const record = await readRecord(cwd, name);
    if (record) records.push(record);
  }
  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function leadPrompt(context: WikiLeadContext): Promise<string> {
  const body = await readFile(fileURLToPath(new URL("../../../prompts/lead.md", import.meta.url)), "utf8");
  const sources = context.plan.sources.map((source) => `- ${source.scopeId}: ${source.logicalPath}`).join("\n");
  const focus = context.focus ? `\nFocus: ${context.focus}\n` : "";
  const agents = "Available agents: survey (map a source), write (author wiki/ pages), review (read-only critique).\nYou have no write/edit. Pages are written only by subagent agent=write.\nCall find/ls/read/grep on the source directory names below (they may be symlinks). Do not search `.` or paths outside the workspace.\n";
  const board = formatBoard(await context.board.read());
  const catalog = context.catalog
    ? `\nCatalog: Postgres schema \`${context.catalog.config.schema}\`${
      context.catalog.config.tables.length
        ? `; table patterns: ${context.catalog.config.tables.join(", ")}`
        : "; no table filter — list first, then describe only the tables the Wiki must explain"
    }.\nUse db_tables then db_describe. Do not dump the whole schema into pages.\n`
    : "";
  const resume = context.resume
    ? "\nThis is a resumed Run. The Board is the source of truth. Do not restart completed Tasks. Read existing Candidate pages before writing.\n"
    : "";
  return `${body}\n\n# This run\n\nLanguage: ${context.language}.${focus}${resume}${agents}\nPinned sources:\n${sources}\n${catalog}\n# Board\n\n${board}\n`;
}
