import type { WikiBoard } from "./board.js";
import type { WikiAgentView, WikiRunView } from "./producer-types.js";
import type { RunRecord } from "./run-record.js";

export function toRunView(record: RunRecord, board: WikiBoard, live: WikiAgentView[]): WikiRunView {
  return {
    id: record.id,
    cwd: record.cwd,
    status: record.status,
    ...(record.focus ? { focus: record.focus } : {}),
    ...(board.goal ? { goal: board.goal } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.error ? { error: record.error } : {}),
    agents: presentAgents(record, live),
    ...(board.tasks.length ? { tasks: board.tasks } : {}),
    ...(record.pageCount !== undefined ? { pageCount: record.pageCount } : {}),
  };
}

function presentAgents(record: RunRecord, live: WikiAgentView[]): WikiAgentView[] {
  const leadStatus: WikiAgentView["status"] = record.status === "succeeded"
    ? "complete"
    : record.status === "running" || record.status === "paused"
      ? "running"
      : "failed";
  const byId = new Map(live.map((agent) => [agent.id, agent]));
  const currentLead = byId.get("lead");
  const leadUsage = currentLead?.usage ?? record.leadAttempts.at(-1)?.usage;
  const lead = {
    ...(currentLead ?? { id: "lead", agent: "lead", status: leadStatus, activity: [] }),
    status: leadStatus,
    ...(leadUsage ? { usage: leadUsage } : {}),
  };
  const executions = record.executions.map((execution) => {
    const current = byId.get(execution.id);
    return current ? {
      ...current,
      ...(current.usage ? {} : execution.usage ? { usage: execution.usage } : {}),
    } : {
      id: execution.id,
      agent: execution.agent,
      task: execution.task,
      status: execution.status === "interrupted" ? "failed" as const : execution.status,
      ...(execution.usage ? { usage: execution.usage } : {}),
      activity: [],
    };
  });
  const recorded = new Set(["lead", ...record.executions.map((execution) => execution.id)]);
  const transient = live.filter((agent) => !recorded.has(agent.id) && agent.agent !== "lead");
  return [lead, ...executions, ...transient];
}
