/**
 * Session chat: useChat transport, gate resume, slash dispatch, mid-flight catch-up.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import {
  cancelRun,
  getSession,
  listRuns,
  runEventsUrl,
  type OperatorSessionDto,
  type WikiRunPlan,
  type WorkspaceConfig,
} from "../../api";
import { extractPendingFromMessages } from "../../components/session/decision-types";
import { writtenPathsFromMessages } from "../../components/session/session-tool-utils";
import { isKickoffPhrase } from "@okf-wiki/contract";
import {
  clampSlashHighlight,
  filterSessionCommands,
  isSlashMenuOpenQuery,
  parseSessionSlashInput,
  SESSION_COMMANDS,
  sessionSlashHelpMarkdown,
  tabCompleteSlashInput,
  type SessionCommandDef,
} from "../../lib/session-commands";
import {
  appendEphemeralRunLiveLine,
  classifyRunSseForSessionCatchUp,
  mergeSessionCatchUpTimeline,
} from "../../lib/session-catchup";
import {
  extractGateStep,
  extractLinkedRunId,
  extractResumePlan,
  resolveLiveGate,
  sessionMessagesToUI,
} from "./session-extract";

export type SessionSendEnvelope = {
  intent: "start" | "resume" | "chat";
  resumeData?: {
    action: "approve" | "deny" | "revise";
    plan?: WikiRunPlan;
    feedback?: string;
  };
  step?: "plan-gate" | "publish-gate";
  runId?: string;
};

export type UseSessionChatArgs = {
  workspaceId: string;
  workspace: WorkspaceConfig;
  session: OperatorSessionDto;
  rootPathHint?: string;
  kickoff?: boolean;
  onSessionMetaChange?: (session: OperatorSessionDto) => void;
  onNewSession?: () => void;
  onResetSession?: () => void;
  onDeleteSession?: () => void;
};

export function useSessionChat({
  workspaceId,
  workspace,
  session,
  rootPathHint,
  kickoff,
  onSessionMetaChange,
  onNewSession,
  onResetSession,
  onDeleteSession,
}: UseSessionChatArgs) {
  const [input, setInput] = useState("");
  // Structured workflow state — never parse runId from assistant text.
  const [linkedRunId, setLinkedRunId] = useState(
    session.workflow?.linkedRunId as string | undefined,
  );
  const [gateStep, setGateStep] = useState<"plan-gate" | "publish-gate">(
    session.workflow?.phase === "awaiting_publish"
      ? "publish-gate"
      : "plan-gate",
  );
  const [resumePlan, setResumePlan] = useState(session.workflow?.plan);
  /**
   * After explicit Stop, hide decision chips until the next user turn.
   * Mid-stream cancel may leave gate parts in local messages;
   * durable finalize also neutralizes them for refresh.
   */
  const [suppressDecisions, setSuppressDecisions] = useState(false);
  /**
   * After the user picks "Request changes", focus free-text revision feedback
   * instead of immediately resuming the workflow.
   */
  const [awaitingPlanRevise, setAwaitingPlanRevise] = useState(false);
  const kickoffSent = useRef(false);
  /** Sync guard against rapid double-send before useChat status flips to busy. */
  const sendInFlight = useRef(false);
  /**
   * Structured send envelope for the next transport POST (intent + resume).
   * Cleared in prepareSendMessagesRequest so free-text cannot accidentally resume.
   */
  const pendingSendRef = useRef<SessionSendEnvelope | null>(null);
  /** Tracks prior useChat status so we refresh meta only after a stream ends. */
  const prevChatStatus = useRef<string>("ready");
  const refreshingMeta = useRef(false);
  /** Boot-time messages only — avoid resetting useChat when parent meta refreshes. */
  const bootMessagesRef = useRef<UIMessage[] | null>(null);
  if (bootMessagesRef.current === null) {
    bootMessagesRef.current = sessionMessagesToUI(session);
  }
  /** After mount, re-fetch session so refresh mid-flight gets latest journal. */
  const bootResyncDone = useRef(false);

  const chatApi = useMemo(() => {
    const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(session.id)}/chat`;
    const root = workspace.rootPath ?? rootPathHint;
    if (root) {
      return `${base}?${new URLSearchParams({ rootPath: root }).toString()}`;
    }
    return base;
  }, [workspaceId, session.id, workspace.rootPath, rootPathHint]);

  // Refs so prepareSendMessagesRequest sees latest gate without recreating transport.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const linkedRunIdRef = useRef(linkedRunId);
  linkedRunIdRef.current = linkedRunId;
  const resumePlanRef = useRef(resumePlan);
  resumePlanRef.current = resumePlan;
  const gateStepRef = useRef(gateStep);
  gateStepRef.current = gateStep;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: chatApi,
        prepareSendMessagesRequest: ({ messages: msgs, id }) => {
          // AI SDK persistence: only the last message; server loads history.
          const last = msgs[msgs.length - 1];
          const pending = pendingSendRef.current;
          pendingSendRef.current = null;

          const gate = resolveLiveGate(
            sessionRef.current,
            msgs,
            linkedRunIdRef.current,
            resumePlanRef.current,
          );
          const plan = gate.plan ?? resumePlanRef.current;
          const runId =
            pending?.runId ??
            gate.runId ??
            linkedRunIdRef.current ??
            sessionRef.current.workflow?.linkedRunId;

          // Prefer explicit pending envelope (chips / kickoff / revise form).
          if (pending?.intent === "resume" && pending.resumeData && runId) {
            let resumeData = pending.resumeData;
            const step =
              pending.step ??
              (gate.active ? gate.step : gateStepRef.current) ??
              "plan-gate";
            if (
              step === "plan-gate" &&
              plan &&
              (resumeData.action === "approve" || resumeData.action === "revise")
            ) {
              resumeData = { ...resumeData, plan };
            }
            return {
              body: {
                message: last,
                id: id ?? sessionRef.current.id,
                intent: "resume",
                resumeData,
                runId,
                step,
              },
            };
          }

          if (pending?.intent === "start") {
            return {
              body: {
                message: last,
                id: id ?? sessionRef.current.id,
                intent: "start",
              },
            };
          }

          // Free-text at a live plan gate → structured revise (no bare "approve" guess).
          if (
            last?.role === "user" &&
            gate.active &&
            gate.step === "plan-gate" &&
            runId
          ) {
            for (const p of last.parts ?? []) {
              if (p.type === "text" && typeof p.text === "string") {
                const text = p.text.trim();
                if (
                  text &&
                  text !== "approve" &&
                  text !== "deny" &&
                  text.toLowerCase() !== "revise"
                ) {
                  let resumeData: {
                    action: "revise";
                    feedback: string;
                    plan?: WikiRunPlan;
                  } = { action: "revise", feedback: text };
                  if (plan) {
                    resumeData = { ...resumeData, plan };
                  }
                  return {
                    body: {
                      message: last,
                      id: id ?? sessionRef.current.id,
                      intent: "resume",
                      resumeData,
                      runId,
                      step: "plan-gate",
                    },
                  };
                }
              }
            }
          }

          // No forced intent:"chat" — omit intent so the server can still
          // treat kickoff phrases as start (safety net for mislabeled sends).
          return {
            body: {
              message: last,
              id: id ?? sessionRef.current.id,
              ...(pending?.intent ? { intent: pending.intent } : {}),
            },
          };
        },
      }),
    [chatApi],
  );

  const { messages, sendMessage, setMessages, status, stop, error, clearError } =
    useChat({
      id: session.id,
      transport,
      messages: bootMessagesRef.current,
    });

  const isBusy = status === "submitted" || status === "streaming";
  const slashMenuOpen = isSlashMenuOpenQuery(input);
  const slashQuery = slashMenuOpen ? input : "";
  const slashCommands = useMemo(
    () => filterSessionCommands(slashQuery),
    [slashQuery],
  );
  /** Keyboard highlight index inside the open slash palette (Tab / ↑↓). */
  const [slashHighlight, setSlashHighlight] = useState(0);

  useEffect(() => {
    if (!slashMenuOpen) {
      setSlashHighlight(0);
      return;
    }
    setSlashHighlight((i) => clampSlashHighlight(i, slashCommands.length));
  }, [slashMenuOpen, slashCommands]);

  /** Single-flight send: blocks double-click / double-kickoff races. */
  const sendTurn = useCallback(
    (text: string, envelope?: SessionSendEnvelope) => {
      if (sendInFlight.current || isBusy) {
        return;
      }
      sendInFlight.current = true;
      // Never default to intent:"chat" — missing envelope leaves intent unset so
      // the server can still kick off on isKickoffPhrase (defense in depth).
      pendingSendRef.current = envelope ?? null;
      setSuppressDecisions(false);
      setAwaitingPlanRevise(false);
      void Promise.resolve(sendMessage({ text })).finally(() => {
        sendInFlight.current = false;
      });
    },
    [isBusy, sendMessage],
  );

  const showLocalHelp = useCallback(() => {
    const id = `local-help-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id,
        role: "assistant",
        parts: [{ type: "text", text: sessionSlashHelpMarkdown() }],
      },
    ]);
  }, [setMessages]);

  /** Filled after handleStop is defined (slash /stop). */
  const handleStopRef = useRef<(() => void) | null>(null);

  const runLocalCommand = useCallback(
    (action: "help" | "new" | "delete" | "reset" | "stop") => {
      switch (action) {
        case "help":
          showLocalHelp();
          break;
        case "new":
          onNewSession?.();
          break;
        case "delete":
          onDeleteSession?.();
          break;
        case "reset":
          onResetSession?.();
          break;
        case "stop":
          if (isBusy) {
            handleStopRef.current?.();
          }
          break;
        default:
          break;
      }
    },
    [showLocalHelp, onNewSession, onDeleteSession, onResetSession, isBusy],
  );

  const dispatchComposerText = useCallback(
    (raw: string) => {
      const parsed = parseSessionSlashInput(raw);
      if (parsed.kind === "local") {
        runLocalCommand(parsed.action);
        return;
      }
      const phase = session.workflow?.phase ?? "idle";
      const canStart = phase === "idle" || phase === "done";

      if (parsed.kind === "send") {
        const text = parsed.text;
        // Slash /approve /deny → structured resume when a gate is live or phase is gate.
        if (text === "approve" || text === "deny") {
          const gate = resolveLiveGate(
            session,
            messages,
            linkedRunId,
            resumePlan,
          );
          const runId =
            gate.runId ?? linkedRunId ?? session.workflow?.linkedRunId;
          const atGatePhase =
            phase === "awaiting_plan" || phase === "awaiting_publish";
          const pendingLive = extractPendingFromMessages(messages);
          if (runId && (gate.active || atGatePhase || pendingLive)) {
            const step =
              gate.active
                ? gate.step
                : phase === "awaiting_publish"
                  ? "publish-gate"
                  : "plan-gate";
            sendTurn(text, {
              intent: "resume",
              resumeData: { action: text },
              step,
              runId,
            });
            return;
          }
          // No gate — let server return pending_gate / not_kickoff help.
          sendTurn(text);
          return;
        }
        // Kickoff phrases (/generate → "generate a wiki plan") → explicit start.
        if (isKickoffPhrase(text) || isKickoffPhrase(raw)) {
          if (canStart) {
            sendTurn(text, { intent: "start" });
            return;
          }
          // Stuck gate / mid-flight: still send so server returns clear /reset help.
          sendTurn(text, { intent: "start" });
          return;
        }
        sendTurn(text);
        return;
      }
      // Free-text: start if kickoff on idle; else bare send (revise via transport).
      if (isKickoffPhrase(raw)) {
        sendTurn(raw, { intent: "start" });
        return;
      }
      sendTurn(raw);
    },
    [runLocalCommand, sendTurn, session, messages, linkedRunId, resumePlan],
  );

  const applyCommandDef = useCallback(
    (cmd: SessionCommandDef) => {
      setInput("");
      if (cmd.local) {
        runLocalCommand(cmd.local);
        return;
      }
      // Always go through dispatch so intent mapping stays in one place
      // (palette / Tab / suggestions / Enter on slash menu).
      if (cmd.sendText) {
        dispatchComposerText(
          cmd.command.startsWith("/") ? cmd.command : cmd.sendText,
        );
      }
    },
    [runLocalCommand, dispatchComposerText],
  );

  const pending = useMemo(() => {
    if (suppressDecisions) {
      return null;
    }
    // Mid-flight after approve (eager gate-exit writes planning/writing).
    const phase = session.workflow?.phase;
    if (phase === "planning" || phase === "writing") {
      return null;
    }
    return extractPendingFromMessages(messages);
  }, [messages, suppressDecisions, session.workflow?.phase]);

  // Track linkedRunId / gate / plan from structured session state + data parts.
  useEffect(() => {
    const fromStructured = extractLinkedRunId(session, messages);
    if (fromStructured) {
      setLinkedRunId(fromStructured);
    }
    setGateStep(extractGateStep(session, messages));
    const plan = extractResumePlan(session, messages);
    if (plan) {
      setResumePlan(plan);
    }
    // Drop revise-composer mode once we leave the plan gate.
    if (session.workflow?.phase !== "awaiting_plan") {
      setAwaitingPlanRevise(false);
    }
  }, [messages, session]);

  const applyFreshSession = useCallback(
    (fresh: OperatorSessionDto) => {
      onSessionMetaChange?.(fresh);
      if (fresh.workflow?.linkedRunId) {
        setLinkedRunId(fresh.workflow.linkedRunId);
      }
      if (fresh.workflow?.plan) {
        setResumePlan(fresh.workflow.plan);
      }
      if (fresh.workflow?.phase === "awaiting_publish") {
        setGateStep("publish-gate");
      } else if (fresh.workflow?.phase === "awaiting_plan") {
        setGateStep("plan-gate");
      }
      // Catch-up timeline when server journal advanced (refresh / mid-flight).
      // Ephemeral run-live SSE bubbles must not block durable journal updates.
      const next = sessionMessagesToUI(fresh);
      setMessages((prev) =>
        mergeSessionCatchUpTimeline(prev, next, {
          status: fresh.status,
          workflow: fresh.workflow,
        }),
      );
    },
    [onSessionMetaChange, setMessages],
  );

  // Always re-sync from server once on mount (covers hard refresh mid-turn).
  useEffect(() => {
    if (bootResyncDone.current) {
      return;
    }
    bootResyncDone.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getSession(
          workspaceId,
          session.id,
          workspace.rootPath ?? rootPathHint,
        );
        if (!cancelled) {
          applyFreshSession(res.session);
        }
      } catch {
        // keep boot messages
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    workspaceId,
    session.id,
    workspace.rootPath,
    rootPathHint,
    applyFreshSession,
  ]);

  // After a stream finishes, re-fetch session meta so plan / linkedRunId / phase
  // match the server (resume works without a full page reload).
  useEffect(() => {
    const prev = prevChatStatus.current;
    prevChatStatus.current = status;
    const wasBusy = prev === "submitted" || prev === "streaming";
    const nowIdle = status === "ready" || status === "error";
    if (!wasBusy || !nowIdle || refreshingMeta.current) {
      return;
    }
    let cancelled = false;
    refreshingMeta.current = true;
    void (async () => {
      try {
        // Server finalizes on stream flush before response ends; still retry
        // briefly in case of disconnect-fallback finalize on "close".
        let fresh: OperatorSessionDto | null = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 100 * attempt));
          }
          if (cancelled) {
            return;
          }
          try {
            const res = await getSession(
              workspaceId,
              session.id,
              workspace.rootPath ?? rootPathHint,
            );
            fresh = res.session;
            if (
              fresh.workflow?.linkedRunId ||
              fresh.workflow?.phase === "awaiting_plan" ||
              fresh.workflow?.phase === "awaiting_publish" ||
              fresh.workflow?.phase === "done" ||
              fresh.workflow?.phase === "writing" ||
              fresh.workflow?.phase === "planning"
            ) {
              break;
            }
          } catch {
            // retry
          }
        }
        if (cancelled || !fresh) {
          return;
        }
        applyFreshSession(fresh);
      } catch {
        // Non-fatal: data-run / data-plan parts still drive live resume.
      } finally {
        refreshingMeta.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    status,
    workspaceId,
    session.id,
    workspace.rootPath,
    rootPathHint,
    applyFreshSession,
  ]);

  // Mid-flight catch-up after refresh / while write runs in the background:
  // poll session journal + optional run SSE for live log lines.
  useEffect(() => {
    const phase = session.workflow?.phase;
    const midFlight =
      session.status === "running" ||
      phase === "planning" ||
      phase === "writing";
    if (!midFlight || isBusy) {
      return;
    }
    let cancelled = false;
    const root = workspace.rootPath ?? rootPathHint;
    const tick = async () => {
      try {
        const res = await getSession(workspaceId, session.id, root);
        if (cancelled) {
          return;
        }
        applyFreshSession(res.session);
      } catch {
        // best-effort
      }
    };
    void tick();
    // Faster poll while mid-flight so refresh catches progressive checkpoints.
    const pollId = window.setInterval(() => void tick(), 800);

    const runId = linkedRunId ?? session.workflow?.linkedRunId;
    let es: EventSource | null = null;
    if (runId && typeof EventSource !== "undefined") {
      try {
        es = new EventSource(runEventsUrl(workspaceId, runId, root));
        es.onmessage = (msg) => {
          if (cancelled) {
            return;
          }
          try {
            const event = JSON.parse(msg.data) as {
              type?: string;
              message?: string;
              status?: string;
              text?: string;
            };
            const classified = classifyRunSseForSessionCatchUp(event);
            if (classified.action === "ignore") {
              return;
            }
            if (classified.action === "tick") {
              // Status/done/terminal: poll journal only — never chat bubbles.
              // Empty-bus reconnect always sends status "Wiki Run in progress";
              // treating that as a message froze mid-flight catch-up.
              void tick();
              return;
            }
            // Concrete log/part progress (optional; Session path rarely emits).
            setMessages((prev) =>
              appendEphemeralRunLiveLine(
                prev,
                classified.line,
                (id, line) =>
                  ({
                    id,
                    role: "assistant" as const,
                    parts: [{ type: "text" as const, text: line }],
                  }) as UIMessage,
              ),
            );
          } catch {
            // ignore malformed SSE
          }
        };
      } catch {
        // SSE optional
      }
    }

    return () => {
      cancelled = true;
      window.clearInterval(pollId);
      es?.close();
    };
  }, [
    session.status,
    session.workflow?.phase,
    session.workflow?.linkedRunId,
    session.id,
    linkedRunId,
    isBusy,
    workspaceId,
    workspace.rootPath,
    rootPathHint,
    applyFreshSession,
    setMessages,
  ]);

  // Session-first kickoff from Runs page (?kickoff=1).
  useEffect(() => {
    if (!kickoff || kickoffSent.current) {
      return;
    }
    const hasSources = (workspace.sources?.length ?? 0) > 0;
    if (!hasSources) {
      return;
    }
    // Only auto-kick when there is no in-flight workflow.
    const phase = session.workflow?.phase ?? "idle";
    if (phase !== "idle" && phase !== "done") {
      return;
    }
    if (status === "submitted" || status === "streaming" || sendInFlight.current) {
      return;
    }
    kickoffSent.current = true;
    sendTurn("generate a wiki plan", { intent: "start" });
  }, [kickoff, workspace.sources, session.workflow?.phase, status, sendTurn]);

  const choiceOnly = pending?.mode === "choice_only";
  const inputOnly = pending?.mode === "input_only";
  const liveGate = useMemo(
    () => resolveLiveGate(session, messages, linkedRunId, resumePlan),
    [session, messages, linkedRunId, resumePlan],
  );
  const atPlanGate = liveGate.active && liveGate.step === "plan-gate";
  const planReviseMode =
    awaitingPlanRevise ||
    (atPlanGate && pending?.mode === "choice_or_input");
  const canType = !choiceOnly;
  const hasSources = (workspace.sources?.length ?? 0) > 0;
  // Allow typing without sources so slash commands (/help, /new, …) still work.
  const composerDisabled = isBusy || choiceOnly;

  const latestAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") {
        return messages[i]!.id;
      }
    }
    return null;
  }, [messages]);

  /** Plan page checklist progress across the full Session timeline. */
  const sessionWrittenPaths = useMemo(
    () => writtenPathsFromMessages(messages),
    [messages],
  );

  const handleChoice = useCallback(
    (optionId: string) => {
      if (isBusy || sendInFlight.current) {
        return;
      }
      // Request changes: unlock composer for free-text feedback (do not resume yet).
      if (
        optionId === "revise" ||
        optionId === "request_changes" ||
        optionId === "request-changes"
      ) {
        setAwaitingPlanRevise(true);
        // Focus composer so the operator can type feedback immediately.
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLTextAreaElement>(
            '[data-testid="session-input"]',
          );
          el?.focus();
        });
        return;
      }
      // Option ids are workflow resume actions: approve | deny (and aliases).
      const action =
        optionId === "approve" ||
        optionId === "approve_write" ||
        optionId === "publish_now"
          ? "approve"
          : optionId === "deny" ||
              optionId === "reject_plan" ||
              optionId === "keep_staging"
            ? "deny"
            : optionId;
      if (action !== "approve" && action !== "deny") {
        sendTurn(optionId);
        return;
      }
      // Chips visible ⇒ treat as resume when we have a run id, even if phase
      // meta lags (do not require gate.active — that caused silent chat no-ops).
      const gate = resolveLiveGate(
        session,
        messages,
        linkedRunId,
        resumePlan,
      );
      const runId = gate.runId ?? linkedRunId ?? session.workflow?.linkedRunId;
      const phase = session.workflow?.phase ?? "idle";
      const atGatePhase =
        phase === "awaiting_plan" || phase === "awaiting_publish";
      const pendingLive = extractPendingFromMessages(messages);
      if (!runId) {
        sendTurn(action);
        return;
      }
      if (!gate.active && !atGatePhase && !pendingLive) {
        sendTurn(action);
        return;
      }
      const step =
        gate.active
          ? gate.step
          : phase === "awaiting_publish"
            ? "publish-gate"
            : pendingLive?.gate === "publication"
              ? "publish-gate"
              : "plan-gate";
      sendTurn(action, {
        intent: "resume",
        resumeData: { action },
        step,
        runId,
      });
    },
    [isBusy, sendTurn, session, messages, linkedRunId, resumePlan],
  );

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      const text = message.text.trim();
      if (!text || isBusy || choiceOnly || sendInFlight.current) {
        return;
      }
      // If slash palette is open, Enter runs the highlighted match.
      if (isSlashMenuOpenQuery(text) && slashCommands.length > 0) {
        const idx = clampSlashHighlight(slashHighlight, slashCommands.length);
        applyCommandDef(slashCommands[idx]!);
        return;
      }
      dispatchComposerText(text);
      setInput("");
    },
    [
      choiceOnly,
      isBusy,
      slashCommands,
      slashHighlight,
      applyCommandDef,
      dispatchComposerText,
    ],
  );

  const handleComposerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!slashMenuOpen || slashCommands.length === 0) {
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const { nextInput, nextHighlight } = tabCompleteSlashInput(
          e.currentTarget.value,
          slashCommands,
          slashHighlight,
        );
        setInput(nextInput);
        setSlashHighlight(nextHighlight);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSlashHighlight((i) =>
          clampSlashHighlight(i + 1, slashCommands.length),
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSlashHighlight((i) =>
          clampSlashHighlight(i - 1, slashCommands.length),
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        setSlashHighlight(0);
      }
    },
    [slashMenuOpen, slashCommands, slashHighlight],
  );

  /**
   * Explicit Stop: abort the client chat stream AND cancel the linked Wiki Run.
   * HTTP disconnect alone must not cancel (server tees + drains for durability).
   * Immediately hide decision chips so the user is not stuck approving a cancelled run.
   *
   * Run id may be missing/stale before the first data-run chunk (new kickoff while
   * session.workflow still points at a prior terminal run). Fall back to listing
   * cancellable runs owned by this session (eager server register sets sessionId).
   */
  const handleStop = useCallback(() => {
    setSuppressDecisions(true);
    stop();
    const hinted = linkedRunId ?? session.workflow?.linkedRunId;
    const root = workspace.rootPath ?? rootPathHint;
    void (async () => {
      const tryCancel = async (runId: string): Promise<boolean> => {
        try {
          await cancelRun(workspaceId, runId, root);
          return true;
        } catch {
          return false;
        }
      };
      if (hinted && (await tryCancel(hinted))) {
        return;
      }
      try {
        const { runs } = await listRuns(workspaceId, root);
        const active = runs.find(
          (r) =>
            r.sessionId === session.id &&
            (r.status === "running" ||
              r.status === "awaiting_plan" ||
              r.status === "awaiting_publication"),
        );
        if (active) {
          await tryCancel(active.runId);
        }
      } catch {
        // Best-effort: run may not be registered yet or already terminal.
      }
    })();
  }, [
    stop,
    linkedRunId,
    session.workflow?.linkedRunId,
    session.id,
    workspaceId,
    workspace.rootPath,
    rootPathHint,
  ]);

  handleStopRef.current = handleStop;

  const suggestionChips = useMemo(() => {
    if (!hasSources) {
      return [] as string[];
    }
    return ["/generate", "/help", "/reset"];
  }, [hasSources]);

  const openSlashMenu = useCallback(() => {
    if (choiceOnly) {
      return;
    }
    setInput((prev) => (prev.startsWith("/") ? prev : "/"));
  }, [choiceOnly]);

  const onSuggestionClick = useCallback(
    (value: string) => {
      if (value.startsWith("/")) {
        const def = SESSION_COMMANDS.find((c) => c.command === value);
        if (def) {
          applyCommandDef(def);
          return;
        }
        dispatchComposerText(value);
        return;
      }
      dispatchComposerText(value);
    },
    [applyCommandDef, dispatchComposerText],
  );

  return {
    messages,
    status,
    error,
    clearError,
    input,
    setInput,
    linkedRunId,
    suppressDecisions,
    pending,
    choiceOnly,
    inputOnly,
    planReviseMode,
    canType,
    hasSources,
    composerDisabled,
    isBusy,
    latestAssistantId,
    sessionWrittenPaths,
    slashMenuOpen,
    slashCommands,
    slashHighlight,
    setSlashHighlight,
    suggestionChips,
    handleChoice,
    handleSubmit,
    handleComposerKeyDown,
    handleStop,
    applyCommandDef,
    openSlashMenu,
    onSuggestionClick,
  };
}
