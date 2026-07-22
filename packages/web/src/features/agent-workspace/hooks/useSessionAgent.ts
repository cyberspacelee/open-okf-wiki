/**
 * Client hook for the Pi Agent Workspace (ADR 0030).
 *
 * Live transport:
 * - POST AgentCommand → /command
 * - EventSource ← /events (product injects + Pi AgentSession events)
 *
 * Transcript is projected from SSE only for assistant / tool / product rows.
 * User prompts are optimistic; no invented stub tool trails.
 *
 * Projection rules (see project-agent-events.ts) follow pi-web:
 * - ignore user / toolResult message_* as transcript cards
 * - one assistant bubble per assistant message; tools nest under last assistant
 * - busy status follows agent_start / agent_end (not every message_end)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCommand,
  AgentCommandResponse,
  AgentSseEvent,
  ProductSseEvent,
  WikiRunPlan,
} from "@okf-wiki/contract";
import {
  agentSessionCommand,
  agentSessionEventsUrl,
  getAgentSession,
} from "../../../api";
import {
  applyPiEvent,
  applyProductEvent,
  isTerminalOrWaitingPhase,
  type AgentMessage,
  type StreamingRefs,
} from "./project-agent-events";

export type {
  AgentMessage,
  AgentProductMeta,
  AgentToolCall,
} from "./project-agent-events";

export type AgentMessageRole = AgentMessage["role"];
export type AgentStatus = "idle" | "sending" | "streaming" | "error";

/** Active product HITL gate waiting on the operator. */
export type PendingGate = {
  gate: "plan" | "publication";
  runId?: string;
  question?: string;
  plan?: WikiRunPlan;
  pages?: string[];
};

export type ResumeGateInput = {
  gate: "plan" | "publication";
  action: "approve" | "deny" | "revise";
  feedback?: string;
  runId?: string;
};

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
  /** Resume plan / publication gate (approve | deny | revise). */
  resumeGate: (input: ResumeGateInput) => Promise<void>;
  abort: () => Promise<void>;
  clearError: () => void;
  /** Absolute EventSource URL for Pi + product SSE. */
  eventsUrl: string | null;
  lastCommandResponse: AgentCommandResponse | null;
  /** Latest product run phase (from SSE). */
  phase: string | null;
  /** Linked product run id (from run_link / run_phase). */
  linkedRunId: string | null;
  /** Plan from the latest product gate inject. */
  plan: WikiRunPlan | null;
  /** Active HITL gate, if any. */
  pendingGate: PendingGate | null;
  /** True while a resume_gate command is in flight. */
  gateBusy: boolean;
};

