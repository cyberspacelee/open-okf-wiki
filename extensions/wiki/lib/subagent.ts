import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadWikiAgents, type WikiAgentDefinition } from "./agents.js";
import { reviewCandidatePages, writeHandoff } from "./handoff.js";
import { writeText } from "./files.js";
import { assertAgentPartition, writeGuardFromPlan, writeTargetsOverlap, type WikiWriteGuard } from "./path-policy.js";
import type { WikiPinnedSourcePlan } from "./inspect.js";
import { isImplicitPinPath } from "./path.js";
import { candidateTools, createCatalogTools } from "./pi/tools.js";
import { runWikiSession, type RunWikiSessionOptions } from "./pi/session.js";
import type { WikiCatalogRegistry } from "./catalog.js";
import type { WikiToolView } from "./producer-types.js";
import { formatWikiTemplateCatalog, formatWikiTemplatesForPrompt, templatesForTarget, type WikiTemplatePack } from "./templates.js";
import {
  createReviewerCompletionGate,
  createWorkerOutputGate,
  createWriterCompletionGate,
} from "./completion.js";
import { formatWriterCitationContract } from "./citations.js";
import { candidateTargetRevision, candidateRevision, fileRevision } from "./revisions.js";
import type { WikiAgentUsage } from "./producer-types.js";
import { createWriterTodoTracker, type WriterTodoItem } from "./writer-todo.js";
import type { WikiWriteMode, WikiWriteTarget } from "./write-target.js";

export interface SubagentTask {
  agent: string;
  task: string;
  boardTaskId: string;
  partition: string;
  writeMode?: WikiWriteMode;
}

export interface SubagentResult extends SubagentTask {
  id: string;
  text: string;
  handoff?: string;
  handoffRevision?: string;
  candidateRevision?: string;
  usage?: WikiAgentUsage;
  error?: string;
}

export interface SubagentRuntime {
  run(tasks: SubagentTask[], signal: AbortSignal, onUpdate?: AgentToolUpdateCallback): Promise<SubagentResult[]>;
}

export type SubagentTaskStatus = "running" | "complete" | "failed";
export interface SubagentTaskUpdate extends SubagentTask {
  id: string;
  status: SubagentTaskStatus;
  handoff?: string;
  handoffRevision?: string;
  candidateRevision?: string;
  usage?: WikiAgentUsage;
  text?: string;
  error?: string;
}
export type SubagentTaskListener = (update: SubagentTaskUpdate) => void | Promise<void>;

