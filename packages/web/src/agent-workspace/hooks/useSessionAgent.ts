/**
 * Client hook for the Pi Agent Workspace (ADR 0030 / 0031 WP6).
 *
 * Live transport:
 * - POST AgentCommand → /command
 * - EventSource ← /events (product injects + parent Pi AgentSession events)
 *
 * Projection:
 * - Pi message snapshots → reducePiEvent (no string-delta machine)
 * - Product whitelist only (run_link | run_phase | gate | plan_progress | defects)
 * - Produce units: wiki_produce tool_execution_* details + cold produceUnits
 *   (last-by-unitId fold; not work_unit / not product inject)
 * - Cold load: Pi history content blocks + thin product meta + produceUnits
 *
 * Command failures use `ok === false` / `status === "failed"` (not string matching).
 */

import type {
  AgentCommand,
  AgentCommandResponse,
  AgentSseEvent,
  ProductSseEvent,
  WikiRunPlan,
} from "@okf-wiki/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentSessionCommand,
  agentSessionEventsUrl,
  getAgentSession,
  type PiHistoryMessage,
} from "../../api";
import { isCommandFailed } from "./command-result";
import { isRecord } from "./project/format";
import {
  type AgentMessage,
  type AgentToolCall,
  applyProductEvent,
  compactToolInput,
  createPiStreamState,
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  foldProduceToolDetails,
  foldProduceUnit,
  formatToolResultText,
  isTerminalOrWaitingPhase,
  makeId,
  type PiStreamState,
  type ProduceUnit,
  type ProductSseLike,
  parseProduceUnitPayload,
  produceUnitFromToolPayload,
  reducePiEvent,
  seedProduceUnits,
  viewMessages,
} from "./project-agent-events";

export { isCommandFailed } from "./command-result";
export type {
  AgentMessage,
  AgentProductMeta,
  AgentToolCall,
  ProduceUnit,
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

/** Thin product state (not a body channel). */
export type ProductViewState = {
  phase: string | null;
  runId: string | null;
  pendingGate: PendingGate | null;
  plan: WikiRunPlan | null;
  pages: Array<{ path: string; status: string }> | null;
  defects: { round: number; clean: boolean; defectCount: number; summary?: string } | null;
  busy: boolean;
};

export type UseSessionAgentResult = {
  messages: AgentMessage[];
  /** Latest assistant snapshot while streaming (also folded into messages). */
  streamingMessage: AgentMessage | null;
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
  /** Latest product run phase (from SSE / cold meta). */
  phase: string | null;
  /** Linked product run id (from run_link / run_phase). */
  linkedRunId: string | null;
  /** Plan from the latest product gate inject / cold meta. */
  plan: WikiRunPlan | null;
  /** Active HITL gate, if any. */
  pendingGate: PendingGate | null;
  /** True while a resume_gate command is in flight. */
  gateBusy: boolean;
  /** Thin product snapshot (phase / gate / plan progress / defects). */
  product: ProductViewState;
  /**
   * Parent-visible produce units (last-by-unitId fold from SSE + cold load).
   * Not workUnits / not product inject.
   */
  produceUnits: ProduceUnit[];
};

const RECONNECT_MS = 1500;

function nowIso(): string {
  return new Date().toISOString();
}

function eventSequence(event: AgentSseEvent): number | undefined {
  if ("sequence" in event && typeof event.sequence === "number") {
    return event.sequence;
  }
  return undefined;
}

function asProductSseLike(event: ProductSseEvent | ProductSseLike): ProductSseLike {
  return event as ProductSseLike;
}

function toolCallsFromContent(content: unknown): AgentToolCall[] {
  if (!Array.isArray(content)) return [];
  const tools: AgentToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    const id = typeof block.id === "string" ? block.id : makeId("tool");
    const name = typeof block.name === "string" ? block.name : "tool";
    const args = "arguments" in block ? block.arguments : undefined;
    tools.push({
      id,
      name,
      input: compactToolInput(args),
      status: "pending",
    });
  }
  return tools;
}

/**
 * Map Pi-native history messages (content blocks) → thin UI view model.
 * toolResult rows attach output onto the matching toolCall on the prior assistant.
 */