const RECONNECT_MS = 1500;

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
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
  const [phase, setPhase] = useState<string | null>(null);
  const [linkedRunId, setLinkedRunId] = useState<string | null>(null);
  const [plan, setPlan] = useState<WikiRunPlan | null>(null);
  const [pendingGate, setPendingGate] = useState<PendingGate | null>(null);
  const [gateBusy, setGateBusy] = useState(false);

  const sendInFlight = useRef(false);
  const planRef = useRef<WikiRunPlan | null>(null);
  const linkedRunIdRef = useRef<string | null>(null);
  planRef.current = plan;
  linkedRunIdRef.current = linkedRunId;
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSequenceRef = useRef<number>(-1);
  const streamRefs = useRef<StreamingRefs>({
    streamingAssistantId: null,
    lastAssistantId: null,
  });
  /** Generation counter so stale reconnects do not reopen closed sessions. */
  const streamGenRef = useRef(0);

  const eventsUrl = useMemo(() => {
    if (!sessionId) return null;
    return agentSessionEventsUrl(workspaceId, sessionId, rootPath);
  }, [workspaceId, sessionId, rootPath]);

  // Cold-load Pi JSONL + product meta before (and after) SSE reconnects.
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setPendingGate(null);
      setPhase(null);
      setLinkedRunId(null);
      setPlan(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const snap = await getAgentSession(workspaceId, sessionId, rootPath);
        if (cancelled) return;
        const restored: AgentMessage[] = (snap.messages ?? []).map((m) => ({
          id: m.id,
          role: m.role === "system" ? "system" : m.role,
          content: m.text,
          thinking: m.thinking,
          thinkingStatus: m.thinking ? ("done" as const) : undefined,
          createdAt: m.createdAt ?? nowIso(),
          status: m.status === "error" ? "error" : m.status,
          errorMessage: m.errorMessage,
          tools: m.tools?.map((t) => ({
            id: t.id,
            name: t.name,
            status:
              t.status === "running"
                ? ("running" as const)
                : t.status === "error"
                  ? ("error" as const)
                  : ("done" as const),
          })),
        }));
        setMessages(restored);
        if (snap.product?.runId) setLinkedRunId(snap.product.runId);
        if (snap.product?.phase) setPhase(snap.product.phase);
        if (snap.product?.plan) setPlan(snap.product.plan);
        if (snap.product?.pendingGate?.gate) {
          setPendingGate({
            gate: snap.product.pendingGate.gate,
            runId: snap.product.runId,
            plan: snap.product.pendingGate.plan,
            pages: snap.product.pendingGate.pages,
          });
        }
      } catch {
        // Empty history is fine for brand-new sessions.
        if (!cancelled) setMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
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
      setMessages((prev) => applyProductEvent(prev, product));

      if (product.kind === "run_phase") {
        setPhase(product.phase);
        if (product.runId) setLinkedRunId(product.runId);
        if (isTerminalOrWaitingPhase(product.phase)) {
          setStatus("idle");
        } else {
          setStatus("streaming");
        }
        // Clear HITL chrome when the shell leaves a waiting phase.
        // (revise keeps awaiting_plan — gate inject will refresh pendingGate.)
        if (
          product.phase !== "awaiting_plan" &&
          product.phase !== "awaiting_publish"
        ) {
          setPendingGate(null);
        }
      } else if (product.kind === "run_link") {
        setLinkedRunId(product.runId);
      } else if (product.kind === "gate") {
        if (product.runId) setLinkedRunId(product.runId);
        if (product.plan) setPlan(product.plan);
        // resume_gate echoes also emit gate — open questions set pending;
        // revise echoes refresh plan while keeping the gate open.
        const isResumeEcho =
          typeof product.question === "string" &&
          product.question.startsWith("resume_gate ");
        if (!isResumeEcho && product.gate) {
          setPendingGate({
            gate: product.gate,
            runId: product.runId,
            question: product.question,
            plan: product.plan,
            pages: product.pages,
          });
          setStatus("idle");
        } else if (isResumeEcho && product.gate) {
          setPendingGate((prev) => {
            if (!prev || prev.gate !== product.gate) return prev;
            return {
              ...prev,
              runId: product.runId ?? prev.runId,
              plan: product.plan ?? prev.plan,
              pages: product.pages ?? prev.pages,
            };
          });
        }
      }
      return;
    }

    if (event.source === "pi") {
      const kind = event.kind;
      // Busy chrome follows agent lifecycle, NOT every message_end
      // (Pi emits message_end for user + toolResult mid-turn).
      if (kind === "agent_start" || kind === "prompt" || kind === "steer") {
        setStatus("streaming");
      } else if (kind === "agent_end" || kind === "agent_settled") {
        setStatus((s) => (s === "error" ? s : "idle"));
      } else if (kind === "error") {
        const payload = event.payload;
        const message =
          isRecord(payload) && typeof payload.message === "string"
            ? payload.message
            : "Agent error";
        setError(message);
        setStatus("error");
      } else if (kind === "message_end") {
        // Also catch in-message provider errors (stopReason error) for banner.
        const payload = event.payload;
        const msg =
          isRecord(payload) && isRecord(payload.message)
            ? payload.message
            : null;
        if (
          msg &&
          (msg.stopReason === "error" ||
            msg.stopReason === "aborted" ||
            (typeof msg.errorMessage === "string" && msg.errorMessage.trim()))
        ) {
          const message =
            typeof msg.errorMessage === "string" && msg.errorMessage.trim()
              ? msg.errorMessage.trim()
              : "Agent response failed";
          setError(message);
          setStatus("error");
        }
      }

      setMessages((prev) =>
        applyPiEvent(prev, kind, event.payload, streamRefs.current),
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
    setPhase(null);
    setLinkedRunId(null);
    setPlan(null);
    setPendingGate(null);
    setGateBusy(false);
    sendInFlight.current = false;
    lastSequenceRef.current = -1;
    streamRefs.current = {
      streamingAssistantId: null,
      lastAssistantId: null,
    };

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
        const res = await runCommand({ type: "prompt", text: body });
        // Provider may finish the HTTP command with ok:false while SSE already
        // projected an error bubble — surface banner either way.
        if (res && (res.ok === false || res.status === "failed")) {
          const msg =
            res.message?.trim() ||
            "Agent prompt failed (see transcript for details)";
          setError(msg);
          setStatus("error");
          return;
        }
        // Stay streaming until agent_end / terminal product phase when ok.
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
        const res = await runCommand({
          type: "start_wiki_run",
          ...(profileId ? { modelProfileId: profileId } : {}),
        });
        // Product run_phase / gate / run_link events populate the transcript.
        // If the command was ignored (busy), surface that immediately.
        if (res?.message?.includes("ignored")) {
          setError(res.message);
          setStatus("idle");
        }
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

  const resumeGate = useCallback(
    async (input: ResumeGateInput) => {
      if (!sessionId || gateBusy || sendInFlight.current) {
        return;
      }
      setGateBusy(true);
      setError(null);
      try {
        setStatus("streaming");
        const runId =
          input.runId ??
          pendingGate?.runId ??
          linkedRunIdRef.current ??
          undefined;
        const planForApprove =
          input.gate === "plan" && input.action === "approve"
            ? (pendingGate?.plan ?? planRef.current ?? undefined)
            : undefined;
        const res = await runCommand({
          type: "resume_gate",
          gate: input.gate,
          action: input.action,
          ...(input.feedback?.trim()
            ? { feedback: input.feedback.trim() }
            : {}),
          ...(planForApprove ? { plan: planForApprove } : {}),
          ...(runId ? { runId } : {}),
        });
        if (
          res?.message?.includes("rejected") ||
          res?.message?.includes("ignored")
        ) {
          setError(res.message);
          setStatus("idle");
          return;
        }
        // Optimistic clear for terminal gate decisions; revise stays open.
        if (input.action === "approve" || input.action === "deny") {
          setPendingGate(null);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
      } finally {
        setGateBusy(false);
      }
    },
    [sessionId, gateBusy, pendingGate, runCommand],
  );

  const abort = useCallback(async () => {
    if (!sessionId) return;
    try {
      await runCommand({ type: "abort" });
    } catch {
      // Server may reject if session missing — still mark local idle.
    }
    setStatus("idle");
    streamRefs.current = {
      streamingAssistantId: null,
      lastAssistantId: streamRefs.current.lastAssistantId,
    };
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
    resumeGate,
    abort,
    clearError,
    eventsUrl,
    lastCommandResponse,
    phase,
    linkedRunId,
    plan,
    pendingGate,
    gateBusy,
  };
}