export async function createSubagentRuntime(
  plan: WikiPinnedSourcePlan,
  candidateRoot: string,
  session: RunWikiSessionOptions,
  agentsDirectory?: string,
  onTask?: SubagentTaskListener,
  catalogs: WikiCatalogRegistry = new Map(),
  options: {
    maxConcurrency?: number;
    maxWorkerRepairRounds?: number;
    templates?: WikiTemplatePack;
    language?: "zh" | "en";
    assertDispatch?: (tasks: readonly SubagentTask[]) => void;
    handoffsForTask?: (task: SubagentTask) => readonly string[];
  } = {},
): Promise<SubagentRuntime> {
  const agents = await loadWikiAgents(agentsDirectory);
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const guard = writeGuardFromPlan(plan, candidateRoot);
  await mkdir(guard.candidateRoot, { recursive: true });
  let activeSharedBatches = 0;
  let exclusiveBatch = false;
  return {
    async run(tasks, signal, onUpdate) {
      if (!tasks.length) throw new Error("subagent requires at least one task");
      assertSafeBatch(tasks);
      for (const task of tasks) assertAgentPartition(task.agent, task.partition, plan, task.writeMode);
      options.assertDispatch?.(tasks);
      const release = acquireBatch(tasks);
      try {
        const maxConcurrency = options.maxConcurrency ?? tasks.length;
        if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
          throw new Error("subagent maxConcurrency must be a positive integer");
        }
        const jobs = tasks.map((task) => ({ ...task, id: executionId(task.agent) }));
        const live = new Map(jobs.map((task) => [task.id, { ...task, status: "running" as SubagentTaskStatus, tools: [] as WikiToolView[] }]));
        const report = async () => {
          const snapshot = [...live.values()].map((task) => ({ ...task, tools: task.tools.map((tool) => ({ ...tool })) }));
          await onUpdate?.({
            content: [{ type: "text", text: snapshot.map((task) => `${task.status} ${task.agent}`).join("\n") }],
            details: { tasks: snapshot },
          });
        };
        let reportQueue = Promise.resolve();
        let reportQueued = false;
        let reportError: unknown;
        const scheduleReport = () => {
          if (reportQueued) return;
          reportQueued = true;
          const scheduled = reportQueue.then(async () => {
            reportQueued = false;
            await report();
          });
          reportQueue = scheduled.catch((error) => { reportError ??= error; });
        };
        const flushReport = async () => {
          scheduleReport();
          await reportQueue;
          if (reportError) throw reportError;
        };
        for (const task of jobs) await onTask?.({ ...task, status: "running" });
        await report();
        return await mapWithConcurrency(jobs, maxConcurrency, async (task) => {
          const result = await runOne(task, byName, guard, plan.fingerprint, {
            ...session,
            onActivity(event) {
              const scoped = { ...event, scope: task.id };
              session.onActivity?.(scoped);
              if (scoped.kind === "tool") applyChildTool(live.get(task.id)!.tools, scoped);
              scheduleReport();
            },
          }, signal, catalogsForTask(task, plan, catalogs), options.templates, options.maxWorkerRepairRounds, options.language,
          options.handoffsForTask?.(task) ?? []);
          const status = result.error ? "failed" : "complete";
          const entry = live.get(result.id)!;
          entry.status = status;
          await onTask?.({ ...result, status });
          await flushReport();
          return result;
        });
      } finally {
        release();
      }
    },
  };

  function acquireBatch(tasks: readonly SubagentTask[]): () => void {
    const shared = tasks.every((task) => task.agent === "survey");
    if (shared) {
      if (exclusiveBatch) throw new Error("survey cannot start while synthesize, write, or review is running");
      activeSharedBatches += 1;
      return () => { activeSharedBatches -= 1; };
    }
    if (exclusiveBatch || activeSharedBatches > 0) {
      throw new Error("synthesize, write, and review require exclusive subagent execution");
    }
    exclusiveBatch = true;
    return () => { exclusiveBatch = false; };
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await run(values[index]!);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results;
}

export function createSubagentTool(runtime: SubagentRuntime): ToolDefinition<any, any, any> {
  return {
    name: "subagent",
    label: "Subagent",
    description:
      "Run a named Wiki agent in an isolated session. Agents: survey (map one Source), synthesize (analyze completed surveys across Sources), write (author one Domain subtree or one aggregation directory), review (read-only critique). Survey and disjoint Domain writes may batch. Synthesize and review run alone. Each result is a handoff path, not the full body.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "survey, synthesize, write, or review" })),
      task: Type.Optional(Type.String({ description: "Assignment for a single agent" })),
      boardTaskId: Type.Optional(Type.String({ description: "Existing in-progress Board Task id" })),
      partition: Type.Optional(Type.String({ description: "Source id, workspace-analysis, write path, or candidate" })),
      writeMode: Type.Optional(Type.Union([Type.Literal("subtree"), Type.Literal("directory")], { description: "Required for write: subtree for one Domain, directory for repository or Wiki-root pages" })),
      tasks: Type.Optional(Type.Array(Type.Object({
        agent: Type.String({ description: "survey, synthesize, write, or review" }),
        task: Type.String(),
        boardTaskId: Type.String(),
        partition: Type.String(),
        writeMode: Type.Optional(Type.Union([Type.Literal("subtree"), Type.Literal("directory")])),
      }))),
    }),
    async execute(_id, params, signal, onUpdate) {
      const input = params as { agent?: string; task?: string; boardTaskId?: string; partition?: string; writeMode?: WikiWriteMode; tasks?: SubagentTask[] };
      const tasks = input.tasks?.length
        ? input.tasks
        : input.agent && input.task && input.boardTaskId && input.partition
          ? [{ agent: input.agent, task: input.task, boardTaskId: input.boardTaskId, partition: input.partition, ...(input.writeMode ? { writeMode: input.writeMode } : {}) }]
          : [];
      if (!tasks.length) {
        return { content: [{ type: "text", text: "Provide agent+task or tasks[]" }], isError: true };
      }
      const results = await runtime.run(tasks, signal ?? new AbortController().signal, onUpdate);
      return {
        content: [{ type: "text", text: results.map(formatResult).join("\n\n") }],
        details: { results },
      };
    },
  } as ToolDefinition<any, any, any>;
}