export function piHistoryToMessages(rows: PiHistoryMessage[] | undefined): AgentMessage[] {
  if (!rows?.length) return [];
  const out: AgentMessage[] = [];
  let seq = 0;

  for (const row of rows) {
    seq += 1;
    const createdAt =
      typeof row.timestamp === "number" ? new Date(row.timestamp).toISOString() : nowIso();

    if (row.role === "user") {
      const text =
        typeof row.content === "string"
          ? row.content
          : extractMessageText({ content: row.content });
      out.push({
        id: `hist_user_${seq}`,
        role: "user",
        content: text,
        createdAt,
        status: "done",
      });
      continue;
    }

    if (row.role === "assistant") {
      const text = extractMessageText(row);
      const thinking = extractMessageThinking(row);
      const err = extractAssistantError(row);
      const tools = toolCallsFromContent(row.content);
      out.push({
        id: `hist_asst_${seq}`,
        role: "assistant",
        content: text || (err.isError ? (err.errorMessage ?? "") : ""),
        thinking: thinking || undefined,
        thinkingStatus: thinking ? "done" : undefined,
        createdAt,
        tools: tools.length > 0 ? tools : undefined,
        status: err.isError ? "error" : "done",
        errorMessage: err.errorMessage,
      });
      continue;
    }

    if (row.role === "toolResult") {
      const toolCallId = typeof row.toolCallId === "string" ? row.toolCallId : "";
      if (!toolCallId) continue;
      const output = formatToolResultText(row.content) ?? formatToolResultText(row);
      const isError = row.isError === true;
      // Attach onto nearest prior assistant that has this toolCall.
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const m = out[i]!;
        if (m.role !== "assistant" || !m.tools?.length) continue;
        const tIdx = m.tools.findIndex((t) => t.id === toolCallId);
        if (tIdx < 0) continue;
        const tools = m.tools.slice();
        tools[tIdx] = {
          ...tools[tIdx]!,
          output: output ?? tools[tIdx]!.output,
          status: isError ? "error" : "done",
          name:
            typeof row.toolName === "string" && row.toolName.trim()
              ? row.toolName
              : tools[tIdx]!.name,
        };
        out[i] = { ...m, tools };
        break;
      }
    }
  }

  return out;
}

