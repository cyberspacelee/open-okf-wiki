import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { inspectWiki, verifyPinnedSourcePlan, type WikiPinnedSourcePlan } from "./inspect.js";
import { exists, renamePath, writeText } from "./files.js";
import { errorMessage } from "./failures.js";
import { loadWikiWorkspace } from "./workspace.js";
import {
  formatIssue,
  materializeWikiIndexes,
  stampPublication,
  validateWikiTree,
} from "./wiki-okf.js";
import { writeGuardFromPlan } from "./path-policy.js";
import { candidateTools } from "./pi/tools.js";
import { runWikiSession, type RunWikiSessionOptions } from "./pi/session.js";
import { createSubagentRuntime, createSubagentTool } from "./subagent.js";
import type {
  WikiProducer,
  WikiProducerRequest,
  WikiProducerResult,
  WikiRunControl,
  WikiRunHandle,
  WikiRunStatus,
  WikiRunView,
} from "./producer-types.js";
import { WikiRunResultError } from "./producer-types.js";

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
  signal: AbortSignal;
  publish(): Promise<{ ok: boolean; message: string }>;
  note(agent: string, task: string, status: "running" | "complete" | "failed"): void;
}

interface RunRecord {
  id: string;
  cwd: string;
  status: WikiRunStatus;
  focus?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  agents: Array<{ agent: string; task: string; status: "running" | "complete" | "failed" }>;
  pageCount?: number;
  candidateRoot: string;
  fingerprint: string;
}

const active = new Map<string, LiveRun>();

interface LiveRun {
  record: RunRecord;
  plan: WikiPinnedSourcePlan;
  controller: AbortController;
  done: Promise<void>;
  result?: WikiProducerResult;
}

export function createProductionWikiProducer(options: WikiProducerOptions = {}): WikiProducer {
  return {
    async start(request) {
      const workspace = await loadWikiWorkspace(request.cwd);
      const running = (await listRecords(workspace.root)).find((run) => run.status === "running");
      if (running) throw new Error(`Wiki run ${running.id} is already running`);
      const plan = await inspectWiki(workspace.root);
      const id = randomUUID().slice(0, 8);
      const candidateRoot = path.join(workspace.root, ".okf-wiki", "runs", id, "candidate");
      await mkdir(candidateRoot, { recursive: true });
      const now = new Date().toISOString();
      const record: RunRecord = {
        id,
        cwd: workspace.root,
        status: "running",
        ...(request.focus ? { focus: request.focus } : {}),
        createdAt: now,
        updatedAt: now,
        agents: [],
        candidateRoot,
        fingerprint: plan.fingerprint,
      };
      await writeRecord(record);
      const live = startLive(record, plan, workspace.language, options, request.focus);
      active.set(runKey(workspace.root, id), live);
      return handleFor(live);
    },
    async list(cwd) {
      const workspace = await loadWikiWorkspace(cwd);
      return (await listRecords(workspace.root)).map(toView);
    },
    async open(runId, cwd) {
      const workspace = await loadWikiWorkspace(cwd);
      const live = active.get(runKey(workspace.root, runId));
      if (live) return handleFor(live);
      const record = await readRecord(workspace.root, runId);
      if (!record) return undefined;
      return handleFor({
        record,
        plan: await inspectWiki(workspace.root).catch(() => ({
          workspaceRoot: workspace.root,
          workspaceRealPath: workspace.root,
          configPath: workspace.configPath,
          defaultSourceIgnores: workspace.defaultSourceIgnores,
          excludes: workspace.wiki.exclude,
          sources: [],
          fingerprint: record.fingerprint,
        })),
        controller: new AbortController(),
        done: Promise.resolve(),
      });
    },
  };
}

