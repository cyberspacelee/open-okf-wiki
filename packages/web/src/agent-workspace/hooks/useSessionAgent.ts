/** React adapter for the Pi-only Operator Session stream (ADR 0032). */

import type {
  AgentCommand,
  AgentCommandResponse,
  AgentResumeGateCommand,
} from "@okf-wiki/contract";
import { AgentSseEventSchema } from "@okf-wiki/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentSessionCommand, agentSessionEventsUrl } from "../../api";
import { isRecord, makeId } from "./project/format";
import { createPiStreamState, projectAgentEvent, viewMessages } from "./project/pi";
import type {
  AgentMessage,
  AgentSseLike,
  AgentToolCall,
  PiStreamState,
} from "./project/types";

/** Unified command failure check (server uses ok/status, not string heuristics). */
export function isCommandFailed(res: AgentCommandResponse | null | undefined): boolean {
  if (!res) return false;
  return res.ok === false || res.status === "failed";
}

export type { AgentMessage, AgentToolCall };

export type AgentMessageRole = AgentMessage["role"];
export type AgentStatus = "idle" | "sending" | "streaming" | "error";

export type UseSessionAgentArgs = {
  workspaceId: string;
  sessionId: string | null;
  rootPath?: string;
};

export type UseSessionAgentResult = {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  status: AgentStatus;
  ready: boolean;
  error: string | null;
  input: string;
  setInput: (value: string) => void;
  send: (text?: string) => Promise<void>;
  abort: () => Promise<void>;
  resumeGate: (command: AgentResumeGateCommand) => Promise<void>;
  clearError: () => void;
  eventsUrl: string | null;
  lastCommandResponse: AgentCommandResponse | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function eventError(event: AgentSseLike): string | null {
  if (event.source !== "pi") return null;
  if (event.kind === "error" && isRecord(event.payload)) {
    return typeof event.payload.message === "string" ? event.payload.message : "Agent error";
  }
  if (event.kind !== "message_end" || !isRecord(event.payload)) return null;
  const message = isRecord(event.payload.message) ? event.payload.message : null;
  if (!message) return null;
  if (
    message.stopReason !== "error" &&
    message.stopReason !== "aborted" &&
    typeof message.errorMessage !== "string"
  ) {
    return null;
  }
  return typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage.trim()
    : "Agent response failed";
}

export function useSessionAgent({
  workspaceId,
  sessionId,
  rootPath,
}: UseSessionAgentArgs): UseSessionAgentResult {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<AgentMessage | null>(null);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [lastCommandResponse, setLastCommandResponse] = useState<AgentCommandResponse | null>(null);

  const streamStateRef = useRef<PiStreamState>(createPiStreamState());
  const eventSourceRef = useRef<EventSource | null>(null);
  const sendInFlightRef = useRef(false);

  const eventsUrl = useMemo(
    () => (sessionId ? agentSessionEventsUrl(workspaceId, sessionId, rootPath) : null),
    [workspaceId, sessionId, rootPath],
  );

  const publish = useCallback((state: PiStreamState) => {
    streamStateRef.current = state;
    setMessages(viewMessages(state));
    setStreamingMessage(state.streamingMessage);
  }, []);

  useEffect(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    streamStateRef.current = createPiStreamState();
    setMessages([]);
    setStreamingMessage(null);
    setStatus("idle");
    setReady(false);
    setError(null);
    setLastCommandResponse(null);
    sendInFlightRef.current = false;

    if (!eventsUrl || typeof EventSource === "undefined") return;

    const source = new EventSource(eventsUrl);
    eventSourceRef.current = source;

    source.onmessage = (message) => {
      let event: AgentSseLike;
      try {
        const parsed = AgentSseEventSchema.safeParse(JSON.parse(message.data));
        if (!parsed.success) return;
        event = parsed.data;
      } catch {
        return;
      }

      const next = projectAgentEvent(streamStateRef.current, event);
      publish(next);

      if (event.source === "server" && event.kind === "snapshot") {
        setReady(true);
      }

      const failure = eventError(event);
      if (failure) {
        setError(failure);
        setStatus("error");
        return;
      }
      if (event.source !== "pi") return;
      if (event.kind === "agent_start") setStatus("streaming");
      if (event.kind === "agent_end" || event.kind === "agent_settled") {
        setStatus((current) => (current === "error" ? current : "idle"));
      }
    };

    // Native EventSource reconnects. Each reconnect receives a fresh snapshot,
    // which replaces local state; no client replay cursor or ring is needed.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setReady(false);
        setStatus((current) => (current === "error" ? current : "idle"));
      }
    };

    return () => {
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
    };
  }, [eventsUrl, publish]);

  const runCommand = useCallback(
    async (command: AgentCommand): Promise<AgentCommandResponse | null> => {
      if (!sessionId) return null;
      const response = await agentSessionCommand(workspaceId, sessionId, command, rootPath);
      setLastCommandResponse(response);
      return response;
    },
    [workspaceId, sessionId, rootPath],
  );

  const send = useCallback(
    async (text?: string) => {
      const value = (text ?? input).trim();
      if (!sessionId || !value || sendInFlightRef.current) return;

      sendInFlightRef.current = true;
      setInput("");
      setError(null);
      setStatus("sending");

      const optimistic: AgentMessage = {
        id: makeId("user"),
        role: "user",
        content: value,
        createdAt: nowIso(),
        status: "done",
      };
      const next = {
        ...streamStateRef.current,
        messages: [...streamStateRef.current.messages, optimistic],
      };
      publish(next);

      try {
        const response = await runCommand({ type: "prompt", text: value });
        if (isCommandFailed(response)) {
          setError(response?.message ?? "Agent command failed");
          setStatus("error");
        } else if (!streamStateRef.current.turnActive) {
          setStatus("idle");
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus("error");
      } finally {
        sendInFlightRef.current = false;
      }
    },
    [input, sessionId, publish, runCommand],
  );

  const abort = useCallback(async () => {
    if (!sessionId) return;
    try {
      const response = await runCommand({ type: "abort" });
      if (isCommandFailed(response)) {
        setError(response?.message ?? "Abort failed");
        setStatus("error");
        return;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("error");
      return;
    }

    const current = streamStateRef.current;
    publish({
      ...current,
      streamingMessage: null,
      turnActive: false,
    });
    setStatus("idle");
  }, [sessionId, publish, runCommand]);

  const resumeGate = useCallback(
    async (command: AgentResumeGateCommand) => {
      setError(null);
      try {
        const response = await runCommand(command);
        if (isCommandFailed(response)) {
          throw new Error(response?.message ?? "Gate decision failed");
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setStatus("error");
        throw caught;
      }
    },
    [runCommand],
  );

  return {
    messages,
    streamingMessage,
    status,
    ready,
    error,
    input,
    setInput,
    send,
    abort,
    resumeGate,
    clearError: () => setError(null),
    eventsUrl,
    lastCommandResponse,
  };
}
