import { Type } from "typebox";
import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadWikiAgents, type WikiAgentDefinition } from "./agents.js";
import { writeGuardFromPlan, type WikiWriteGuard } from "./path-policy.js";
import type { WikiPinnedSourcePlan } from "./inspect.js";
import { candidateTools, createCatalogTools } from "./pi/tools.js";
import { runWikiSession, type RunWikiSessionOptions } from "./pi/session.js";
import type { WikiCatalog } from "./catalog.js";
import type { WikiToolView } from "./producer-types.js";

export interface SubagentTask {
  agent: string;
  task: string;
}

export interface SubagentResult {
  agent: string;
  task: string;
  text: string;
  error?: string;
}

export interface SubagentRuntime {
  run(tasks: SubagentTask[], signal: AbortSignal, onUpdate?: AgentToolUpdateCallback): Promise<SubagentResult[]>;
}

export type SubagentTaskStatus = "running" | "complete" | "failed";

export async function createSubagentRuntime(
  plan: WikiPinnedSourcePlan,
  candidateRoot: string,
  session: RunWikiSessionOptions,
  agentsDirectory?: string,
  onTask?: (agent: string, task: string, status: SubagentTaskStatus) => void,
  catalog?: WikiCatalog,
): Promise<SubagentRuntime> {
  const agents = await loadWikiAgents(agentsDirectory);
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const guard = writeGuardFromPlan(plan, candidateRoot);
  return {
    async run(tasks, signal, onUpdate) {
      if (!tasks.length) throw new Error("subagent requires at least one task");
      const live = new Map(tasks.map((task) => [taskKey(task), { ...task, status: "running" as SubagentTaskStatus, tools: [] as WikiToolView[] }]));
      const report = async () => {
        const snapshot = [...live.values()];
        await onUpdate?.({
          content: [{ type: "text", text: snapshot.map((task) => `${task.status} ${task.agent}`).join("\n") }],
          details: { tasks: snapshot },
        });
      };
      for (const task of tasks) onTask?.(task.agent, task.task, "running");
      await report();
      const results = await Promise.all(tasks.map((task) => runOne(task, byName, guard, {
        ...session,
        onActivity(event) {
          const scoped = { ...event, scope: task.agent };
          session.onActivity?.(scoped);
          applyChildTool(live.get(taskKey(task))!.tools, scoped);
          void report();
        },
      }, signal, catalog)));
      for (const result of results) {
        const entry = live.get(taskKey(result))!;
        entry.status = result.error ? "failed" : "complete";
        onTask?.(result.agent, result.task, entry.status);
      }
      await report();
      return results;
    },
  };
}

export function createSubagentTool(runtime: SubagentRuntime): ToolDefinition<any, any, any> {
  return {
    name: "subagent",
    label: "Subagent",
    description:
      "Run a named Wiki agent in an isolated session. Agents: survey (map a source), write (author wiki/ pages), review (read-only critique). Use tasks[] for parallel work.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "survey, write, or review" })),
      task: Type.Optional(Type.String({ description: "Assignment for a single agent" })),
      tasks: Type.Optional(Type.Array(Type.Object({
        agent: Type.String({ description: "survey, write, or review" }),
        task: Type.String(),
      }))),
    }),
    async execute(_id, params, signal, onUpdate) {
      const input = params as { agent?: string; task?: string; tasks?: SubagentTask[] };
      const tasks = input.tasks?.length
        ? input.tasks
        : input.agent && input.task
          ? [{ agent: input.agent, task: input.task }]
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
  task: SubagentTask,
  byName: Map<string, WikiAgentDefinition>,
  guard: WikiWriteGuard,
  session: RunWikiSessionOptions,
  signal: AbortSignal,
  catalog?: WikiCatalog,
): Promise<SubagentResult> {
  const definition = byName.get(task.agent);
  if (!definition) {
    const available = [...byName.keys()].join(", ") || "(none)";
    return { ...task, text: "", error: `Unknown agent "${task.agent}". Available: ${available}` };
  }
  try {
    const extra = catalog ? createCatalogTools(catalog) : [];
    const allowed = definition.tools ? new Set(definition.tools) : undefined;
    const tools = [
      ...candidateTools(guard, definition.tools),
      ...extra.filter((tool) => !allowed || allowed.has(tool.name)),
    ];
    const text = await runWikiSession(
      guard.workspaceRoot,
      tools,
      `${definition.prompt}\n\n# Task\n\n${task.task}`,
      signal,
      session,
    );
    return { ...task, text };
  } catch (error) {
    return { ...task, text: "", error: error instanceof Error ? error.message : String(error) };
  }
}

function formatResult(result: SubagentResult): string {
  if (result.error) return `## ${result.agent} failed\n${result.error}`;
  return `## ${result.agent}\n${result.text}`.trim();
}

function taskKey(task: { agent: string; task: string }): string {
  return `${task.agent}\0${task.task}`;
}

function applyChildTool(tools: WikiToolView[], event: { id: string; tool: string; args: unknown; status: WikiToolView["status"] }): void {
  const index = tools.findIndex((tool) => tool.id === event.id);
  const row = { id: event.id, tool: event.tool, args: event.args, status: event.status };
  if (index >= 0) tools[index] = row;
  else tools.push(row);
}