function startLive(
  record: RunRecord,
  plan: WikiPinnedSourcePlan,
  language: "zh" | "en",
  options: WikiProducerOptions,
  focus?: string,
): LiveRun {
  const controller = new AbortController();
  const live: LiveRun = {
    record,
    plan,
    controller,
    done: Promise.resolve(),
  };
  live.done = (async () => {
    try {
      const context: WikiLeadContext = {
        plan,
        candidateRoot: record.candidateRoot,
        focus,
        language,
        signal: controller.signal,
        async publish() {
          return await publishCandidate(live, language);
        },
        note(agent, task, status) {
          live.record.agents = [
            ...live.record.agents.filter((entry) => !(entry.agent === agent && entry.task === task && entry.status === "running")),
            { agent, task, status },
          ];
          live.record.updatedAt = new Date().toISOString();
          void writeRecord(live.record);
        },
      };
      const runLead = options.runLead ?? defaultRunLead(options);
      await runLead(context);
      if (live.record.status === "running") {
        const published = await publishCandidate(live, language);
        if (!published.ok) throw new Error(published.message);
      }
    } catch (error) {
      if (live.record.status === "paused" || live.record.status === "cancelled") return;
      live.record.status = "failed";
      live.record.error = errorMessage(error);
      live.record.updatedAt = new Date().toISOString();
      await writeRecord(live.record);
    }
  })();
  return live;
}

function defaultRunLead(options: WikiProducerOptions): (context: WikiLeadContext) => Promise<void> {
  return async (context) => {
    const runtime = await createSubagentRuntime(
      context.plan,
      context.candidateRoot,
      options.session ?? {},
      options.agentsDirectory,
      (agent, task, status) => context.note(agent, task, status),
    );
    const tools: ToolDefinition<any, any, any>[] = [
      ...candidateTools(writeGuardFromPlan(context.plan, context.candidateRoot)),
      createSubagentTool(runtime),
      createPublishTool(() => context.publish()),
    ];
    const prompt = await leadPrompt(context);
    await runWikiSession(context.plan.workspaceRoot, tools, prompt, context.signal, options.session);
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
  await writeRecord(live.record);
  const result = { id: live.record.id, wikiRoot, pages: validation.pages };
  live.result = result;
  return { ok: true, message: `Published ${validation.pages.length} pages to wiki/` };
}

function handleFor(live: LiveRun): WikiRunHandle {
  return {
    id: live.record.id,
    async view() {
      return toView(live.record);
    },
    async control(action: WikiRunControl) {
      if (action === "pause") {
        live.record.status = "paused";
        live.controller.abort();
      } else if (action === "cancel") {
        live.record.status = "cancelled";
        live.controller.abort();
      } else if (action === "resume") {
        throw new Error("Resume does not restore Pi sessions; run /wiki again");
      }
      live.record.updatedAt = new Date().toISOString();
      await writeRecord(live.record);
      return toView(live.record);
    },
    async result() {
      await live.done;
      if (live.result) return live.result;
      throw new WikiRunResultError(live.record.error ?? `Wiki run ${live.record.id} ${live.record.status}`, toView(live.record));
    },
  };
}

function toView(record: RunRecord): WikiRunView {
  return {
    id: record.id,
    cwd: record.cwd,
    status: record.status,
    ...(record.focus ? { focus: record.focus } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.error ? { error: record.error } : {}),
    agents: record.agents,
    ...(record.pageCount !== undefined ? { pageCount: record.pageCount } : {}),
  };
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
  const promptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prompts/lead.md");
  let body = "";
  try {
    body = await readFile(promptPath, "utf8");
  } catch {
    body = "Generate a repository Wiki from the pinned sources. Call publish when done.";
  }
  const sources = context.plan.sources.map((source) => `- ${source.scopeId}: ${source.logicalPath}`).join("\n");
  const focus = context.focus ? `\nFocus: ${context.focus}\n` : "";
  return `${body}\n\n# This run\n\nLanguage: ${context.language}.${focus}\nPinned sources:\n${sources}\n`;
}
