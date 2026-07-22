/**
 * Client hook for the Pi Agent Workspace (ADR 0030).
 *
 * Live transport:
 * - POST AgentCommand → /command
 * - EventSource ← /events (product injects + Pi AgentSession events)
 *
 * Transcript is projected from SSE only for assistant / tool / product rows.
 * User prompts are optimistic; no invented stub tool trails.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCommand,
  AgentCommandResponse,
  AgentSseEvent,
  ProductSseEvent,
} from "@okf-wiki/contract";
import {
  agentSessionCommand,
  agentSessionEventsUrl,
} from "../../../api";

export type AgentMessageRole = "user" | "assistant" | "tool" | "system";

export type AgentToolCall = {
  id: string;
  name: string;
  input?: string;
  output?: string;
  status: "pending" | "running" | "done" | "error";
};

/** Product SSE inject rendered as a system/product card. */
export type AgentProductMeta = {
  kind: "run_phase" | "gate" | "run_link";
  phase?: string;
  gate?: "plan" | "publication";
  runId?: string;
  status?: string;
  question?: string;
};

export type AgentMessage = {
  id: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  /** Tool-like cards nested under an assistant turn. */
  tools?: AgentToolCall[];
  /** Soft status line (e.g. "streaming", "aborted"). */
  status?: string;
  /** Product inject metadata (phase / gate / run_link). */
  product?: AgentProductMeta;
};

export type AgentStatus = "idle" | "sending" | "streaming" | "error";

export type UseSessionAgentArgs = {
  workspaceId: string;
  sessionId: string | null;
  rootPath?: string;
};

export type UseSessionAgentResult = {
  messages: AgentMessage[];
  status: AgentStatus;
  error: string | null;
  input: string;
  setInput: (value: string) => void;
  send: (text?: string) => Promise<void>;
  /**
   * Kick a wiki-run style turn via start_wiki_run command.
   * Optional modelProfileId overrides the workspace default for this run.
   */
  startWikiRun: (options?: { modelProfileId?: string }) => Promise<void>;
  abort: () => Promise<void>;
  clearError: () => void;
  /** Absolute EventSource URL for Pi + product SSE. */
  eventsUrl: string | null;
  lastCommandResponse: AgentCommandResponse | null;
};

