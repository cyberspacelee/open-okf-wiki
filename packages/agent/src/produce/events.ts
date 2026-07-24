/**
 * Produce-owned Operator Event sink (ADR 0029 / 0031).
 * Adapters map these onto product SSE; Session must not invent them.
 *
 * No product work_unit body channel. Child visibility is host-local
 * `onProgress` (WP2), bridged to parent-visible ProduceToolDetails (WP3).
 */

export type ProduceProgressPhase =
  | "planning"
  | "researching"
  | "writing"
  | "reviewing"
  | "repairing"
  | "done"
  | "failed";

/** Operator-visible supervisor role for produce progress tags. */
export type ProduceAgentRole = "domain" | "leaf" | "reviewer" | "root" | "planner";

export type ProduceProgressStatus = "pending" | "running" | "settled" | "failed";

export type ProduceProgressTool = {
  toolCallId: string;
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type ProduceProgressMessage = {
  text?: string;
  thinking?: string;
};

/**
 * Host-local produce unit progress (not a product inject / not work_unit).
 * Fold last-by-unitId on the host if desired; agent never emits product SSE.
 */
export type ProduceProgress = {
  role: ProduceAgentRole;
  status: ProduceProgressStatus;
  unitId?: string;
  task?: string;
  parentId?: string;
  summary?: string;
  tools?: ProduceProgressTool[];
  message?: ProduceProgressMessage;
  error?: string;
  receiptPath?: string;
};

/**
 * Produce → operator sink.
 * Whitelist product injects only (progress / plan_progress / defects).
 * Child trail: onProgress → host bridge (ProduceToolDetails / produce_progress).
 * Never product work_unit.
 */
export type ProduceEventSink = {
  progress?: (p: {
    phase: ProduceProgressPhase;
    label?: string;
    written?: number;
    total?: number;
    defectCount?: number;
  }) => void;
  planProgress?: (p: {
    pages: Array<{ path: string; status: "pending" | "writing" | "done" }>;
  }) => void;
  defects?: (p: { round: number; clean: boolean; defectCount: number; summary?: string }) => void;
  /** Host-local child progress; not a product body channel. */
  onProgress?: (p: ProduceProgress) => void;
};

/** No-op sink for tests / CLI silence. */
export const silentProduceEvents: ProduceEventSink = {};

/** Collect events for unit tests. */
export function recordingProduceEvents(): {
  sink: ProduceEventSink;
  events: Array<{ kind: string; payload: unknown }>;
} {
  const events: Array<{ kind: string; payload: unknown }> = [];
  return {
    events,
    sink: {
      progress: (p) => events.push({ kind: "progress", payload: p }),
      planProgress: (p) => events.push({ kind: "plan_progress", payload: p }),
      defects: (p) => events.push({ kind: "defects", payload: p }),
      onProgress: (p) => events.push({ kind: "onProgress", payload: p }),
    },
  };
}

// ---------------------------------------------------------------------------
// Local progress tracker (Pi events → ProduceProgress → onProgress only)
// ---------------------------------------------------------------------------

export type CreateProgressTrackerOpts = {
  unitId: string;
  role: ProduceAgentRole;
  task?: string;
  parentId?: string;
};

export type ProduceProgressTracker = {
  onPiEvent(kind: string, payload: unknown): ProduceProgress;
  get(): ProduceProgress;
  open(extra?: { task?: string; parentId?: string }): ProduceProgress;
  settle(summary?: string, extra?: { receiptPath?: string }): ProduceProgress;
  fail(error?: string): ProduceProgress;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract thinking/text from a Pi message content array (or string body). */
export function messageFromPiContent(content: unknown): ProduceProgressMessage | undefined {
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
  const out: ProduceProgressMessage = {};
  if (thinking.length > 0) out.thinking = thinking;
  // Keep empty text when thinking-only so UI can show waiting vs thinking cleanly.
  if (text.length > 0) out.text = text;
  else if (thinking.length > 0) out.text = "";
  return out;
}

function messageFromPayload(payload: unknown): ProduceProgressMessage | undefined {
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

/**
 * Create a per-unit local progress tracker.
 * One instance per produce child (planner/domain/leaf/reviewer).
 * Never emits product work_unit — host wires onProgress only.
 */
export function createProgressTracker(opts: CreateProgressTrackerOpts): ProduceProgressTracker {
  const unitId = opts.unitId.trim() || "unit";
  const role = opts.role;
  let status: ProduceProgressStatus = "pending";
  let task = opts.task;
  let parentId = opts.parentId;
  let message: ProduceProgressMessage | undefined;
  const tools = new Map<string, ProduceProgressTool>();
  let summary: string | undefined;
  let receiptPath: string | undefined;
  let error: string | undefined;

  const snapshot = (): ProduceProgress => {
    const toolsArr = tools.size > 0 ? Array.from(tools.values()) : undefined;
    return {
      role,
      status,
      unitId,
      ...(task !== undefined ? { task } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(toolsArr !== undefined ? { tools: toolsArr } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(receiptPath !== undefined ? { receiptPath } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  };

  const markRunning = (): void => {
    if (status === "pending") status = "running";
  };

  const isTerminal = (): boolean => status === "settled" || status === "failed";

  return {
    get: snapshot,

    open(extra) {
      if (!isTerminal()) {
        status = "running";
        if (extra?.task !== undefined) task = extra.task;
        if (extra?.parentId !== undefined) parentId = extra.parentId;
        error = undefined;
      }
      return snapshot();
    },

    settle(summaryText, extra) {
      status = "settled";
      if (summaryText !== undefined) summary = summaryText;
      if (extra?.receiptPath !== undefined) receiptPath = extra.receiptPath;
      error = undefined;
      return snapshot();
    },

    fail(errText) {
      status = "failed";
      if (errText !== undefined) error = errText;
      return snapshot();
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
          return snapshot();
        }

        case "message_update":
        case "message_end": {
          markRunning();
          const fromMsg = messageFromPayload(payload);
          if (fromMsg) message = fromMsg;
          return snapshot();
        }

        case "tool_execution_start": {
          markRunning();
          const t = toolFields(payload);
          if (!t.toolCallId) return snapshot();
          tools.set(t.toolCallId, {
            toolCallId: t.toolCallId,
            toolName: t.toolName ?? "tool",
            state: "input-available",
            ...(t.args !== undefined ? { input: t.args } : {}),
          });
          return snapshot();
        }

        case "tool_execution_update": {
          markRunning();
          const t = toolFields(payload);
          if (!t.toolCallId) return snapshot();
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
          return snapshot();
        }

        case "tool_execution_end": {
          markRunning();
          const t = toolFields(payload);
          if (!t.toolCallId) return snapshot();
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
          return snapshot();
        }

        case "agent_end":
        case "agent_settled":
        case "turn_end":
        case "error": {
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
          return snapshot();
        }

        default:
          return snapshot();
      }
    },
  };
}

/**
 * Bind a unit tracker to a ProduceEventSink.onProgress callback.
 */
export function attachProgress(
  sink: { onProgress?: (p: ProduceProgress) => void },
  opts: CreateProgressTrackerOpts,
): {
  open: (extra?: { task?: string; parentId?: string }) => ProduceProgress;
  onPiEvent: (kind: string, payload: unknown) => ProduceProgress;
  settle: (summary?: string, extra?: { receiptPath?: string }) => ProduceProgress;
  fail: (error?: string) => ProduceProgress;
  get: () => ProduceProgress;
} {
  const tracker = createProgressTracker(opts);
  const push = (p: ProduceProgress): ProduceProgress => {
    try {
      sink.onProgress?.(p);
    } catch {
      // Never let a bad subscriber break produce.
    }
    return p;
  };
  return {
    open: (extra) => push(tracker.open(extra)),
    onPiEvent: (kind, payload) => push(tracker.onPiEvent(kind, payload)),
    settle: (summary, extra) => push(tracker.settle(summary, extra)),
    fail: (error) => push(tracker.fail(error)),
    get: () => tracker.get(),
  };
}
