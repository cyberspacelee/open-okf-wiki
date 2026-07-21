import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
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
  PromptInputButton,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Suggestion,
  Suggestions,
} from "@/components/ai-elements/suggestion";
import { MessageParts } from "../components/session/MessageParts";
import { writtenPathsFromMessages } from "../components/session/session-tool-utils";
import { extractPendingFromMessages } from "../components/session/decision-types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { LoadingState } from "../components/LoadingState";
import { WorkspaceShell } from "../components/WorkspaceShell";
import {
  cancelRun,
  createSession,
  deleteSession,
  getOrCreateSession,
  getSession,
  getWorkspace,
  listRuns,
  listSessions,
  resetSession,
  runEventsUrl,
  type OperatorSessionDto,
  type OperatorSessionSummary,
  type WikiRunPlan,
  type WorkspaceConfig,
} from "../api";
import { useI18n } from "../i18n";
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
} from "../lib/session-commands";
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
import { Spinner } from "@/components/ui/spinner";
import { MessageSquareIcon, PlusIcon, SlashIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Server persists schemaVersion 2 SessionMessage rows in AI SDK UIMessage shape.
 * Thin cast only — no local part rewrite (ADR 0027).
 */
function sessionMessagesToUI(session: OperatorSessionDto): UIMessage[] {
  return session.messages.map((m) => ({
    id: m.id,
    role: m.role as UIMessage["role"],
    parts: (m.parts ?? []) as UIMessage["parts"],
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

/** Gate step from session.workflow.phase or structured data-gate (no transcript regex). */
function extractGateStep(
  session: OperatorSessionDto,
  messages: UIMessage[],
): "plan-gate" | "publish-gate" {
  const live = resolveLiveGate(session, messages);
  if (live.active) {
    return live.step;
  }
  return "plan-gate";
}

/**
 * Live HITL gate for resumeData attachment.
 * Prefer durable phase; fall back to latest decision/data-plan parts when meta lags.
 */
function resolveLiveGate(
  session: OperatorSessionDto,
  messages: UIMessage[],
  linkedRunIdHint?: string,
  resumePlanHint?: WikiRunPlan,
): {
  active: boolean;
  step: "plan-gate" | "publish-gate";
  runId?: string;
  plan?: WikiRunPlan;
} {
  const runId =
    linkedRunIdHint ||
    extractLinkedRunId(session, messages) ||
    session.workflow?.linkedRunId;
  const plan =
    resumePlanHint || extractResumePlan(session, messages) || undefined;
  const phase = session.workflow?.phase;

  // Eager gate-exit persists phase as planning/writing while work is in flight.
  // Do not treat status===running alone as mid-flight: stuck "running" at a real
  // gate must still resume after refresh until reconcile rewrites status.
  if (phase === "planning" || phase === "writing") {
    return { active: false, step: "plan-gate", runId, plan };
  }

  if (phase === "awaiting_publish" && runId) {
    return { active: true, step: "publish-gate", runId, plan };
  }
  if (phase === "awaiting_plan" && runId) {
    return { active: true, step: "plan-gate", runId, plan };
  }

  // Meta lag: data-gate already on the latest assistant message.
  const pending = extractPendingFromMessages(messages);
  if (pending && runId) {
    if (pending.gate === "publication") {
      return { active: true, step: "publish-gate", runId, plan };
    }
    if (pending.gate === "plan") {
      return { active: true, step: "plan-gate", runId, plan };
    }
    if (pending.options.some((o) => o.id === "revise")) {
      return { active: true, step: "plan-gate", runId, plan };
    }
    if (/publish|staging/i.test(pending.question)) {
      return { active: true, step: "publish-gate", runId, plan };
    }
    if (pending.options.some((o) => o.id === "approve" || o.id === "deny")) {
      return { active: true, step: "plan-gate", runId, plan };
    }
  }

  return { active: false, step: "plan-gate", runId, plan };
}

/** Plan from durable session meta, data-plan, or Mastra data-workflow suspendPayload. */
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
      if (
        (p.type === "data-workflow" || p.type === "data-workflow-step") &&
        p.data &&
        typeof p.data === "object"
      ) {
        const fromWorkflow = planFromDataWorkflow(p.data);
        if (fromWorkflow) {
          return fromWorkflow;
        }
      }
    }
  }
  return undefined;
}

function planFromDataWorkflow(data: unknown): WikiRunPlan | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const tryPlan = (raw: unknown): WikiRunPlan | undefined => {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const plan = raw as WikiRunPlan;
    if (typeof plan.summary === "string" && Array.isArray(plan.pages)) {
      return plan;
    }
    return undefined;
  };
  const steps = (data as { steps?: Record<string, unknown> }).steps;
  if (steps && typeof steps === "object") {
    for (const step of Object.values(steps)) {
      if (!step || typeof step !== "object") {
        continue;
      }
      const payload = (step as { suspendPayload?: unknown }).suspendPayload;
      if (payload && typeof payload === "object") {
        const gate = (payload as { gate?: unknown }).gate;
        if (gate === "plan") {
          const plan = tryPlan((payload as { plan?: unknown }).plan);
          if (plan) {
            return plan;
          }
        }
      }
    }
  }
  const stepPayload = (data as { step?: { suspendPayload?: unknown } }).step
    ?.suspendPayload;
  if (stepPayload && typeof stepPayload === "object") {
    return tryPlan((stepPayload as { plan?: unknown }).plan);
  }
  return tryPlan(
    (data as { suspendPayload?: { plan?: unknown } }).suspendPayload?.plan,
  );
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
  const [searchParams, setSearchParams] = useSearchParams();
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
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  /** Bump to remount chat panel after reset/delete without id change races. */
  const [panelEpoch, setPanelEpoch] = useState(0);

  const rootPath = workspace?.rootPath ?? rootPathHint;

  const syncSessionIdInUrl = useCallback(
    (sessionId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("sessionId", sessionId);
          // One-shot kickoff should not re-fire after navigation.
          next.delete("kickoff");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Boot workspace + session (url id or latest) + history list.
  // Intentionally does not re-run when we write sessionId into the URL after boot.
  useEffect(() => {
    if (!id) {
      return;
    }
    let cancelled = false;
    const bootSessionId = searchParams.get("sessionId") ?? undefined;
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
        const listRes = await listSessions(id, root);
        if (cancelled) {
          return;
        }
        let session: OperatorSessionDto;
        if (bootSessionId) {
          try {
            const res = await getSession(id, bootSessionId, root);
            session = res.session;
          } catch {
            // Missing id → fall back to latest / create.
            const res = await getOrCreateSession(id, root);
            session = res.session;
          }
        } else {
          const res = await getOrCreateSession(id, root);
          session = res.session;
        }
        if (cancelled) {
          return;
        }
        setSessionMeta(session);
        setSessionList(
          upsertSessionSummary(listRes.sessions, summaryFromSession(session)),
        );
        // Ensure URL always carries sessionId for refresh restore.
        if (bootSessionId !== session.id) {
          syncSessionIdInUrl(session.id);
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once per workspace; switcher owns later loads
  }, [id, rootPathHint]);

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
        setPanelEpoch((n) => n + 1);
        syncSessionIdInUrl(session.id);
      } catch (err) {
        setBootError(err);
      } finally {
        setSwitching(false);
      }
    },
    [id, rootPath, sessionMeta?.id, switching, syncSessionIdInUrl],
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
      setPanelEpoch((n) => n + 1);
      syncSessionIdInUrl(session.id);
    } catch (err) {
      setBootError(err);
    } finally {
      setCreating(false);
    }
  }, [id, creating, rootPath, syncSessionIdInUrl]);

  const requestDeleteSession = useCallback(() => {
    if (!id || !sessionMeta || deleting) {
      return;
    }
    setDeleteDialogOpen(true);
  }, [id, sessionMeta, deleting]);

  const handleDeleteSession = useCallback(async () => {
    if (!id || !sessionMeta || deleting) {
      return;
    }
    setDeleting(true);
    setBootError(null);
    try {
      const deletedId = sessionMeta.id;
      await deleteSession(id, deletedId, rootPath);
      const remaining = sessionList.filter((s) => s.id !== deletedId);
      setSessionList(remaining);
      let next: OperatorSessionDto;
      if (remaining[0]) {
        const res = await getSession(id, remaining[0].id, rootPath);
        next = res.session;
      } else {
        const res = await createSession(id, undefined, rootPath);
        next = res.session;
        setSessionList([summaryFromSession(next)]);
      }
      setSessionMeta(next);
      setPanelEpoch((n) => n + 1);
      syncSessionIdInUrl(next.id);
    } catch (err) {
      setBootError(err);
    } finally {
      setDeleting(false);
    }
  }, [id, sessionMeta, deleting, rootPath, sessionList, syncSessionIdInUrl]);

  const handleResetSession = useCallback(async () => {
    if (!id || !sessionMeta) {
      return;
    }
    setBootError(null);
    try {
      const { session } = await resetSession(id, sessionMeta.id, rootPath);
      setSessionMeta(session);
      setSessionList((prev) =>
        upsertSessionSummary(prev, summaryFromSession(session)),
      );
      setPanelEpoch((n) => n + 1);
    } catch (err) {
      setBootError(err);
    }
  }, [id, sessionMeta, rootPath]);

  const sessionSelectItems = useMemo(
    () =>
      sessionList.map((s) => ({
        value: s.id,
        label: formatSessionLabel(s),
      })),
    [sessionList],
  );

  const sessionActions = (
    <>
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
          disabled={creating || loading || switching || deleting}
          data-testid="session-new"
        >
          {creating ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PlusIcon data-icon="inline-start" aria-hidden />
          )}
          {creating ? t.session.creatingSession : t.session.newSession}
        </Button>
        {sessionMeta ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={requestDeleteSession}
            disabled={deleting || loading || switching || creating}
            data-testid="session-delete"
            title={t.session.deleteSession}
          >
            {deleting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Trash2Icon data-icon="inline-start" aria-hidden />
            )}
            <span className="sr-only sm:not-sr-only">
              {deleting ? t.session.deletingSession : t.session.deleteSession}
            </span>
          </Button>
        ) : null}
      </div>
      {sessionMeta ? (
        <Badge
          variant="secondary"
          data-testid="session-status"
          data-status={sessionMeta.status}
        >
          {(t.session.lifecycle as Record<string, string>)[sessionMeta.status] ??
            sessionMeta.status}
        </Badge>
      ) : null}
      {sessionMeta?.workflow?.linkedRunId ? (
        <Badge variant="outline" data-testid="session-linked-run">
          {t.session.runPrefix} {sessionMeta.workflow.linkedRunId.slice(0, 8)}…
        </Badge>
      ) : null}
      <Link
        to={workspaceHref(id, "/run", rootPathHint)}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        data-testid="session-open-runs"
      >
        {t.session.openRuns}
      </Link>
    </>
  );

  return (
    <WorkspaceShell
      workspaceId={id}
      workspaceName={workspace?.name}
      breadcrumbLabel={t.session.breadcrumb}
      title={t.session.title}
      actions={sessionActions}
      error={bootError}
      onDismissError={() => setBootError(null)}
      compact
      testId="session-chat-page"
    >
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t.session.deleteConfirmTitle}
        description={t.session.deleteConfirmBody}
        confirmLabel={
          deleting ? t.session.deletingSession : t.session.deleteConfirmSubmit
        }
        cancelLabel={t.common.cancel}
        onConfirm={() => void handleDeleteSession()}
        confirmDisabled={deleting}
        data-testid="session-delete-dialog"
        confirmTestId="session-delete-confirm"
      />

      {loading || !sessionMeta || !workspace ? (
        // Compact shell fills the viewport; center the skeleton like empty chat.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
          <LoadingState label={t.session.loading} />
        </div>
      ) : (
        <SessionChatPanel
          key={`${sessionMeta.id}:${panelEpoch}`}
          workspaceId={id}
          workspace={workspace}
          session={sessionMeta}
          rootPathHint={rootPathHint}
          kickoff={kickoff}
          onSessionMetaChange={handleSessionMetaChange}
          onNewSession={() => void handleNewSession()}
          onResetSession={() => void handleResetSession()}
          onDeleteSession={requestDeleteSession}
        />
      )}
    </WorkspaceShell>
  );
}

