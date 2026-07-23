/**
 * Client hook for the Pi Agent Workspace (ADR 0030).
 *
 * Live transport:
 * - POST AgentCommand → /command
 * - EventSource ← /events (product injects + Pi AgentSession events)
 *
 * Session bootstrap is a single effect: reset → cold-load history → open SSE.
 * That avoids history/SSE races that wiped the transcript.
 *
 * Command failures use `ok === false` / `status === "failed"` (not string matching).
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
  type AgentSessionHistoryMessage,
} from "../../api";
import { isCommandFailed } from "./command-result";
import {
  applyChildStreamEvent,
  applyPiEvent,
  applyProductEvent,
  isChildPiPayload,
  isTerminalOrWaitingPhase,
  workStreamsFromAgents,
  type AgentMessage,
  type AgentStream,
  type StreamingRefs,
  type WorkAgentChip,
  type WorkStreams,
} from "./project-agent-events";

export { isCommandFailed } from "./command-result";

export type {
  AgentMessage,
  AgentProductMeta,
  AgentStream,
  AgentToolCall,
  WorkStreams,
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
  /**
   * Produce-child live streams (planner / leaf / …) for the Work surface.
   * Not rendered on the main chat timeline.
   */
  workStreams: WorkStreams;
  /** Focused produce agent (opens Work drawer). */
  focusAgentId: string | null;
  setFocusAgentId: (agentId: string | null) => void;
  /** Convenience: stream for the focused agent, if any. */
  focusedStream: AgentStream | null;
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

