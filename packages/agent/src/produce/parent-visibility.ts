/**
 * Reduce child Pi AgentSession events → parent-visible WorkUnit snapshots (ADR 0031).
 *
 * Snapshot-first: when a Pi event carries `message`, extract thinking/text from
 * content blocks. Never invent assistant prose. Tools are keyed by toolCallId.
 * Host calls settle()/fail() for terminal unit status.
 */

import type { ProduceAgentRole } from "./events.js";

export type ParentUnitStatus = "pending" | "running" | "settled" | "failed";

export type ParentUnitToolState = {
  toolCallId: string;
  toolName: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type ParentUnitMessage = {
  thinking?: string;
  text?: string;
};

/** Parent-visible produce unit snapshot (maps onto product `work_unit`). */
export type ParentUnitUpdate = {
  unitId: string;
  role: ProduceAgentRole;
  status: ParentUnitStatus;
  runId?: string;
  task?: string;
  parentId?: string;
  message?: ParentUnitMessage;
  tools?: ParentUnitToolState[];
  summary?: string;
  receiptPath?: string;
  error?: string;
  updatedAt: number;
};

export type CreateParentVisibilityReducerOpts = {
  unitId: string;
  role: ProduceAgentRole;
  task?: string;
  parentId?: string;
  runId?: string;
};

export type ParentVisibilityReducer = {
  /** Fold one child Pi event; returns the latest unit snapshot. */
  onPiEvent(kind: string, payload: unknown): ParentUnitUpdate;
  getUnit(): ParentUnitUpdate;
  /** Mark unit running (host open before/while child runs). */
  open(extra?: { task?: string; parentId?: string }): ParentUnitUpdate;
  settle(summary?: string, extra?: { receiptPath?: string }): ParentUnitUpdate;
  fail(error?: string): ParentUnitUpdate;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract thinking/text from a Pi message content array (or string body). */
export function messageFromPiContent(content: unknown): ParentUnitMessage | undefined {
  if (typeof content === "string") {
    return content.length > 0 ? { text: content } : undefined;
  }
  if (!Array.isArray(content)) return undefined;
  let thinking = "";
  let text = "";
  let saw = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      thinking += block.thinking;
      saw = true;
    } else if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
      saw = true;
    }
  }
  if (!saw) return undefined;
  const out: ParentUnitMessage = {};
  if (thinking.length > 0) out.thinking = thinking;
  // Keep empty text when thinking-only so UI can show waiting vs thinking cleanly.
  if (text.length > 0) out.text = text;
  else if (thinking.length > 0) out.text = "";
  return out;
}

function messageFromPayload(payload: unknown): ParentUnitMessage | undefined {
  if (!isRecord(payload)) return undefined;
  if (!("message" in payload)) return undefined;
  const msg = payload.message;
  if (!isRecord(msg)) return undefined;
  return messageFromPiContent(msg.content);
}

function toolFields(payload: unknown): {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
} {
  if (!isRecord(payload)) return {};
  return {
    toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
    toolName: typeof payload.toolName === "string" ? payload.toolName : undefined,
    args: "args" in payload ? payload.args : undefined,
    partialResult: "partialResult" in payload ? payload.partialResult : undefined,
    result: "result" in payload ? payload.result : undefined,
    isError: typeof payload.isError === "boolean" ? payload.isError : undefined,
  };
}

function now(): number {
  return Date.now();
}

/**
 * Create a per-unit reducer. One instance per produce child (planner/domain/leaf/reviewer).
 */