async function runOne(
  task: SubagentTask & { id: string },
  byName: Map<string, WikiAgentDefinition>,
  guard: WikiWriteGuard,
  sourceFingerprint: string,
  session: RunWikiSessionOptions,
  signal: AbortSignal,
  catalogs: WikiCatalogRegistry,
  templates?: WikiTemplatePack,
  maxWorkerRepairRounds?: number,
  language?: "zh" | "en",
  requiredHandoffs: readonly string[] = [],
): Promise<SubagentResult> {
  const definition = byName.get(task.agent);
  if (!definition) {
    const available = [...byName.keys()].join(", ") || "(none)";
    return { ...task, text: "", error: `Unknown agent "${task.agent}". Available: ${available}` };
  }
  try {
    const writeTarget = task.agent === "write" ? targetFromTask(task) : undefined;
    const outputRevision = async () => writeTarget
      ? await candidateTargetRevision(guard.candidateRoot, writeTarget)
      : await candidateRevision(guard.candidateRoot);
    const base = task.agent === "survey"
      ? { digest: "not-applicable" }
      : await outputRevision();
    const candidatePages = task.agent === "review" && "files" in base ? reviewCandidatePages(base.files) : [];
    const handoffManifest = await writeRequiredHandoffManifest(guard, task.id, requiredHandoffs);
    const requiredReads = [...requiredHandoffs, ...(handoffManifest ? [handoffManifest] : [])];
    const touched = new Set<string>();
    const extra = createCatalogTools(catalogs);
    const allowed = definition.tools ? new Set(definition.tools) : undefined;
    const taskGuard = writeTarget ? { ...guard, writeTarget } : guard;
    const todo = writeTarget && templates ? createWriterTodoTracker(writeTarget) : undefined;
    const completionGate = writeTarget
      ? createWriterCompletionGate(taskGuard, {
        maxRepairRounds: maxWorkerRepairRounds,
        onTouched: (location) => touched.add(location),
        todo,
        templates,
        catalogs: [...catalogs.keys()],
        requiredReads,
      })
      : task.agent === "review"
        ? createReviewerCompletionGate(candidatePages, maxWorkerRepairRounds, requiredReads)
        : task.agent === "survey" || task.agent === "synthesize"
          ? createWorkerOutputGate(task.agent, maxWorkerRepairRounds, requiredReads)
          : undefined;
    const tools = [
      ...candidateTools(taskGuard, definition.tools),
      ...(todo ? [todo.tool] : []),
      ...extra.filter((tool) => !allowed || allowed.has(tool.name)),
    ];
    const logical = guard.sources.map((source) => source.logicalPath);
    const implicit = logical.length === 1 && isImplicitPinPath(logical[0] ?? "");
    const scoped = templates && writeTarget
      ? templatesForTarget(templates, writeTarget, implicit)
      : templates?.templates ?? [];
    const pack = templates && task.agent !== "synthesize"
      ? `\n\n${task.agent === "write"
        ? formatWikiTemplatesForPrompt(templates, new Set(scoped.map((template) => template.id)), { target: writeTarget, implicit })
        : formatWikiTemplateCatalog(templates)}`
      : "";
    const citations = task.agent === "write"
      ? `\n\n${formatWriterCitationContract(guard.sources, [...catalogs.keys()])}`
      : "";
    const languageContract = task.agent === "write" && language
      ? `\n\n## Output language\n\nThe Run language is \`${language}\` (\`zh\` = Simplified Chinese; \`en\` = English). Write titles, descriptions, prose, table labels, footnote definitions, and human-readable Mermaid labels in that language. Preserve source identifiers, code symbols, paths, commands, configuration keys, frontmatter \`type\`, \`sources[].id\`, and Mermaid node IDs verbatim. Copy the injected contract headings exactly.\n`
      : "";
    const handoffs = handoffManifest
      ? `# Required handoffs\n\nRead the manifest at \`${handoffManifest}\`, then read every handoff path it lists before completing this task.\n\n`
      : "";
    const reviewPages = candidatePages.length
      ? `# Frozen Candidate pages\n\nCover each path exactly once in the review receipt:\n${candidatePages.map((page) => `- ${page}`).join("\n")}\n\n`
      : "";
    const result = await runWikiSession(
      guard.workspaceRoot,
      tools,
      `${handoffs}${reviewPages}# Task\n\n${task.task}`,
      signal,
      {
        ...session,
        systemPrompt: `${definition.prompt}${pack}${citations}${languageContract}`,
        onActivity(event) {
          session.onActivity?.(event);
          if (event.kind === "tool") completionGate?.observe(event);
        },
        onCompaction: () => formatWorkerCheckpoint(
          task,
          sourceFingerprint,
          base.digest,
          touched,
          handoffManifest ? [handoffManifest] : [],
          todo?.snapshot(),
        ),
        nextPrompt: completionGate?.nextPrompt,
      },
    );
    const completed = task.agent === "survey" ? undefined : await outputRevision();
    const handoff = await writeHandoff({
      workspaceRoot: guard.workspaceRoot,
      handoffsRoot: guard.handoffsRoot,
      task,
      text: result.text,
      baseCandidateRevision: base.digest,
      completedCandidateRevision: completed?.digest,
    });
    return {
      ...task,
      text: result.text,
      handoff,
      handoffRevision: await fileRevision(path.join(guard.workspaceRoot, ...handoff.split("/"))),
      ...(completed ? { candidateRevision: completed.digest } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  } catch (error) {
    return { ...task, text: "", error: error instanceof Error ? error.message : String(error) };
  }
}

async function writeRequiredHandoffManifest(
  guard: WikiWriteGuard,
  executionId: string,
  handoffs: readonly string[],
): Promise<string | undefined> {
  if (!handoffs.length) return undefined;
  const location = path.join(guard.handoffsRoot, `${executionId}.inputs`);
  await writeText(location, `${[...new Set(handoffs)].sort().join("\n")}\n`);
  return path.relative(guard.workspaceRoot, location).replaceAll("\\", "/");
}

function catalogsForTask(
  task: SubagentTask,
  plan: WikiPinnedSourcePlan,
  catalogs: WikiCatalogRegistry,
): WikiCatalogRegistry {
  if (task.agent === "synthesize" || task.agent === "review" || task.partition === "wiki-root") return catalogs;
  const implicit = plan.sources.length === 1 && isImplicitPinPath(plan.sources[0]?.logicalPath ?? "");
  const owner = task.agent === "survey"
    ? plan.sources.find((source) => source.scopeId === task.partition)
    : implicit
      ? plan.sources[0]
      : plan.sources.find((source) => task.partition === source.scopeId || task.partition.startsWith(`${source.scopeId}/`));
  if (!owner?.catalog) return new Map();
  const catalog = catalogs.get(owner.catalog);
  if (!catalog) throw new Error(`Pinned Source ${owner.scopeId} references unavailable Catalog ${owner.catalog}`);
  return new Map([[owner.catalog, catalog]]);
}

function formatResult(result: SubagentResult): string {
  if (result.error) return `## ${result.agent} failed\n${result.error}`;
  if (result.handoff) {
    return [
      `## ${result.agent}`,
      `Handoff: ${result.handoff}`,
      `Task: ${result.task}`,
      "Read that file for the full result. Do not treat this message as the evidence.",
    ].join("\n");
  }
  return `## ${result.agent}\n${result.text}`.trim();
}

function executionId(agent: string): string {
  return `${agent}-${randomUUID().slice(0, 8)}`;
}

function assertSafeBatch(tasks: readonly SubagentTask[]): void {
  if (tasks.length > 16) throw new Error("subagent batch exceeds the 16-partition recovery limit");
  if (tasks.some((task) => typeof task.boardTaskId !== "string" || !task.boardTaskId.trim()
    || typeof task.partition !== "string" || !task.partition.trim())) {
    throw new Error("subagent tasks require boardTaskId and partition");
  }
  if (tasks.some((task) => estimateTokens(task.task) > 3_000)) {
    throw new Error("subagent assignment exceeds the 3000-token recovery budget; pass artifact paths instead of pasted content");
  }
  const roles = new Set(tasks.map((task) => task.agent));
  const partitions = new Set<string>();
  for (const task of tasks) {
    if (task.agent === "write" && task.writeMode !== "subtree" && task.writeMode !== "directory") {
      throw new Error("write assignment requires writeMode subtree or directory");
    }
    if (task.agent !== "write" && task.writeMode !== undefined) {
      throw new Error(`${task.agent} assignment cannot set writeMode`);
    }
    const key = `${task.boardTaskId}\0${task.writeMode ?? "partition"}\0${task.partition}`;
    if (partitions.has(key)) throw new Error(`duplicate subagent partition: ${task.boardTaskId}/${task.partition}`);
    partitions.add(key);
  }
  if ((roles.has("review") || roles.has("synthesize")) && tasks.length > 1) {
    throw new Error(`${roles.has("review") ? "review" : "synthesize"} must run alone`);
  }
  if (roles.has("write") && tasks.length > 1) {
    const targets = tasks.map(targetFromTask);
    for (let index = 0; index < targets.length; index += 1) {
      for (let other = index + 1; other < targets.length; other += 1) {
        if (writeTargetsOverlap(targets[index]!, targets[other]!)) {
          throw new Error(`overlapping write targets: ${targets[index]!.mode}:${targets[index]!.path} ${targets[other]!.mode}:${targets[other]!.path}`);
        }
      }
    }
  }
  if (roles.size > 1) throw new Error("subagent batches must contain one agent role");
}

function formatWorkerCheckpoint(
  task: SubagentTask & { id: string },
  sourceFingerprint: string,
  baseCandidateRevision: string,
  touched: ReadonlySet<string>,
  requiredHandoffs: readonly string[] = [],
  todo: readonly WriterTodoItem[] = [],
): string {
  const instruction = task.agent === "survey"
    ? "Continue this exact Source survey. Reopen load-bearing Source locators before finalizing the handoff."
    : task.agent === "synthesize"
      ? "Continue this exact cross-Source analysis. Read every survey handoff and reopen both sides of each claimed relationship before finalizing the handoff."
    : task.agent === "review"
      ? "Continue read-only review of the frozen Candidate revision. Reopen load-bearing Source locators before the verdict."
      : "Continue this exact write assignment. Reopen each cited pin file before writing. Inspect current Candidate files and referenced handoffs before changing them.";
  const lines = [
    "<wiki_checkpoint>",
    `Execution: ${task.id}`,
    `Role: ${task.agent}`,
    `Board Task: ${task.boardTaskId}`,
    `Partition: ${task.partition}`,
    ...(task.writeMode ? [`Write mode: ${task.writeMode}`] : []),
    `Source fingerprint: ${sourceFingerprint}`,
    `Base target Candidate: ${baseCandidateRevision}`,
    `Assignment: ${task.task}`,
    ...(requiredHandoffs.length ? ["Required handoffs:", ...requiredHandoffs.map((location) => `- ${location}`)] : []),
  ];
  if (estimateTokens([...lines, instruction, "</wiki_checkpoint>"].join("\n")) > 4_096) {
    throw new Error("context_checkpoint_too_large: worker assignment exceeds 4096 estimated tokens");
  }
  const changed = [...touched].sort();
  if (changed.length) {
    lines.push("Touched Candidate paths:");
    let included = 0;
    for (const location of changed) {
      const next = `- ${location}`;
      if (estimateTokens([...lines, next, instruction, "</wiki_checkpoint>"].join("\n")) > 4_096) break;
      lines.push(next);
      included += 1;
    }
    if (included < changed.length) lines.push(`- ${changed.length - included} older paths omitted from this bounded frame`);
  }
  if (task.agent === "write") {
    lines.push("Writer Todo:");
    if (!todo.length) lines.push("- not planned");
    else {
      for (const item of todo) {
        const next = `- ${item.status}: ${item.path}`;
        if (estimateTokens([...lines, next, instruction, "</wiki_checkpoint>"].join("\n")) > 4_096) break;
        lines.push(next);
      }
    }
  }
  lines.push(instruction, "</wiki_checkpoint>");
  return lines.join("\n");
}

function targetFromTask(task: SubagentTask): WikiWriteTarget {
  if (task.writeMode !== "subtree" && task.writeMode !== "directory") {
    throw new Error("write assignment requires writeMode subtree or directory");
  }
  return { path: task.partition, mode: task.writeMode };
}

function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.charCodeAt(0) < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

function applyChildTool(tools: WikiToolView[], event: { id: string; tool: string; args: unknown; status: WikiToolView["status"] }): void {
  const index = tools.findIndex((tool) => tool.id === event.id);
  const row = { id: event.id, tool: event.tool, args: event.args, status: event.status };
  if (index >= 0) tools[index] = row;
  else tools.push(row);
}