function historyToMessages(
  rows: AgentSessionHistoryMessage[] | undefined,
): AgentMessage[] {
  return (rows ?? []).map((m) => ({
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
  const [workStreams, setWorkStreams] = useState<WorkStreams>({});
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);

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

      // Seed / finalize Work surface status from agent_span chips.
      if (product.kind === "agent_span" && product.agentId) {
        const agentId = product.agentId;
        const role = product.role ?? "agent";
        setWorkStreams((prev) => {
          const cur = prev[agentId];
          const status =
            product.status === "running"
              ? ("streaming" as const)
              : product.status === "failed"
                ? ("error" as const)
                : ("done" as const);
          return {
            ...prev,
            [agentId]: {
              agentId,
              role,
              status,
              content:
                cur?.content ||
                (product.status !== "running" && product.detail
                  ? product.detail
                  : cur?.content) ||
                "",
              thinking: cur?.thinking,
              thinkingStatus: cur?.thinkingStatus,
              tools: cur?.tools ?? [],
              errorMessage:
                product.status === "failed"
                  ? product.detail || cur?.errorMessage
                  : cur?.errorMessage,
              updatedAt: nowIso(),
            },
          };
        });
        if (product.status === "running") {
          setStatus("streaming");
        }
      }

      if (product.kind === "run_phase") {
        setPhase(product.phase);
        if (product.runId) setLinkedRunId(product.runId);
        if (isTerminalOrWaitingPhase(product.phase)) {
          setStatus((s) => (s === "error" ? s : "idle"));
        } else {
          setStatus("streaming");
        }
        if (
          product.phase !== "awaiting_plan" &&
          product.phase !== "awaiting_publish"
        ) {
          setPendingGate(null);
        }
        if (product.phase === "failed" && product.message) {
          setError(product.message);
          setStatus("error");
        }
      } else if (product.kind === "run_link") {
        setLinkedRunId(product.runId);
      } else if (product.kind === "gate") {
        if (product.runId) setLinkedRunId(product.runId);
        if (product.plan) setPlan(product.plan);
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
          setStatus((s) => (s === "error" ? s : "idle"));
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
      const child = isChildPiPayload(event.payload);

      if (child) {
        // Produce children: Work surface only — do not toggle root chat idle.
        setWorkStreams((prev) =>
          applyChildStreamEvent(prev, kind, event.payload, streamRefs.current),
        );
        setStatus("streaming");
        return;
      }

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

  // Bootstrap: reset → await cold history → open SSE.
  // On first connect, skip ring-buffer replay (only advance sequence until the
  // server hello heartbeat) so history + SSE do not double-apply the same turn.
  // Reconnects apply the buffer with sequence dedup for live catch-up.
  useEffect(() => {
    setStatus("idle");
    setError(null);
    setInput("");
    setLastCommandResponse(null);
    setPhase(null);
    setLinkedRunId(null);
    setPlan(null);
    setPendingGate(null);
    setGateBusy(false);
    setWorkStreams({});
    setFocusAgentId(null);
    sendInFlight.current = false;
    lastSequenceRef.current = -1;
    streamRefs.current = {
      streamingAssistantId: null,
      lastAssistantId: null,
      agents: new Map(),
    };

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (!sessionId) {
      setMessages([]);
      return;
    }

    setMessages([]);

    let cancelled = false;
    const gen = ++streamGenRef.current;

    const openEventSource = (mode: "bootstrap" | "reconnect"): void => {
      if (streamGenRef.current !== gen || !eventsUrl) return;
      if (typeof EventSource === "undefined") return;

      // Bootstrap: skip operator-chat Pi frames that would double history, but
      // still apply product injects + produce-child Pi streams from the ring
      // buffer so refresh mid-wiki-run restores phase / planner / leaf UI.
      // Reconnect: apply buffer; sequence filter drops already-seen frames.
      let skipChatPiUntilHello = mode === "bootstrap";

      const es = new EventSource(eventsUrl);
      esRef.current = es;

      es.onmessage = (msg) => {
        if (streamGenRef.current !== gen) return;
        try {
          const parsed: unknown = JSON.parse(msg.data);
          if (!isRecord(parsed)) return;

          if (skipChatPiUntilHello) {
            if (
              parsed.source === "server" &&
              parsed.kind === "heartbeat"
            ) {
              const seq = eventSequence(parsed as AgentSseEvent);
              if (seq !== undefined && seq > lastSequenceRef.current) {
                lastSequenceRef.current = seq;
              }
              skipChatPiUntilHello = false;
              return;
            }
            // Product timeline + child produce streams are not in Pi JSONL history.
            // handleSseEvent owns sequence advancement so we do not double-skip.
            if (parsed.source === "product") {
              handleSseEvent(parsed);
              return;
            }
            if (
              parsed.source === "pi" &&
              isChildPiPayload(parsed.payload)
            ) {
              handleSseEvent(parsed);
              return;
            }
            // Operator-chat Pi frames: advance sequence only (history already has them).
            const seq = eventSequence(parsed as AgentSseEvent);
            if (seq !== undefined && seq > lastSequenceRef.current) {
              lastSequenceRef.current = seq;
            }
            return;
          }

          handleSseEvent(parsed);
        } catch {
          // ignore malformed SSE frames
        }
      };

      es.onerror = () => {
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
          openEventSource("reconnect");
        }, RECONNECT_MS);
      };
    };

    void (async () => {
      try {
        const snap = await getAgentSession(workspaceId, sessionId, rootPath);
        if (cancelled || streamGenRef.current !== gen) return;
        let timeline = historyToMessages(snap.messages);
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
        // Restore Work surface chips + stream summaries after refresh.
        const coldAgents = (snap.product?.workAgents ??
          []) as WorkAgentChip[];
        if (coldAgents.length > 0) {
          setWorkStreams(workStreamsFromAgents(coldAgents));
          for (const a of coldAgents) {
            timeline = applyProductEvent(timeline, {
              kind: "agent_span",
              agentId: a.agentId,
              role: a.role,
              status: a.status,
              runId: snap.product?.runId,
              task: a.task,
              detail: a.detail,
              spanId: a.spanId ?? a.agentId,
              parentId: a.parentId,
              receiptPath: a.receiptPath,
            });
          }
          if (snap.product?.phase) {
            timeline = applyProductEvent(timeline, {
              kind: "run_phase",
              phase: snap.product.phase as
                | "idle"
                | "planning"
                | "awaiting_plan"
                | "writing"
                | "awaiting_publish"
                | "done"
                | "failed"
                | "cancelled",
              runId: snap.product?.runId,
            });
          }
        }
        setMessages(timeline);
        // Restore streaming chrome when a wiki run / produce is still live.
        const phase = snap.product?.phase;
        const runStatus = snap.product?.runStatus;
        const busy = snap.product?.busy === true;
        const phaseBusy =
          Boolean(phase) && !isTerminalOrWaitingPhase(phase);
        const runBusy =
          runStatus === "running" ||
          runStatus === "awaiting_plan" ||
          runStatus === "awaiting_publication";
        if (busy || phaseBusy) {
          setStatus("streaming");
        } else if (runBusy && phase && !isTerminalOrWaitingPhase(phase)) {
          setStatus("streaming");
        } else if (
          runStatus === "running" &&
          (!phase || phase === "planning" || phase === "writing")
        ) {
          setStatus("streaming");
        }
      } catch (err) {
        if (cancelled || streamGenRef.current !== gen) return;
        const message =
          err instanceof Error ? err.message : "Failed to load session history";
        setError(message);
        setMessages([]);
      }

      if (cancelled || streamGenRef.current !== gen) return;
      if (!eventsUrl) return;
      openEventSource("bootstrap");
    })();

    return () => {
      cancelled = true;
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
  }, [eventsUrl, sessionId, workspaceId, rootPath, handleSseEvent]);

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

  const applyCommandFailure = useCallback(
    (res: AgentCommandResponse | null, fallback: string): boolean => {
      if (!isCommandFailed(res)) return false;
      setError(res?.message?.trim() || fallback);
      setStatus("error");
      return true;
    },
    [],
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
        if (
          applyCommandFailure(
            res,
            "Agent prompt failed (see transcript for details)",
          )
        ) {
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
      } finally {
        sendInFlight.current = false;
      }
    },
    [input, sessionId, runCommand, applyCommandFailure],
  );

  const startWikiRun = useCallback(
    async (options?: { modelProfileId?: string }) => {
      if (!sessionId || sendInFlight.current) {
        return;
      }
      sendInFlight.current = true;
      setError(null);
      setStatus("sending");
      // Clear stale plan from a previous run so the panel does not look "done"
      // before this produce cycle actually finishes analysis/write.
      setPlan(null);
      setPendingGate(null);
      setPhase(null);

      try {
        setStatus("streaming");
        const profileId = options?.modelProfileId?.trim();
        const res = await runCommand({
          type: "start_wiki_run",
          ...(profileId ? { modelProfileId: profileId } : {}),
        });
        if (
          applyCommandFailure(
            res,
            "Failed to start wiki run (see transcript for details)",
          )
        ) {
          return;
        }
        if (res?.runId) {
          setLinkedRunId(res.runId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
      } finally {
        sendInFlight.current = false;
      }
    },
    [sessionId, runCommand, applyCommandFailure],
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
          applyCommandFailure(
            res,
            "Gate resume failed (see transcript for details)",
          )
        ) {
          return;
        }
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
    [sessionId, gateBusy, pendingGate, runCommand, applyCommandFailure],
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

  const focusedStream = useMemo(() => {
    if (!focusAgentId) return null;
    return workStreams[focusAgentId] ?? null;
  }, [focusAgentId, workStreams]);

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
    workStreams,
    focusAgentId,
    setFocusAgentId,
    focusedStream,
  };
}