const RECONNECT_MS = 1500;

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeStringify(value: unknown, max = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventSequence(event: AgentSseEvent): number | undefined {
  if ("sequence" in event && typeof event.sequence === "number") {
    return event.sequence;
  }
  return undefined;
}

function productCardContent(event: ProductSseEvent): string {
  switch (event.kind) {
    case "run_phase": {
      const bits = [`Phase: ${event.phase}`];
      if (event.status) bits.push(`status=${event.status}`);
      if (event.runId) bits.push(`run=${event.runId}`);
      if (event.message) bits.push(event.message);
      return bits.join(" · ");
    }
    case "gate": {
      const bits = [`Gate: ${event.gate}`];
      if (event.runId) bits.push(`run=${event.runId}`);
      if (event.question) bits.push(event.question);
      if (event.pages?.length) {
        bits.push(`pages: ${event.pages.slice(0, 8).join(", ")}`);
      }
      return bits.join(" · ");
    }
    case "run_link": {
      const bits = [`Linked run ${event.runId}`];
      if (event.status) bits.push(`status=${event.status}`);
      return bits.join(" · ");
    }
    default: {
      const _exhaustive: never = event;
      return String(_exhaustive);
    }
  }
}

function productMeta(event: ProductSseEvent): AgentProductMeta {
  switch (event.kind) {
    case "run_phase":
      return {
        kind: "run_phase",
        phase: event.phase,
        runId: event.runId,
        status: event.status,
      };
    case "gate":
      return {
        kind: "gate",
        gate: event.gate,
        runId: event.runId,
        question: event.question,
      };
    case "run_link":
      return {
        kind: "run_link",
        runId: event.runId,
        status: event.status,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Project a Pi AgentSession event (wrapped as source:"pi") into transcript
 * mutations. Mutates `messages` in place via functional updates outside.
 */
function applyPiEvent(
  prev: AgentMessage[],
  kind: string,
  payload: unknown,
  streamingAssistantId: { current: string | null },
): AgentMessage[] {
  const body = isRecord(payload) ? payload : {};
  const ts = nowIso();

  // text_delta under message_update
  if (kind === "message_update") {
    const ame = isRecord(body.assistantMessageEvent)
      ? body.assistantMessageEvent
      : null;
    if (ame?.type === "text_delta" && typeof ame.delta === "string") {
      const delta = ame.delta;
      const existingId = streamingAssistantId.current;
      if (existingId) {
        let found = false;
        const next = prev.map((m) => {
          if (m.id !== existingId) return m;
          found = true;
          return {
            ...m,
            content: m.content + delta,
            status: "streaming",
          };
        });
        if (found) return next;
      }
      const id = makeId("asst");
      streamingAssistantId.current = id;
      return [
        ...prev,
        {
          id,
          role: "assistant",
          content: delta,
          createdAt: ts,
          status: "streaming",
          tools: [],
        },
      ];
    }
    return prev;
  }

  if (kind === "message_start") {
    // Prefer creating a bubble so later tool events have a parent.
    if (streamingAssistantId.current) {
      const id = streamingAssistantId.current;
      if (prev.some((m) => m.id === id)) return prev;
    }
    const id = makeId("asst");
    streamingAssistantId.current = id;
    return [
      ...prev,
      {
        id,
        role: "assistant",
        content: "",
        createdAt: ts,
        status: "streaming",
        tools: [],
      },
    ];
  }

  if (kind === "message_end") {
    const id = streamingAssistantId.current;
    // Fixture mode: server emits note without prior streaming deltas.
    const fixtureNote =
      typeof body.note === "string"
        ? body.note
        : typeof body.mode === "string" && body.mode === "fixture"
          ? "fixture mode — prompt recorded (no LLM)"
          : undefined;
    if (id) {
      streamingAssistantId.current = null;
      return prev.map((m) => {
        if (m.id !== id) return m;
        const content =
          m.content ||
          (typeof fixtureNote === "string" ? fixtureNote : m.content);
        return { ...m, content, status: "done" };
      });
    }
    if (fixtureNote) {
      return [
        ...prev,
        {
          id: makeId("asst"),
          role: "assistant",
          content: fixtureNote,
          createdAt: ts,
          status: "done",
        },
      ];
    }
    return prev;
  }

  if (kind === "tool_execution_start") {
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : makeId("tool");
    const toolName =
      typeof body.toolName === "string" ? body.toolName : "tool";
    const input = safeStringify(body.args);
    const tool: AgentToolCall = {
      id: toolCallId,
      name: toolName,
      input,
      status: "running",
    };

    let assistantId = streamingAssistantId.current;
    if (!assistantId || !prev.some((m) => m.id === assistantId)) {
      assistantId = makeId("asst");
      streamingAssistantId.current = assistantId;
      return [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          content: "",
          createdAt: ts,
          status: "streaming",
          tools: [tool],
        },
      ];
    }

    return prev.map((m) => {
      if (m.id !== assistantId) return m;
      const tools = [...(m.tools ?? [])];
      const idx = tools.findIndex((t) => t.id === toolCallId);
      if (idx >= 0) {
        tools[idx] = { ...tools[idx], ...tool };
      } else {
        tools.push(tool);
      }
      return { ...m, tools, status: "streaming" };
    });
  }

  if (kind === "tool_execution_update") {
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return prev;
    const partial = safeStringify(body.partialResult);
    return prev.map((m) => {
      if (!m.tools?.some((t) => t.id === toolCallId)) return m;
      return {
        ...m,
        tools: m.tools.map((t) =>
          t.id === toolCallId
            ? { ...t, output: partial ?? t.output, status: "running" as const }
            : t,
        ),
      };
    });
  }

  if (kind === "tool_execution_end") {
    const toolCallId =
      typeof body.toolCallId === "string" ? body.toolCallId : null;
    if (!toolCallId) return prev;
    const output = safeStringify(body.result);
    const isError = body.isError === true;
    return prev.map((m) => {
      if (!m.tools?.some((t) => t.id === toolCallId)) return m;
      return {
        ...m,
        tools: m.tools.map((t) =>
          t.id === toolCallId
            ? {
                ...t,
                output: output ?? t.output,
                status: isError ? ("error" as const) : ("done" as const),
              }
            : t,
        ),
      };
    });
  }

  if (kind === "error") {
    const message =
      typeof body.message === "string" ? body.message : "Agent error";
    return [
      ...prev,
      {
        id: makeId("sys"),
        role: "system",
        content: message,
        createdAt: ts,
        status: "error",
      },
    ];
  }

  // agent_start / agent_end / agent_settled / prompt / session_ready / etc.
  // do not invent transcript rows — status is handled by the caller.
  return prev;
}

export function useSessionAgent({
  workspaceId,
  sessionId,
  rootPath,
}: UseSessionAgentArgs): UseSessionAgentResult {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [lastCommandResponse, setLastCommandResponse] =
    useState<AgentCommandResponse | null>(null);

  const sendInFlight = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSequenceRef = useRef<number>(-1);
  const streamingAssistantId = useRef<string | null>(null);
  /** Generation counter so stale reconnects do not reopen closed sessions. */
  const streamGenRef = useRef(0);

  const eventsUrl = useMemo(() => {
    if (!sessionId) return null;
    return agentSessionEventsUrl(workspaceId, sessionId, rootPath);
  }, [workspaceId, sessionId, rootPath]);

  const handleSseEvent = useCallback((raw: unknown) => {
    if (!isRecord(raw) || typeof raw.source !== "string") return;
    const event = raw as AgentSseEvent;

    const seq = eventSequence(event);
    if (seq !== undefined) {
      if (seq <= lastSequenceRef.current) return;
      lastSequenceRef.current = seq;
    }

    if (event.source === "server" && event.kind === "heartbeat") {
      return;
    }

    if (event.source === "product") {
      const product = event as ProductSseEvent;
      const card: AgentMessage = {
        id: makeId(`product_${product.kind}`),
        role: "system",
        content: productCardContent(product),
        createdAt:
          "timestamp" in product && typeof product.timestamp === "string"
            ? product.timestamp
            : nowIso(),
        product: productMeta(product),
        status: product.kind,
      };
      setMessages((prev) => [...prev, card]);
      if (product.kind === "run_phase") {
        if (
          product.phase === "done" ||
          product.phase === "failed" ||
          product.phase === "cancelled" ||
          product.phase === "idle" ||
          product.phase === "awaiting_plan" ||
          product.phase === "awaiting_publish"
        ) {
          setStatus("idle");
        } else {
          setStatus("streaming");
        }
      }
      return;
    }

    if (event.source === "pi") {
      const kind = event.kind;
      if (kind === "agent_start" || kind === "prompt" || kind === "steer") {
        setStatus("streaming");
      } else if (
        kind === "agent_end" ||
        kind === "agent_settled" ||
        kind === "message_end"
      ) {
        setStatus((s) => (s === "error" ? s : "idle"));
      } else if (kind === "error") {
        const payload = event.payload;
        const message =
          isRecord(payload) && typeof payload.message === "string"
            ? payload.message
            : "Agent error";
        setError(message);
        setStatus("error");
      }

      setMessages((prev) =>
        applyPiEvent(prev, kind, event.payload, streamingAssistantId),
      );
    }
  }, []);

  // Open / reconnect EventSource when session (or URL) changes.
  useEffect(() => {
    setMessages([]);
    setStatus("idle");
    setError(null);
    setInput("");
    setLastCommandResponse(null);
    sendInFlight.current = false;
    lastSequenceRef.current = -1;
    streamingAssistantId.current = null;

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (!eventsUrl || !sessionId || typeof EventSource === "undefined") {
      return;
    }

    const gen = ++streamGenRef.current;

    const open = (): void => {
      if (streamGenRef.current !== gen) return;

      const es = new EventSource(eventsUrl);
      esRef.current = es;

      es.onmessage = (msg) => {
        if (streamGenRef.current !== gen) return;
        try {
          const parsed: unknown = JSON.parse(msg.data);
          handleSseEvent(parsed);
        } catch {
          // ignore malformed SSE frames
        }
      };

      es.onerror = () => {
        // Browser will retry automatically in some cases; we force a clean
        // reconnect with a short backoff so late subscribers get the ring buffer.
        es.close();
        if (esRef.current === es) {
          esRef.current = null;
        }
        if (streamGenRef.current !== gen) return;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          open();
        }, RECONNECT_MS);
      };
    };

    open();

    return () => {
      streamGenRef.current += 1;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [eventsUrl, sessionId, handleSseEvent]);

  const runCommand = useCallback(
    async (command: AgentCommand): Promise<AgentCommandResponse | null> => {
      if (!sessionId) return null;
      const res = await agentSessionCommand(
        workspaceId,
        sessionId,
        command,
        rootPath,
      );
      setLastCommandResponse(res);
      return res;
    },
    [workspaceId, sessionId, rootPath],
  );

  const send = useCallback(
    async (text?: string) => {
      const body = (text ?? input).trim();
      if (!body || !sessionId || sendInFlight.current) {
        return;
      }
      sendInFlight.current = true;
      setError(null);
      setStatus("sending");
      setInput("");

      // Optimistic user row only — assistant/tool rows come from SSE.
      const userMsg: AgentMessage = {
        id: makeId("user"),
        role: "user",
        content: body,
        createdAt: nowIso(),
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        setStatus("streaming");
        await runCommand({ type: "prompt", text: body });
        // Stay streaming until agent_end / message_end / idle product phase.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
      } finally {
        sendInFlight.current = false;
      }
    },
    [input, sessionId, runCommand],
  );

  const startWikiRun = useCallback(
    async (options?: { modelProfileId?: string }) => {
      if (!sessionId || sendInFlight.current) {
        return;
      }
      sendInFlight.current = true;
      setError(null);
      setStatus("sending");

      try {
        setStatus("streaming");
        const profileId = options?.modelProfileId?.trim();
        await runCommand({
          type: "start_wiki_run",
          ...(profileId ? { modelProfileId: profileId } : {}),
        });
        // Product run_phase / gate / run_link events populate the transcript.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
      } finally {
        sendInFlight.current = false;
      }
    },
    [sessionId, runCommand],
  );

  const abort = useCallback(async () => {
    if (!sessionId) return;
    try {
      await runCommand({ type: "abort" });
    } catch {
      // Server may reject if session missing — still mark local idle.
    }
    setStatus("idle");
    streamingAssistantId.current = null;
    setMessages((prev) => [
      ...prev,
      {
        id: makeId("sys"),
        role: "system",
        content: "Aborted.",
        createdAt: nowIso(),
        status: "aborted",
      },
    ]);
  }, [sessionId, runCommand]);

  const clearError = useCallback(() => setError(null), []);

  return {
    messages,
    status,
    error,
    input,
    setInput,
    send,
    startWikiRun,
    abort,
    clearError,
    eventsUrl,
    lastCommandResponse,
  };
}
