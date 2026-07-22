/**
 * Load Operator Session reconciled with linked run (refresh / re-open).
 */

import type { OperatorSession, WikiRunRecordStatus } from "@okf-wiki/contract";
import {
  loadOperatorSession,
  loadRun,
  reconcileSessionWithRun,
  replaceSessionMessages,
} from "@okf-wiki/core";

/**
 * Align durable session gate UI with the linked run (refresh / re-open).
 * Best-effort: never fails the GET when reconcile write fails.
 * SessionSchemaVersionError propagates — callers map to HTTP 410.
 */
export async function loadSessionReconciled(
  rootPath: string,
  sessionId: string,
): Promise<OperatorSession | null> {
  const session = await loadOperatorSession(rootPath, sessionId);
  if (!session) {
    return null;
  }
  const linkedRunId = session.workflow?.linkedRunId;
  let runSnap: {
    status: WikiRunRecordStatus;
    plan?: OperatorSession["workflow"]["plan"];
  } | null = null;
  if (linkedRunId) {
    try {
      const run = await loadRun(rootPath, linkedRunId);
      if (run) {
        runSnap = {
          status: run.status,
          ...(run.plan ? { plan: run.plan } : {}),
        };
      }
    } catch {
      runSnap = null;
    }
  }
  const patch = reconcileSessionWithRun(session, runSnap);
  if (!patch.changed) {
    return session;
  }
  try {
    return await replaceSessionMessages(
      rootPath,
      sessionId,
      patch.messages ?? session.messages,
      {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.pending !== undefined ? { pending: patch.pending } : {}),
        ...(patch.workflow ? { workflow: patch.workflow } : {}),
      },
    );
  } catch {
    // Return in-memory reconciled view even if disk write failed.
    return {
      ...session,
      status: patch.status ?? session.status,
      pending: patch.pending !== undefined ? patch.pending : session.pending,
      workflow: patch.workflow
        ? { ...session.workflow, ...patch.workflow }
        : session.workflow,
      messages: patch.messages ?? session.messages,
    };
  }
}