function SessionChatPanel({
  workspaceId,
  workspace,
  session,
  rootPathHint,
  kickoff,
  onSessionMetaChange,
  onNewSession,
  onResetSession,
  onDeleteSession,
}: {
  workspaceId: string;
  workspace: WorkspaceConfig;
  session: OperatorSessionDto;
  rootPathHint?: string;
  kickoff?: boolean;
  onSessionMetaChange?: (session: OperatorSessionDto) => void;
  onNewSession?: () => void;
  onResetSession?: () => void;
  onDeleteSession?: () => void;
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
  const pendingSendRef = useRef<{
    intent: "start" | "resume" | "chat";
    resumeData?: {
      action: "approve" | "deny" | "revise";
      plan?: WikiRunPlan;
      feedback?: string;
    };
    step?: "plan-gate" | "publish-gate";
    runId?: string;
  } | null>(null);
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
    (
      text: string,
      envelope?: {
        intent: "start" | "resume" | "chat";
        resumeData?: {
          action: "approve" | "deny" | "revise";
          plan?: WikiRunPlan;
          feedback?: string;
        };
        step?: "plan-gate" | "publish-gate";
        runId?: string;
      },
    ) => {
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

  /** Filled after handleStop is defined (slash /stop). */
  const handleStopRef = useRef<(() => void) | null>(null);

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
      const next = sessionMessagesToUI(fresh);
      setMessages((prev) => {
        if (next.length === 0) {
          return prev;
        }
        // Prefer the longer durable timeline; never shrink mid-flight to empty.
        if (next.length < prev.length) {
          const mid =
            fresh.status === "running" ||
            fresh.workflow?.phase === "planning" ||
            fresh.workflow?.phase === "writing";
          if (mid) {
            return prev;
          }
        }
        return next;
      });
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
            const line =
              event.message ||
              event.text ||
              (event.status ? `status: ${event.status}` : "");
            if (!line || event.type === "done") {
              if (event.type === "done" || event.status) {
                void tick();
              }
              return;
            }
            // Append a lightweight progress bubble (not persisted until poll).
            setMessages((prev) => {
              const id = `run-live-${Date.now()}`;
              const last = prev[prev.length - 1];
              if (
                last?.role === "assistant" &&
                last.id.startsWith("run-live-") &&
                last.parts.some(
                  (p) =>
                    p.type === "text" &&
                    "text" in p &&
                    String(p.text).endsWith(line),
                )
              ) {
                return prev;
              }
              return [
                ...prev,
                {
                  id,
                  role: "assistant" as const,
                  parts: [{ type: "text" as const, text: line }],
                },
              ];
            });
            if (
              event.type === "done" ||
              event.status === "awaiting_plan" ||
              event.status === "awaiting_publication" ||
              event.status === "published" ||
              event.status === "failed" ||
              event.status === "cancelled"
            ) {
              void tick();
            }
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

  const chatStatusLabel =
    (t.session.chatStatus as Record<string, string>)[status] ?? status;

  return (
    <>
      <ErrorBanner error={error} onDismiss={() => clearError()} />
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
        data-testid="session-chat-shell"
      >
        {/*
          Immersive chat: no top status bar. Stop lives on PromptInputSubmit;
          one Badge near the composer tools. Linked-run id stays in page actions.
        */}
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
                      writtenPaths={sessionWrittenPaths}
                      isLatestAssistant={
                        message.id === latestAssistantId &&
                        !suppressDecisions &&
                        // Hide chips while write/plan is in flight (eager gate-exit).
                        session.workflow?.phase !== "planning" &&
                        session.workflow?.phase !== "writing"
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

        <div className="shrink-0 border-t bg-card/80 p-3 backdrop-blur-sm supports-backdrop-filter:bg-card/70">
          {(session.status === "running" ||
            session.workflow?.phase === "planning" ||
            session.workflow?.phase === "writing") &&
          !isBusy ? (
            <p
              className="mb-2 text-xs text-muted-foreground"
              data-testid="session-midflight-banner"
            >
              Wiki Run in progress — timeline updates automatically. Use{" "}
              <strong>Stop</strong> to cancel.
            </p>
          ) : null}
          {choiceOnly ? (
            <p
              className="mb-2 text-xs text-muted-foreground"
              data-testid="session-composer-locked"
            >
              {t.session.choiceOnly}
            </p>
          ) : null}
          {planReviseMode && !choiceOnly ? (
            <p
              className="mb-2 text-xs text-muted-foreground"
              data-testid="session-plan-revise-hint"
            >
              {t.session.planReviseHint}
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
          {!choiceOnly && suggestionChips.length > 0 ? (
            <Suggestions className="mb-2 px-0.5" data-testid="session-suggestions">
              {suggestionChips.map((s) => (
                <Suggestion
                  key={s}
                  suggestion={s}
                  onClick={(value) => {
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
                  }}
                />
              ))}
            </Suggestions>
          ) : null}
          <div className="relative">
            {slashMenuOpen ? (
              <div
                className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded-lg border bg-popover shadow-md"
                data-testid="session-slash-menu"
              >
                <PromptInputCommand
                  shouldFilter={false}
                  className="h-auto max-h-56 w-full"
                >
                  <PromptInputCommandList className="max-h-56">
                    <PromptInputCommandEmpty className="p-3 text-sm text-muted-foreground">
                      {t.session.slashEmpty}
                    </PromptInputCommandEmpty>
                    <PromptInputCommandGroup heading={t.session.slashHeading}>
                      {slashCommands.map((cmd, index) => {
                        const active =
                          index ===
                          clampSlashHighlight(
                            slashHighlight,
                            slashCommands.length,
                          );
                        return (
                          <PromptInputCommandItem
                            key={cmd.id}
                            value={cmd.command}
                            onSelect={() => applyCommandDef(cmd)}
                            data-testid={`session-slash-${cmd.id}`}
                            data-highlighted={active ? "true" : undefined}
                            className={cn(
                              active && "bg-accent text-accent-foreground",
                            )}
                            onMouseEnter={() => setSlashHighlight(index)}
                          >
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span className="font-medium">{cmd.command}</span>
                              <span className="truncate text-xs text-muted-foreground">
                                {cmd.description}
                              </span>
                            </div>
                          </PromptInputCommandItem>
                        );
                      })}
                    </PromptInputCommandGroup>
                  </PromptInputCommandList>
                </PromptInputCommand>
              </div>
            ) : null}
            <PromptInput
              onSubmit={handleSubmit}
              className="w-full [&_[data-slot=input-group]]:shadow-xs"
              data-testid="session-prompt"
            >
              <PromptInputBody>
                <PromptInputTextarea
                  value={input}
                  onChange={(e) => setInput(e.currentTarget.value)}
                  onKeyDown={handleComposerKeyDown}
                  disabled={composerDisabled || !canType}
                  placeholder={
                    !hasSources
                      ? t.session.placeholderNoSources
                      : choiceOnly
                        ? t.session.placeholderChoice
                        : planReviseMode
                          ? (pending?.inputPlaceholder ??
                            t.session.placeholderPlanRevise)
                          : (pending?.inputPlaceholder ??
                            t.session.placeholderDefault)
                  }
                  data-testid="session-input"
                />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools>
                  <Badge
                    variant="secondary"
                    data-testid="session-chat-status"
                    data-status={status}
                    className="font-normal"
                  >
                    {chatStatusLabel}
                  </Badge>
                  {linkedRunId ? (
                    <Badge
                      variant="outline"
                      data-testid="session-chat-run-id"
                      className="font-normal"
                    >
                      {linkedRunId.slice(0, 8)}…
                    </Badge>
                  ) : null}
                  <PromptInputButton
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={choiceOnly || isBusy}
                    tooltip={t.session.slashTooltip}
                    onClick={() => {
                      if (choiceOnly) {
                        return;
                      }
                      setInput((prev) => (prev.startsWith("/") ? prev : "/"));
                    }}
                    data-testid="session-slash-open"
                  >
                    <SlashIcon data-icon="inline-start" aria-hidden />
                  </PromptInputButton>
                </PromptInputTools>
                <PromptInputSubmit
                  status={isBusy ? "streaming" : "ready"}
                  disabled={
                    isBusy ||
                    choiceOnly ||
                    !canType ||
                    !input.trim() ||
                    (!hasSources && !input.trim().startsWith("/"))
                  }
                  data-testid="session-send"
                  onStop={() => handleStop()}
                />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>
      </div>
    </>
  );
}
