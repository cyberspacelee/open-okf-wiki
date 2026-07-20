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
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
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
  createSession,
  getOrCreateSession,
  getSession,
  getWorkspace,
  listRuns,
  listSessions,
  type OperatorSessionDto,
  type OperatorSessionSummary,
  type WikiRunPlan,
  type WorkspaceConfig,
} from "../api";
import { useI18n } from "../i18n";
import { workspaceHref } from "../lib/workspace-path";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MessageSquareIcon, PlusIcon } from "lucide-react";
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

function summaryFromSession(session: OperatorSessionDto): OperatorSessionSummary {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    pending: session.pending,
    workflow: session.workflow,
  };
}

function upsertSessionSummary(
  list: OperatorSessionSummary[],
  summary: OperatorSessionSummary,
): OperatorSessionSummary[] {
  const next = list.filter((s) => s.id !== summary.id);
  next.push(summary);
  next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return next;
}

function formatSessionLabel(session: OperatorSessionSummary): string {
  const when = session.updatedAt.slice(0, 16).replace("T", " ");
  return `${session.title} · ${when}`;
}

export function WorkspaceSessionPage() {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const kickoff = searchParams.get("kickoff") === "1";

  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [sessionMeta, setSessionMeta] = useState<OperatorSessionDto | null>(
    null,
  );
  const [sessionList, setSessionList] = useState<OperatorSessionSummary[]>([]);
  const [bootError, setBootError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [creating, setCreating] = useState(false);

  const rootPath = workspace?.rootPath ?? rootPathHint;

  // Boot workspace + current session + history list
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
        const root = ws.workspace.rootPath ?? rootPathHint;
        const [{ session }, listRes] = await Promise.all([
          getOrCreateSession(id, root),
          listSessions(id, root),
        ]);
        if (cancelled) {
          return;
        }
        setSessionMeta(session);
        setSessionList(
          upsertSessionSummary(listRes.sessions, summaryFromSession(session)),
        );
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

  const newestSessionId = sessionList[0]?.id;
  const readOnly =
    sessionMeta != null &&
    newestSessionId != null &&
    sessionMeta.id !== newestSessionId;

  const handleSessionMetaChange = useCallback((session: OperatorSessionDto) => {
    setSessionMeta(session);
    setSessionList((prev) =>
      upsertSessionSummary(prev, summaryFromSession(session)),
    );
  }, []);

  const handleSwitchSession = useCallback(
    async (sessionId: string) => {
      if (!id || !sessionId || sessionId === sessionMeta?.id || switching) {
        return;
      }
      setSwitching(true);
      setBootError(null);
      try {
        const { session } = await getSession(id, sessionId, rootPath);
        setSessionMeta(session);
        setSessionList((prev) =>
          upsertSessionSummary(prev, summaryFromSession(session)),
        );
      } catch (err) {
        setBootError(err);
      } finally {
        setSwitching(false);
      }
    },
    [id, rootPath, sessionMeta?.id, switching],
  );

  const handleNewSession = useCallback(async () => {
    if (!id || creating) {
      return;
    }
    setCreating(true);
    setBootError(null);
    try {
      const { session } = await createSession(id, undefined, rootPath);
      setSessionMeta(session);
      setSessionList((prev) =>
        upsertSessionSummary(prev, summaryFromSession(session)),
      );
    } catch (err) {
      setBootError(err);
    } finally {
      setCreating(false);
    }
  }, [id, creating, rootPath]);

  const handleSwitchToLatest = useCallback(() => {
    if (newestSessionId) {
      void handleSwitchSession(newestSessionId);
    }
  }, [newestSessionId, handleSwitchSession]);

  const sessionSelectItems = useMemo(
    () =>
      sessionList.map((s) => ({
        value: s.id,
        label: formatSessionLabel(s),
      })),
    [sessionList],
  );

  return (
    <Layout>
      <div
        data-testid="session-chat-page"
        className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-hidden h-[calc(100vh-3rem)] max-h-[960px]"
      >
        <header className="page-header shrink-0">
          <p className="breadcrumb">
            <Link to="/workspaces">{t.session.breadcrumbWorkspaces}</Link>
            <span aria-hidden="true"> / </span>
            <Link to={workspaceHref(id, "", rootPathHint)}>
              {workspace?.name ?? id}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>{t.session.breadcrumb}</span>
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1>{t.session.title}</h1>
              <p className="muted text-sm">{t.session.description}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="flex flex-wrap items-center gap-2"
                data-testid="session-list"
              >
                {sessionMeta && sessionList.length > 0 ? (
                  <Select
                    value={sessionMeta.id}
                    onValueChange={(value) => {
                      if (typeof value === "string" && value) {
                        void handleSwitchSession(value);
                      }
                    }}
                    items={sessionSelectItems}
                    disabled={switching || creating || loading}
                  >
                    <SelectTrigger
                      size="sm"
                      className="min-w-[12rem] max-w-[18rem]"
                      data-testid="session-select"
                      aria-label={t.session.switchSession}
                    >
                      <SelectValue placeholder={t.session.sessions} />
                    </SelectTrigger>
                    <SelectContent>
                      {sessionList.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {formatSessionLabel(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleNewSession()}
                  disabled={creating || loading || switching}
                  data-testid="session-new"
                >
                  <PlusIcon className="size-3.5" aria-hidden />
                  {creating ? t.session.creatingSession : t.session.newSession}
                </Button>
              </div>
              {sessionMeta ? (
                <Badge variant="secondary" data-testid="session-status">
                  {sessionMeta.status}
                </Badge>
              ) : null}
              {sessionMeta?.workflow?.linkedRunId ? (
                <Badge variant="outline" data-testid="session-linked-run">
                  {t.session.runPrefix}{" "}
                  {sessionMeta.workflow.linkedRunId.slice(0, 8)}…
                </Badge>
              ) : null}
              <Link
                to={workspaceHref(id, "/run", rootPathHint)}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                data-testid="session-open-runs"
              >
                {t.session.openRuns}
              </Link>
            </div>
          </div>
        </header>

        {id ? (
          <div className="shrink-0">
            <WorkspaceSubnav workspaceId={id} />
          </div>
        ) : null}
        <ErrorBanner
          error={bootError}
          onDismiss={() => {
            setBootError(null);
          }}
        />

        {loading || !sessionMeta || !workspace ? (
          <LoadingState label={t.session.loading} />
        ) : (
          <SessionChatPanel
            key={sessionMeta.id}
            workspaceId={id}
            workspace={workspace}
            session={sessionMeta}
            rootPathHint={rootPathHint}
            kickoff={kickoff && !readOnly}
            readOnly={readOnly}
            onSessionMetaChange={handleSessionMetaChange}
            onNewSession={() => void handleNewSession()}
            onSwitchToLatest={handleSwitchToLatest}
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
  readOnly = false,
  onSessionMetaChange,
  onNewSession,
  onSwitchToLatest,
}: {
  workspaceId: string;
  workspace: WorkspaceConfig;
  session: OperatorSessionDto;
  rootPathHint?: string;
  kickoff?: boolean;
  readOnly?: boolean;
  onSessionMetaChange?: (session: OperatorSessionDto) => void;
  onNewSession?: () => void;
  onSwitchToLatest?: () => void;
}) {
  const { t } = useI18n();
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
      if (readOnly || sendInFlight.current || isBusy) {
        return;
      }
      sendInFlight.current = true;
      setSuppressDecisions(false);
      void Promise.resolve(sendMessage({ text })).finally(() => {
        sendInFlight.current = false;
      });
    },
    [isBusy, readOnly, sendMessage],
  );

  const pending = useMemo(() => {
    if (suppressDecisions || readOnly) {
      return null;
    }
    return extractPendingFromMessages(messages);
  }, [messages, suppressDecisions, readOnly]);

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
    if (readOnly || !kickoff || kickoffSent.current) {
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
  }, [kickoff, readOnly, workspace.sources, session.workflow?.phase, status, sendTurn]);

  const choiceOnly = pending?.mode === "choice_only";
  const inputOnly = pending?.mode === "input_only";
  const canType = !readOnly && !choiceOnly;
  const hasSources = (workspace.sources?.length ?? 0) > 0;
  const composerDisabled = readOnly || isBusy || choiceOnly || !hasSources;

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
      if (readOnly || isBusy || sendInFlight.current) {
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
    [isBusy, readOnly, sendTurn],
  );

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      const text = message.text.trim();
      if (!text || readOnly || isBusy || choiceOnly || sendInFlight.current) {
        return;
      }
      sendTurn(text);
      setInput("");
    },
    [choiceOnly, isBusy, readOnly, sendTurn],
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
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
        data-testid="session-chat-shell"
      >
        <div className="flex shrink-0 items-center justify-end gap-2 border-b px-3 py-2">
          {linkedRunId ? (
            <Badge variant="outline" data-testid="session-chat-run-id">
              {linkedRunId.slice(0, 8)}…
            </Badge>
          ) : null}
          <Badge variant="secondary" data-testid="session-chat-status">
            {status}
          </Badge>
          {isBusy && !readOnly ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => handleStop()}
              data-testid="session-stop"
            >
              {t.session.stop}
            </Button>
          ) : null}
        </div>
        <Conversation
          className="min-h-0 flex-1"
          data-testid="session-conversation"
        >
          <ConversationContent className="gap-4 p-4">
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={<MessageSquareIcon className="size-10" />}
                title={t.session.emptyTitle}
                description={t.session.emptyDescription}
              />
            ) : (
              messages.map((message) => (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    <MessageParts
                      message={message}
                      isLatestAssistant={
                        !readOnly &&
                        message.id === latestAssistantId &&
                        !suppressDecisions
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

        <div className="shrink-0 border-t p-3">
          {readOnly ? (
            <div
              className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/40 px-3 py-2"
              data-testid="session-readonly-banner"
            >
              <p className="text-xs text-muted-foreground">
                {t.session.readOnlyHistory}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onSwitchToLatest}
                  data-testid="session-switch-latest"
                >
                  {t.session.switchToLatest}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={onNewSession}
                  data-testid="session-readonly-new"
                >
                  {t.session.newSession}
                </Button>
              </div>
            </div>
          ) : null}
          {choiceOnly ? (
            <p
              className="mb-2 text-xs text-muted-foreground"
              data-testid="session-composer-locked"
            >
              {t.session.choiceOnly}
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
                disabled={composerDisabled || !canType}
                placeholder={
                  readOnly
                    ? t.session.placeholderReadOnly
                    : !hasSources
                      ? t.session.placeholderNoSources
                      : choiceOnly
                        ? t.session.placeholderChoice
                        : (pending?.inputPlaceholder ??
                          t.session.placeholderDefault)
                }
                data-testid="session-input"
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools />
              <PromptInputSubmit
                status={isBusy ? "streaming" : "ready"}
                disabled={
                  readOnly ||
                  isBusy ||
                  choiceOnly ||
                  !canType ||
                  !input.trim() ||
                  !hasSources
                }
                data-testid="session-send"
                onStop={() => handleStop()}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </>
  );
}
