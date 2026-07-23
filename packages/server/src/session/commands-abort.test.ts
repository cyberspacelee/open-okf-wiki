/**
 * Session abort must cancel the linked Wiki Run (Stop agent → durable cancel).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startShell } from "@okf-wiki/agent";
import { createRun, createWorkspace, loadRun, updateRunRecord } from "@okf-wiki/core";
import { clearRunAbortController, registerRunAbortController } from "../run-events.ts";
import { handleAbort } from "./commands.ts";
import type { RegisteredAgentSession } from "./parent-session.ts";

test("handleAbort cancels linked Wiki Run record and aborts produce signal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-abort-run-"));
  try {
    const workspace = await createWorkspace({
      name: "Abort Fixture",
      rootPath: root,
      publicationPath: path.join(root, "wiki-out"),
      modelId: "openai/test",
    });
    const run = await createRun(workspace.rootPath, workspace.id, {
      sessionId: "sess-abort-1",
    });
    assert.equal(run.status, "running");

    const controller = new AbortController();
    registerRunAbortController(run.runId, controller);

    const entry: RegisteredAgentSession = {
      sessionId: "sess-abort-1",
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      workspaceName: workspace.name,
      title: "test",
      createdAt: new Date().toISOString(),
      metaPath: path.join(root, "meta.json"),
      sessionWorkDir: path.join(root, "sess"),
      shell: startShell({ skipPlanConfirm: true }),
      runId: run.runId,
      abortController: controller,
      busy: true,
    };

    const res = await handleAbort(entry);
    assert.equal(res.ok, true);
    assert.equal(res.command, "abort");
    assert.equal(res.runId, run.runId);
    assert.equal(controller.signal.aborted, true);
    assert.equal(entry.busy, false);
    assert.equal(entry.abortController, undefined);
    assert.equal(entry.shell?.phase, "cancelled");

    const updated = await loadRun(workspace.rootPath, run.runId);
    assert.ok(updated);
    assert.equal(updated.status, "cancelled");
    assert.equal(updated.error, "cancelled");

    clearRunAbortController(run.runId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handleAbort cancels run at plan gate without live abortController", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-abort-gate-"));
  try {
    const workspace = await createWorkspace({
      name: "Abort Gate Fixture",
      rootPath: root,
      publicationPath: path.join(root, "wiki-out"),
      modelId: "openai/test",
    });
    const run = await createRun(workspace.rootPath, workspace.id, {
      sessionId: "sess-gate-1",
    });
    // Simulate suspended plan gate (controller already cleared after startWikiRun returned).
    await updateRunRecord(workspace.rootPath, run.runId, {
      status: "awaiting_plan",
      summary: "Awaiting plan confirmation",
    });

    const entry: RegisteredAgentSession = {
      sessionId: "sess-gate-1",
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      workspaceName: workspace.name,
      title: "test",
      createdAt: new Date().toISOString(),
      metaPath: path.join(root, "meta.json"),
      sessionWorkDir: path.join(root, "sess"),
      shell: startShell({
        plan: {
          version: 1,
          summary: "test",
          audience: "devs",
          domains: [],
          pages: [],
          openQuestions: [],
          acceptance: {
            reviewRequired: false,
            maxRepairRounds: 0,
            blockingSeverities: ["blocking"],
          },
          changelog: [],
        },
        skipPlanConfirm: false,
      }),
      runId: run.runId,
      busy: false,
    };
    assert.equal(entry.shell?.phase, "awaiting_plan");

    const res = await handleAbort(entry);
    assert.equal(res.ok, true);
    assert.equal(entry.shell?.phase, "cancelled");

    const updated = await loadRun(workspace.rootPath, run.runId);
    assert.ok(updated);
    assert.equal(updated.status, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