export function createParentVisibilityReducer(
  opts: CreateParentVisibilityReducerOpts,
): ParentVisibilityReducer {
  const unitId = opts.unitId.trim() || "unit";
  const role = opts.role;
  let status: ParentUnitStatus = "pending";
  let task = opts.task;
  let parentId = opts.parentId;
  const runId = opts.runId;
  let message: ParentUnitMessage | undefined;
  const tools = new Map<string, ParentUnitToolState>();
  let summary: string | undefined;
  let receiptPath: string | undefined;
  let error: string | undefined;
  let updatedAt = now();

  const snapshot = (): ParentUnitUpdate => {
    const toolsArr = tools.size > 0 ? Array.from(tools.values()) : undefined;
    return {
      unitId,
      role,
      status,
      ...(runId !== undefined ? { runId } : {}),
      ...(task !== undefined ? { task } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(toolsArr !== undefined ? { tools: toolsArr } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(receiptPath !== undefined ? { receiptPath } : {}),
      ...(error !== undefined ? { error } : {}),
      updatedAt,
    };
  };

  const touch = (): ParentUnitUpdate => {
    updatedAt = now();
    return snapshot();
  };

  const markRunning = (): void => {
    if (status === "pending") status = "running";
    // Terminal states stay terminal (ignore late Pi frames after settle/fail).
  };

  const isTerminal = (): boolean => status === "settled" || status === "failed";

  return {
    getUnit: snapshot,

    open(extra) {
      if (!isTerminal()) {
        status = "running";
        if (extra?.task !== undefined) task = extra.task;
        if (extra?.parentId !== undefined) parentId = extra.parentId;
        error = undefined;
      }
      return touch();
    },

    settle(summaryText, extra) {
      status = "settled";
      if (summaryText !== undefined) summary = summaryText;
      if (extra?.receiptPath !== undefined) receiptPath = extra.receiptPath;
      error = undefined;
      return touch();
    },

    fail(errText) {
      status = "failed";
      if (errText !== undefined) error = errText;
      return touch();
    },

    onPiEvent(kind, payload) {
      if (isTerminal()) {
        return snapshot();
      }

      switch (kind) {
        case "agent_start":
        case "message_start":
        case "turn_start": {
          markRunning();
          const fromMsg = messageFromPayload(payload);
          if (fromMsg) message = fromMsg;
          return touch();
        }

        case "message_update":
        case "message_end": {
          markRunning();
          // Snapshot replace — full message is authority when present.
          const fromMsg = messageFromPayload(payload);
          if (fromMsg) {
            message = fromMsg;
          }
          return touch();
        }

        case "tool_execution_start": {
          markRunning();
          const t = toolFields(payload);
          if (!t.toolCallId) return touch();
          tools.set(t.toolCallId, {
            toolCallId: t.toolCallId,
            toolName: t.toolName ?? "tool",
            state: "input-available",
            ...(t.args !== undefined ? { input: t.args } : {}),
          });
          return touch();
        }

        case "tool_execution_update": {
          markRunning();
          const t = toolFields(payload);
          if (!t.toolCallId) return touch();
          const prev = tools.get(t.toolCallId);
          tools.set(t.toolCallId, {
            toolCallId: t.toolCallId,
            toolName: t.toolName ?? prev?.toolName ?? "tool",
            state: "input-available",
            input: t.args !== undefined ? t.args : prev?.input,
            ...(t.partialResult !== undefined
              ? { output: t.partialResult }
              : prev?.output !== undefined
                ? { output: prev.output }
                : {}),
          });
          return touch();
        }

        case "tool_execution_end": {
          markRunning();
          const t = toolFields(payload);
          if (!t.toolCallId) return touch();
          const prev = tools.get(t.toolCallId);
          const isError = t.isError === true;
          tools.set(t.toolCallId, {
            toolCallId: t.toolCallId,
            toolName: t.toolName ?? prev?.toolName ?? "tool",
            state: isError ? "output-error" : "output-available",
            input: t.args !== undefined ? t.args : prev?.input,
            ...(t.result !== undefined
              ? { output: t.result }
              : prev?.output !== undefined
                ? { output: prev.output }
                : {}),
            ...(isError
              ? {
                  errorText: typeof t.result === "string" ? t.result.slice(0, 4000) : "tool error",
                }
              : {}),
          });
          return touch();
        }

        case "agent_end":
        case "agent_settled":
        case "turn_end":
        case "error": {
          // Lifecycle noise — keep running until host settle/fail.
          // Prefer message snapshot if present on the event.
          markRunning();
          const fromMsg = messageFromPayload(payload);
          if (fromMsg) message = fromMsg;
          if (kind === "error" && isRecord(payload)) {
            const errMsg =
              typeof payload.error === "string"
                ? payload.error
                : typeof payload.message === "string"
                  ? payload.message
                  : undefined;
            if (errMsg) error = errMsg.slice(0, 4000);
          }
          return touch();
        }

        default:
          return snapshot();
      }
    },
  };
}

/**
 * Bind a unit reducer to a Produce-style workUnit sink (requires runId).
 */
export function attachWorkUnitSink(
  sink: {
    workUnit?: (p: ParentUnitUpdate & { runId: string }) => void;
  },
  opts: CreateParentVisibilityReducerOpts & { runId: string },
): {
  open: (extra?: { task?: string; parentId?: string }) => ParentUnitUpdate;
  onPiEvent: (kind: string, payload: unknown) => ParentUnitUpdate;
  settle: (summary?: string, extra?: { receiptPath?: string }) => ParentUnitUpdate;
  fail: (error?: string) => ParentUnitUpdate;
  getUnit: () => ParentUnitUpdate;
} {
  const reducer = createParentVisibilityReducer(opts);
  const push = (u: ParentUnitUpdate): ParentUnitUpdate => {
    sink.workUnit?.({ ...u, runId: opts.runId });
    return u;
  };
  return {
    open: (extra) => push(reducer.open(extra)),
    onPiEvent: (kind, payload) => push(reducer.onPiEvent(kind, payload)),
    settle: (summary, extra) => push(reducer.settle(summary, extra)),
    fail: (error) => push(reducer.fail(error)),
    getUnit: () => reducer.getUnit(),
  };
}
