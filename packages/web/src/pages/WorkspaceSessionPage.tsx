import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { MessageParts } from "../components/session/MessageParts";
import { extractPendingFromMessages } from "../components/session/decision-types";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceSubnav } from "../components/WorkspaceSubnav";
import {
  cancelRun,
  getOrCreateSession,
  getSession,
  getWorkspace,
  listRuns,
  type OperatorSessionDto,
  type WikiRunPlan,
  type WorkspaceConfig,
} from "../api";
import { workspaceHref } from "../lib/workspace-path";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MessageSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";

function sessionMessagesToUI(
  session: OperatorSessionDto,
): UIMessage[] {
  return session.messages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: m.parts.map((p) => {
      if (p.type === "text" && "text" in p) {
        return { type: "text" as const, text: p.text };
      }
      if (p.type.startsWith("tool-")) {
        const tool = p as {
          type: string;
          toolCallId?: string;
          state?: string;
          input?: unknown;
          output?: unknown;
          errorText?: string;
        };
        return {
          type: tool.type as `tool-${string}`,
          toolCallId: tool.toolCallId ?? tool.type,
          state: (tool.state as "output-available") ?? "output-available",
          input: tool.input,
          output: tool.output,
          errorText: tool.errorText,
        } as UIMessage["parts"][number];
      }
      if (p.type.startsWith("data-")) {
        const dataPart = p as { type: string; id?: string; data?: unknown };
        return {
          type: dataPart.type as `data-${string}`,
          id: dataPart.id,
          data: dataPart.data,
        } as UIMessage["parts"][number];
      }
      return { type: "text" as const, text: JSON.stringify(p) };
    }),
  }));
}

/**
 * Linked run id: prefer latest structured data-run part (live stream),
 * then durable session.workflow (refreshed after stream).
 * Never parse run ids from assistant markdown.
 */
function extractLinkedRunId(
  session: OperatorSessionDto,
  messages: UIMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") {
      continue;
    }
    for (let j = (m.parts ?? []).length - 1; j >= 0; j--) {
      const p = m.parts![j]!;
      if (p.type === "data-run" && p.data && typeof p.data === "object") {
        const runId = (p.data as { runId?: unknown }).runId;
        if (typeof runId === "string" && runId.length > 0) {
          return runId;
        }
      }
    }
  }
  return session.workflow?.linkedRunId;
}

/** Gate step from session.workflow.phase or structured data-choice (no transcript regex). */
function extractGateStep(
  session: OperatorSessionDto,
  messages: UIMessage[],
): "plan-gate" | "publish-gate" {
  if (session.workflow?.phase === "awaiting_publish") {
    return "publish-gate";
  }
  if (session.workflow?.phase === "awaiting_plan") {
    return "plan-gate";
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") {
      continue;
    }
    for (const p of m.parts ?? []) {
      if (
        p.type === "data-choice" &&
        p.data &&
        typeof p.data === "object" &&
        "question" in (p.data as object)
      ) {
        const q = String((p.data as { question?: string }).question ?? "");
        if (/publish/i.test(q)) {
          return "publish-gate";
        }
        if (/plan/i.test(q)) {
          return "plan-gate";
        }
      }
    }
  }
  return "plan-gate";
}

/** Plan from durable session meta or structured data-plan stream parts. */
function extractResumePlan(
  session: OperatorSessionDto,
  messages: UIMessage[],
): WikiRunPlan | undefined {
  if (session.workflow?.plan) {
    return session.workflow.plan;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") {
      continue;
    }
    for (let j = (m.parts ?? []).length - 1; j >= 0; j--) {
      const p = m.parts![j]!;
      if (p.type === "data-plan" && p.data && typeof p.data === "object") {
        const plan = p.data as WikiRunPlan;
        if (plan && Array.isArray(plan.pages)) {
          return plan;
        }
      }
    }
  }
  return undefined;
}