export function useSessionAgent({
  workspaceId,
  sessionId,
  rootPath,
}: UseSessionAgentArgs): UseSessionAgentResult {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<AgentMessage | null>(null);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [lastCommandResponse, setLastCommandResponse] = useState<AgentCommandResponse | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [linkedRunId, setLinkedRunId] = useState<string | null>(null);
  const [plan, setPlan] = useState<WikiRunPlan | null>(null);
  const [pendingGate, setPendingGate] = useState<PendingGate | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [planProgressPages, setPlanProgressPages] = useState<Array<{
    path: string;
    status: string;
  }> | null>(null);
  const [defects, setDefects] = useState<ProductViewState["defects"]>(null);
  const [productBusy, setProductBusy] = useState(false);
  const [produceUnits, setProduceUnits] = useState<ProduceUnit[]>([]);

  const sendInFlight = useRef(false);
  const planRef = useRef<WikiRunPlan | null>(null);
  const linkedRunIdRef = useRef<string | null>(null);
  planRef.current = plan;
  linkedRunIdRef.current = linkedRunId;
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSequenceRef = useRef<number>(-1);
  const streamStateRef = useRef<PiStreamState>(createPiStreamState());
  /** Generation counter so stale reconnects do not reopen closed sessions. */
  const streamGenRef = useRef(0);

  const eventsUrl = useMemo(() => {
    if (!sessionId) return null;
    return agentSessionEventsUrl(workspaceId, sessionId, rootPath);
  }, [workspaceId, sessionId, rootPath]);

  const publishStream = useCallback((state: PiStreamState) => {
    streamStateRef.current = state;
    setMessages(viewMessages(state));
    setStreamingMessage(state.streamingMessage);
  }, []);

  const handleSseEvent = useCallback(
    (raw: unknown) => {
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
        // Product strips live on the finalized timeline (not in Pi stream state body).
        setMessages((prev) => {
          // Drop streaming tail, apply product, re-append streaming if any.
          const stream = streamStateRef.current.streamingMessage;
          const base = stream ? prev.filter((m) => m.id !== stream.id) : prev;
          const next = applyProductEvent(base, asProductSseLike(product));
          streamStateRef.current = {
            ...streamStateRef.current,
            messages: next,
          };
          return stream ? [...next, stream] : next;
        });

        if (product.kind === "run_phase") {
          setPhase(product.phase);
          if (product.runId) setLinkedRunId(product.runId);
          if (isTerminalOrWaitingPhase(product.phase)) {
            setStatus((s) => (s === "error" ? s : "idle"));
            setProductBusy(false);
          } else {
            setStatus("streaming");
            setProductBusy(true);
          }
          if (product.phase !== "awaiting_plan" && product.phase !== "awaiting_publish") {
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
            typeof product.question === "string" && product.question.startsWith("resume_gate ");
          if (!isResumeEcho && product.gate) {
            setPendingGate({
              gate: product.gate,
              runId: product.runId,
              question: product.question,
              plan: product.plan,
              pages: product.pages,
            });
            setStatus((s) => (s === "error" ? s : "idle"));
            setProductBusy(false);
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
        } else if (product.kind === "plan_progress") {
          setPlanProgressPages(
            Array.isArray(product.pages)
              ? product.pages.map((p) =>
                  typeof p === "string"
                    ? { path: p, status: "pending" }
                    : { path: p.path, status: p.status },
                )
              : null,
          );
        } else if (product.kind === "defects") {
          setDefects({
            round: product.round,
            clean: product.clean,
            defectCount: product.defectCount,
            summary: product.summary,
          });
        }
        return;
      }

      if (event.source === "pi") {
        const kind = event.kind;

        // Official parent wiki_produce tool partials / result details.
        if (
          kind === "tool_execution_update" ||
          kind === "tool_execution_end" ||
          kind === "tool_execution_start"
        ) {
          const payload = event.payload;
          const toolName =
            isRecord(payload) && typeof payload.toolName === "string" ? payload.toolName : "";
          if (toolName === "wiki_produce" || kind !== "tool_execution_start") {
            const raw =
              isRecord(payload) && kind === "tool_execution_end"
                ? payload.result
                : isRecord(payload)
                  ? payload.partialResult
                  : undefined;
            const unit =
              kind === "tool_execution_start"
                ? {
                    role: "root" as const,
                    status: "running" as const,
                    unitId: "root",
                    task: "wiki_produce",
                  }
                : produceUnitFromToolPayload(raw);
            if (unit) {
              setProduceUnits((prev) =>
                kind === "tool_execution_start"
                  ? foldProduceUnit(prev, unit)
                  : foldProduceToolDetails(prev, unit),
              );
            }
          }
          // Fall through to reducePiEvent for tool chrome on the assistant row.
        }

        // Legacy custom-entry frames (mid-run durability); still fold if present.
        if (kind === "okf.produce_progress") {
          const unit = parseProduceUnitPayload(event.payload);
          if (unit) {
            setProduceUnits((prev) => foldProduceUnit(prev, unit));
          }
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
          const msg = isRecord(payload) && isRecord(payload.message) ? payload.message : null;
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

        const next = reducePiEvent(streamStateRef.current, kind, event.payload);
        publishStream(next);
      }
    },
    [publishStream],
  );

  // Bootstrap: reset → await cold history → open SSE.
  // On first connect, skip ring-buffer replay of parent Pi (only advance
  // sequence until the server hello heartbeat) so history + SSE do not
  // double-apply the same turn. Product frames from the buffer still apply
  // so refresh mid-wiki-run restores phase / gate strips.
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
    setPlanProgressPages(null);
    setDefects(null);
    setProductBusy(false);
    setProduceUnits([]);
    setStreamingMessage(null);
    sendInFlight.current = false;
    lastSequenceRef.current = -1;
    streamStateRef.current = createPiStreamState();

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

      // Bootstrap: skip parent-chat Pi frames that would double JSONL history.
      // Reconnect: prefer sequence filter; if lastSequence was never seeded
      // (empty bus at first connect) treat the ring dump like bootstrap so we
      // do not re-project a completed turn on top of hist_* rows.
      let skipChatPiUntilHello =
        mode === "bootstrap" || (mode === "reconnect" && lastSequenceRef.current < 0);

      // Ask the server to omit already-seen bus frames when possible.
      const after = lastSequenceRef.current;
      const streamUrl =
        after >= 0
          ? `${eventsUrl}${eventsUrl.includes("?") ? "&" : "?"}afterSequence=${after}`
          : eventsUrl;

      const es = new EventSource(streamUrl);
      esRef.current = es;

      es.onmessage = (msg) => {
        if (streamGenRef.current !== gen) return;
        try {
          const parsed: unknown = JSON.parse(msg.data);
          if (!isRecord(parsed)) return;

          if (skipChatPiUntilHello) {
            if (parsed.source === "server" && parsed.kind === "heartbeat") {
              const seq = eventSequence(parsed as AgentSseEvent);
              if (seq !== undefined && seq > lastSequenceRef.current) {
                lastSequenceRef.current = seq;
              }
              skipChatPiUntilHello = false;
              return;
            }
            // Product timeline is not in Pi JSONL history.
            if (parsed.source === "product") {
              handleSseEvent(parsed);
              return;
            }
            // Live produce units are not in message history (only settle custom
            // entries seed cold produceUnits). Apply ring-buffer patches.
            if (parsed.source === "pi" && parsed.kind === "okf.produce_progress") {
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

        const timeline = piHistoryToMessages(snap.messages);
        streamStateRef.current = createPiStreamState(timeline);
        setMessages(timeline);
        setStreamingMessage(null);

        // Cold produce units from durable okf.produce_progress custom entries.
        const coldUnits = seedProduceUnits(snap.produceUnits ?? snap.product?.produceUnits ?? []);
        setProduceUnits(coldUnits);

        const restoredRunId =
          typeof snap.product?.runId === "string" ? snap.product.runId : undefined;
        const restoredPlan = snap.product?.plan ?? null;

        if (restoredRunId) setLinkedRunId(restoredRunId);
        if (snap.product?.phase) setPhase(snap.product.phase);
        if (restoredPlan) setPlan(restoredPlan);
        if (snap.product?.pendingGate?.gate) {
          setPendingGate({
            gate: snap.product.pendingGate.gate,
            runId: restoredRunId ?? snap.product.runId,
            plan: snap.product.pendingGate.plan ?? restoredPlan ?? undefined,
            pages: snap.product.pendingGate.pages,
          });
        }

        // Thin phase strip when meta has phase but timeline has no product card yet.
        if (snap.product?.phase) {
          const phase = snap.product.phase as
            | "idle"
            | "planning"
            | "awaiting_plan"
            | "writing"
            | "awaiting_publish"
            | "done"
            | "failed"
            | "cancelled";
          if (phase !== "idle") {
            const withPhase = applyProductEvent(timeline, {
              kind: "run_phase",
              phase,
              runId: restoredRunId ?? snap.product?.runId,
            });
            streamStateRef.current = createPiStreamState(withPhase);
            setMessages(withPhase);
          }
        }

        // Restore streaming chrome when a wiki run / produce is still live.
        const phase = snap.product?.phase;
        const runStatus = snap.product?.runStatus;
        const busy = snap.product?.busy === true;
        setProductBusy(busy);
        const phaseBusy = Boolean(phase) && !isTerminalOrWaitingPhase(phase);
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
        const message = err instanceof Error ? err.message : "Failed to load session history";
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
      const res = await agentSessionCommand(workspaceId, sessionId, command, rootPath);
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
      setMessages((prev) => {
        const next = [...prev, userMsg];
        streamStateRef.current = {
          ...streamStateRef.current,
          messages: streamStateRef.current.streamingMessage
            ? next.filter((m) => m.id !== streamStateRef.current.streamingMessage!.id)
            : next,
        };
        return next;
      });

      try {
        setStatus("streaming");
        const res = await runCommand({ type: "prompt", text: body });
        if (applyCommandFailure(res, "Agent prompt failed (see transcript for details)")) {
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
      setPlanProgressPages(null);
      setDefects(null);
      setProduceUnits([]);

      try {
        setStatus("streaming");
        setProductBusy(true);
        const profileId = options?.modelProfileId?.trim();
        const res = await runCommand({
          type: "start_wiki_run",
          ...(profileId ? { modelProfileId: profileId } : {}),
        });
        if (applyCommandFailure(res, "Failed to start wiki run (see transcript for details)")) {
          setProductBusy(false);
          return;
        }
        if (res?.runId) {
          setLinkedRunId(res.runId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
        setProductBusy(false);
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
        const runId = input.runId ?? pendingGate?.runId ?? linkedRunIdRef.current ?? undefined;
        const planForApprove =
          input.gate === "plan" && input.action === "approve"
            ? (pendingGate?.plan ?? planRef.current ?? undefined)
            : undefined;
        const res = await runCommand({
          type: "resume_gate",
          gate: input.gate,
          action: input.action,
          ...(input.feedback?.trim() ? { feedback: input.feedback.trim() } : {}),
          ...(planForApprove ? { plan: planForApprove } : {}),
          ...(runId ? { runId } : {}),
        });
        if (applyCommandFailure(res, "Gate resume failed (see transcript for details)")) {
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
    setProductBusy(false);
    const aborted: AgentMessage = {
      id: makeId("sys"),
      role: "system",
      content: "Aborted.",
      createdAt: nowIso(),
      status: "aborted",
    };
    const base = streamStateRef.current.messages;
    streamStateRef.current = {
      messages: [...base, aborted],
      streamingMessage: null,
      lastAssistantId: streamStateRef.current.lastAssistantId,
      turnActive: false,
    };
    setStreamingMessage(null);
    setMessages(viewMessages(streamStateRef.current));
  }, [sessionId, runCommand]);

  const clearError = useCallback(() => setError(null), []);

  const product: ProductViewState = useMemo(
    () => ({
      phase,
      runId: linkedRunId,
      pendingGate,
      plan,
      pages: planProgressPages,
      defects,
      busy: productBusy || status === "streaming" || status === "sending",
    }),
    [phase, linkedRunId, pendingGate, plan, planProgressPages, defects, productBusy, status],
  );

  return {
    messages,
    streamingMessage,
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
    product,
    produceUnits,
  };
}
