/**
 * SessionTurn public types (ADR 0027 / 0029).
 */

import type {
  OperatorSession,
  PendingInteraction,
  SessionMessage,
  SessionWorkflowState,
  WikiRunPlan,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import type { UIMessage, UIMessageChunk } from "ai";

export type SessionStreamSideEffects = {
  /** Register / update product run record after workflow progress. */
  upsertRun?: {
    runId: string;
    status: OperatorSession["status"] | string;
    pages?: string[];
    plan?: WikiRunPlan;
    summary?: string;
    /** Link run record back to the Operator Session that started it. */
    sessionId?: string;
  };
};

export type SessionStreamResult = {
  stream: ReadableStream<UIMessageChunk>;
  /**
   * Turn mode after body/session inspection. Server uses `start` to eagerly
   * register a run record so explicit Stop/cancel can target it mid-stream.
   */
  mode: "start" | "resume" | "help";
  /** Linked Wiki Run id for start/resume turns (undefined for help). */
  runId?: string;
  finalize: () => Promise<{
    /** Full UIMessage-compatible history after this turn (server source of truth). */
    messages: SessionMessage[];
    assistantMessage: SessionMessage;
    status: OperatorSession["status"];
    pending: PendingInteraction | null;
    workflow: Partial<SessionWorkflowState>;
    sideEffects?: SessionStreamSideEffects;
  }>;
};

export type SessionStreamBody = {
  /** Last user message only (AI SDK chat persistence). Server loads prior history. */
  message?: UIMessage;
  /** Chat / session id from DefaultChatTransport. */
  id?: string;
  /**
   * Explicit turn intent. Avoids guessing resume/start from user text.
   * - start: kick off a Wiki Run
   * - resume: answer plan/publish gate with resumeData
   * - chat: help / non-run (default when omitted and no resumeData)
   */
  intent?: "start" | "resume" | "chat";
  /** Workflow resume payload (plan/publication gate). Required when intent=resume. */
  resumeData?: {
    action: "approve" | "deny" | "revise";
    plan?: WikiRunPlan;
    feedback?: string;
  };
  runId?: string;
  step?: string;
};

/** Hooks the server supplies when opening a SessionTurn stream. */
export type SessionTurnHooks = {
  /**
   * Register product cancel AbortController for this run (server abortRun).
   * Called synchronously once mode/runId are known so Stop can abort mid-stream.
   */
  abortSignalForRun?: (runId: string) => AbortSignal;
  /**
   * Called after the Mastra workflow stream is successfully opened (start or
   * resume). Server uses this to mark the run record `running` only once the
   * workflow is live — not at eager session mid-flight — so a crash before open
   * leaves the run at awaiting_* for gate recovery.
   */
  onWorkflowLive?: (runId: string) => void | Promise<void>;
  /**
   * Durable mid-stream journal: server persists partial assistant timeline so a
   * page refresh mid-turn can render progress and keep catching up.
   */
  onCheckpoint?: (snapshot: {
    messages: SessionMessage[];
    status: OperatorSession["status"];
    pending: PendingInteraction | null;
    workflow: Partial<SessionWorkflowState>;
  }) => void | Promise<void>;
};

export type CreateSessionTurnStreamInput = SessionTurnHooks & {
  session: OperatorSession;
  workspace: WorkspaceConfig;
  /** Full UI message list for this turn (previous + new user). */
  messages: UIMessage[];
  body?: SessionStreamBody;
};