export function WorkspaceSessionPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const kickoff = searchParams.get("kickoff") === "1";

  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [sessionMeta, setSessionMeta] = useState<OperatorSessionDto | null>(
    null,
  );
  const [bootError, setBootError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  // Boot workspace + session
  useEffect(() => {
    if (!id) {
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setBootError(null);
      try {
        const ws = await getWorkspace(id, rootPathHint);
        if (cancelled) {
          return;
        }
        setWorkspace(ws.workspace);
        const { session } = await getOrCreateSession(
          id,
          ws.workspace.rootPath ?? rootPathHint,
        );
        if (cancelled) {
          return;
        }
        setSessionMeta(session);
      } catch (err) {
        if (!cancelled) {
          setBootError(err);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, rootPathHint]);

  return (
    <Layout>
      <div
        data-testid="session-chat-page"
        className="flex h-[calc(100vh-2rem)] max-h-[900px] flex-col gap-3"
      >
        <header className="page-header shrink-0">
          <p className="breadcrumb">
            <Link to="/workspaces">Workspaces</Link>
            <span aria-hidden="true"> / </span>
            <Link to={workspaceHref(id, "", rootPathHint)}>
              {workspace?.name ?? id}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Session</span>
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1>Session</h1>
              <p className="muted text-sm">
                Conversational workspace for wiki planning, tools, and decisions.
                Options are generated by the agent — not fixed product buttons.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {sessionMeta ? (
                <Badge variant="secondary" data-testid="session-status">
                  {sessionMeta.status}
                </Badge>
              ) : null}
              {sessionMeta?.workflow?.linkedRunId ? (
                <Badge variant="outline" data-testid="session-linked-run">
                  run {sessionMeta.workflow.linkedRunId.slice(0, 8)}…
                </Badge>
              ) : null}
              <Link
                to={workspaceHref(id, "/run", rootPathHint)}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                data-testid="session-open-runs"
              >
                Run jobs
              </Link>
            </div>
          </div>
        </header>

        {id ? <WorkspaceSubnav workspaceId={id} /> : null}
        <ErrorBanner
          error={bootError}
          onDismiss={() => {
            setBootError(null);
          }}
        />

        {loading || !sessionMeta || !workspace ? (
          <LoadingState label="Loading session…" />
        ) : (
          <SessionChatPanel
            workspaceId={id}
            workspace={workspace}
            session={sessionMeta}
            rootPathHint={rootPathHint}
            kickoff={kickoff}
            onSessionMetaChange={setSessionMeta}
          />
        )}
      </div>
    </Layout>
  );
}

function SessionChatPanel({
  workspaceId,
  workspace,
  session,
  rootPathHint,
  kickoff,
  onSessionMetaChange,
}: {
  workspaceId: string;
  workspace: WorkspaceConfig;
  session: OperatorSessionDto;
  rootPathHint?: string;
  kickoff?: boolean;
  onSessionMetaChange?: (session: OperatorSessionDto) => void;
}) {
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
   * Mid-stream cancel may leave tool/data-choice parts in local messages;
   * durable finalize also neutralizes them for refresh.
   */
  const [suppressDecisions, setSuppressDecisions] = useState(false);
  const kickoffSent = useRef(false);
  /** Sync guard against rapid double-send before useChat status flips to busy. */
  const sendInFlight = useRef(false);
  /** Tracks prior useChat status so we refresh meta only after a stream ends. */
  const prevChatStatus = useRef<string>("ready");
  const refreshingMeta = useRef(false);
  /** Boot-time messages only — avoid resetting useChat when parent meta refreshes. */
  const bootMessagesRef = useRef<UIMessage[] | null>(null);
  if (bootMessagesRef.current === null) {
    bootMessagesRef.current = sessionMessagesToUI(session);
  }

  const chatApi = useMemo(() => {
    const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(session.id)}/chat`;
    const root = workspace.rootPath ?? rootPathHint;
    if (root) {
      return `${base}?${new URLSearchParams({ rootPath: root }).toString()}`;
    }
    return base;
  }, [workspaceId, session.id, workspace.rootPath, rootPathHint]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: chatApi,
        prepareSendMessagesRequest: ({ messages: msgs, id }) => {
          // AI SDK persistence: only the last message; server loads history.
          const last = msgs[msgs.length - 1];
          let resumeData:
            | { action: "approve" | "deny"; plan?: typeof resumePlan }
            | undefined;
          if (last?.role === "user") {
            for (const p of last.parts ?? []) {
              if (
                p.type === "text" &&
                typeof p.text === "string" &&
                (p.text === "approve" || p.text === "deny")
              ) {
                // Free-text fallback only; primary HITL is structured chips.
                resumeData = { action: p.text };
              }
            }
          }

          const runId = linkedRunId ?? session.workflow?.linkedRunId;
          const step = gateStep;
          const plan = resumePlan ?? session.workflow?.plan;

          if (resumeData && step === "plan-gate" && plan) {
            resumeData = { ...resumeData, plan };
          }

          return {
            body: {
              message: last,
              id: id ?? session.id,
              ...(resumeData && runId
                ? {
                    resumeData,
                    runId,
                    step,
                  }
                : {}),
            },
          };
        },
      }),
    [
      chatApi,
      linkedRunId,
      gateStep,
      resumePlan,
      session.id,
      session.workflow?.linkedRunId,
      session.workflow?.plan,
    ],
  );

  const { messages, sendMessage, status, stop, error, clearError } = useChat({
    id: session.id,
    transport,
    messages: bootMessagesRef.current,
  });

  const isBusy = status === "submitted" || status === "streaming";

  /** Single-flight send: blocks double-click / double-kickoff races. */
  const sendTurn = useCallback(
    (text: string) => {
      if (sendInFlight.current || isBusy) {
        return;
      }
      sendInFlight.current = true;
      setSuppressDecisions(false);
      void Promise.resolve(sendMessage({ text })).finally(() => {
        sendInFlight.current = false;
      });
    },
    [isBusy, sendMessage],
  );

  const pending = useMemo(() => {
    if (suppressDecisions) {
      return null;
    }
    return extractPendingFromMessages(messages);
  }, [messages, suppressDecisions]);

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
  }, [messages, session]);

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
              fresh.workflow?.phase === "done"
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
        // suppressDecisions is only set by explicit Stop (and cleared on sendTurn).
        // Do not toggle it from meta — finalize races would hide legitimate plan chips.
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
    onSessionMetaChange,
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
    sendTurn("generate a wiki plan");
  }, [kickoff, workspace.sources, session.workflow?.phase, status, sendTurn]);

  const choiceOnly = pending?.mode === "choice_only";
  const inputOnly = pending?.mode === "input_only";
  const canType = !choiceOnly;
  const hasSources = (workspace.sources?.length ?? 0) > 0;

  const latestAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") {
        return messages[i]!.id;
      }
    }
    return null;
  }, [messages]);

  const handleChoice = useCallback(
    (optionId: string) => {
      if (isBusy || sendInFlight.current) {
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
      sendTurn(action);
    },
    [isBusy, sendTurn],
  );

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      const text = message.text.trim();
      if (!text || isBusy || choiceOnly || sendInFlight.current) {
        return;
      }
      sendTurn(text);
      setInput("");
    },
    [choiceOnly, isBusy, sendTurn],
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

  return (
    <>
      <ErrorBanner error={error} onDismiss={() => clearError()} />
      <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
        <div className="flex items-center justify-end gap-2 border-b px-3 py-2">
          {linkedRunId ? (
            <Badge variant="outline" data-testid="session-chat-run-id">
              {linkedRunId.slice(0, 8)}…
            </Badge>
          ) : null}
          <Badge variant="secondary" data-testid="session-chat-status">
            {status}
          </Badge>
          {isBusy ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => handleStop()}
              data-testid="session-stop"
            >
              Stop
            </Button>
          ) : null}
        </div>
        <Conversation className="min-h-0" data-testid="session-conversation">
          <ConversationContent className="gap-4 p-4">
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={<MessageSquareIcon className="size-10" />}
                title="Start a wiki conversation"
                description='Try “generate a wiki plan” — then choose a dynamic option or type revision notes.'
              />
            ) : (
              messages.map((message) => (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    <MessageParts
                      message={message}
                      isLatestAssistant={
                        message.id === latestAssistantId && !suppressDecisions
                      }
                      onChoice={handleChoice}
                    />
                  </MessageContent>
                </Message>
              ))
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="border-t p-3">
          {choiceOnly ? (
            <p
              className="mb-2 text-xs text-muted-foreground"
              data-testid="session-composer-locked"
            >
              Select an option above to continue (free text is disabled for this
              step).
            </p>
          ) : null}
          {inputOnly && pending ? (
            <p className="mb-2 text-xs text-muted-foreground">
              {pending.question}
              {pending.inputPlaceholder
                ? ` — ${pending.inputPlaceholder}`
                : ""}
            </p>
          ) : null}
          <PromptInput
            onSubmit={handleSubmit}
            className="w-full"
            data-testid="session-prompt"
          >
            <PromptInputBody>
              <PromptInputTextarea
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
                disabled={!canType || isBusy || !hasSources}
                placeholder={
                  !hasSources
                    ? "Add a source first (Sources tab)"
                    : choiceOnly
                      ? "Select an option above…"
                      : (pending?.inputPlaceholder ?? "Message the wiki agent…")
                }
                data-testid="session-input"
              />
            </PromptInputBody>
            <PromptInputSubmit
              status={isBusy ? "streaming" : "ready"}
              disabled={
                isBusy || choiceOnly || !canType || !input.trim() || !hasSources
              }
              data-testid="session-send"
              onStop={() => handleStop()}
            />
          </PromptInput>
        </div>
      </div>
    </>
  );
}
