import path from "node:path";
import { appendText, readText } from "./files.js";
import type {
  WikiActivityView,
  WikiAgentStatus,
  WikiAgentUsage,
  WikiAgentView,
  WikiSessionActivity,
} from "./producer-types.js";

type ActivityRecord = {
  version: 1;
  type: "activity";
  agentId: string;
  activity: WikiActivityView;
};

type AgentRecord = {
  version: 1;
  type: "agent";
  id: string;
  agent: string;
  task?: string;
  status: WikiAgentStatus;
};

type LogRecord = ActivityRecord | AgentRecord;

export class RunActivity {
  readonly #file: string;
  readonly #agents = new Map<string, WikiAgentView>();
  #pending = Promise.resolve();
  #writeError: unknown;

  constructor(runRoot: string) {
    this.#file = path.join(runRoot, "activity.jsonl");
  }

  static async open(runRoot: string): Promise<RunActivity> {
    const timeline = new RunActivity(runRoot);
    let raw: string;
    try {
      raw = await readText(timeline.#file);
    } catch (error) {
      if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return timeline;
      throw error;
    }
    const complete = raw.endsWith("\n") ? raw : raw.slice(0, Math.max(0, raw.lastIndexOf("\n") + 1));
    for (const line of complete.split("\n")) {
      if (!line) continue;
      timeline.#apply(parseRecord(line));
    }
    return timeline;
  }

  noteAgent(id: string, agent: string, task: string | undefined, status: WikiAgentStatus): void {
    const current = this.#agents.get(id);
    const next: WikiAgentView = {
      id,
      agent,
      status,
      activity: current?.activity ?? [],
      ...(task !== undefined ? { task } : current?.task !== undefined ? { task: current.task } : {}),
      ...(current?.usage ? { usage: current.usage } : {}),
    };
    this.#agents.set(id, next);
    this.#enqueue({ version: 1, type: "agent", id, agent, status, ...(task !== undefined ? { task } : {}) });
  }

  observe(event: WikiSessionActivity): void {
    const agentId = event.scope ?? "lead";
    const current = this.#agents.get(agentId) ?? {
      id: agentId,
      agent: agentId === "lead" ? "lead" : agentId,
      status: "running" as const,
      activity: [],
    };
    const { scope: _scope, usage, ...observed } = event;
    const index = current.activity.findIndex((entry) => activityKey(entry) === activityKey(observed));
    const previous = index >= 0 ? current.activity[index] : undefined;
    const activity: WikiActivityView = previous ? { ...observed, at: previous.at } : observed;
    const entries = current.activity.slice();
    if (index >= 0) entries[index] = activity;
    else entries.push(activity);
    this.#agents.set(agentId, {
      ...current,
      activity: entries,
      ...(usage ? { usage } : {}),
    });

    const final = activity.kind === "input" || activity.status !== "running";
    if (!previous || final) {
      this.#enqueue({ version: 1, type: "activity", agentId, activity });
    }
  }

  agents(): WikiAgentView[] {
    const values = [...this.#agents.values()];
    const lead = values.find((agent) => agent.id === "lead");
    const rest = values.filter((agent) => agent.id !== "lead");
    return (lead ? [lead, ...rest] : rest).map((agent) => ({
      ...agent,
      activity: agent.activity.map((entry) => ({ ...entry })),
    }));
  }

  async flush(): Promise<void> {
    await this.#pending;
    if (this.#writeError) throw this.#writeError;
  }

  #enqueue(record: LogRecord): void {
    this.#pending = this.#pending
      .then(() => appendText(this.#file, `${JSON.stringify(record)}\n`))
      .catch((error) => { this.#writeError ??= error; });
  }

  #apply(record: LogRecord): void {
    if (record.type === "agent") {
      const current = this.#agents.get(record.id);
      this.#agents.set(record.id, {
        id: record.id,
        agent: record.agent,
        status: record.status,
        activity: current?.activity ?? [],
        ...(record.task !== undefined ? { task: record.task } : current?.task !== undefined ? { task: current.task } : {}),
        ...(current?.usage ? { usage: current.usage } : {}),
      });
      return;
    }
    const current = this.#agents.get(record.agentId) ?? {
      id: record.agentId,
      agent: record.agentId === "lead" ? "lead" : record.agentId,
      status: "running" as const,
      activity: [],
    };
    const index = current.activity.findIndex((entry) => activityKey(entry) === activityKey(record.activity));
    const activity = current.activity.slice();
    if (index >= 0) activity[index] = record.activity;
    else activity.push(record.activity);
    this.#agents.set(record.agentId, { ...current, activity });
  }
}

function activityKey(activity: WikiActivityView): string {
  return `${activity.kind}:${activity.id}`;
}

function parseRecord(line: string): LogRecord {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run activity record must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("Run activity record version is invalid");
  if (raw.type === "agent") {
    if (typeof raw.id !== "string" || typeof raw.agent !== "string" || !isAgentStatus(raw.status)) {
      throw new Error("Run activity agent record is invalid");
    }
    if (raw.task !== undefined && typeof raw.task !== "string") throw new Error("Run activity agent task is invalid");
    return raw as AgentRecord;
  }
  if (raw.type === "activity" && typeof raw.agentId === "string" && isActivity(raw.activity)) {
    return raw as ActivityRecord;
  }
  throw new Error("Run activity record is invalid");
}

function isActivity(value: unknown): value is WikiActivityView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !isTimestamp(raw.at)) return false;
  if (raw.kind === "input") return typeof raw.text === "string";
  if (raw.kind === "output") return typeof raw.text === "string" && isAgentStatus(raw.status);
  return raw.kind === "tool"
    && typeof raw.tool === "string"
    && isAgentStatus(raw.status)
    && (raw.result === undefined || typeof raw.result === "string");
}

function isAgentStatus(value: unknown): value is WikiAgentStatus {
  return value === "running" || value === "complete" || value === "failed";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
