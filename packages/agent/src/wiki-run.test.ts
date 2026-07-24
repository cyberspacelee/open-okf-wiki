/**
 * Wiki Run orchestration on Pi + WikiRunShell (fixture mode).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@okf-wiki/contract";
import {
  OKF_PRODUCE_PROGRESS_CUSTOM_TYPE,
  type ProduceToolDetails,
} from "./produce/tools/wiki-produce-progress.js";
import { createWikiRunProduceBridge, resumeWikiRun, startWikiRun } from "./wiki-run.js";

async function makeWorkspace(root: string): Promise<WorkspaceConfig> {
  const sourcePath = path.join(root, "src-repo");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# fixture source\n", "utf8");

  const publicationPath = path.join(root, "wiki-out");
  return WorkspaceConfigSchema.parse({
    version: 1,
    id: "ws-fixture",
    name: "Fixture WS",
    rootPath: root,
    sources: [
      {
        id: "main",
        path: sourcePath,
        applyDefaultIgnores: true,
        ignore: [],
      },
    ],
    model: { id: "openai/test" },
    publicationPath,
    limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
    planConfirm: false,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
}

test("startWikiRun fixture auto-publishes without planConfirm", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";

  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-run-"));
  try {
    const workspace = await makeWorkspace(root);
    const runId = randomUUID();
    const result = await startWikiRun({
      runId,
      workspace,
      autoApprove: true,
      skipPlanConfirm: true,
    });
    assert.equal(result.status, "published");
    assert.ok(result.pages && result.pages.length >= 1);
    assert.ok(result.publicationPath);
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
  }
});

test("startWikiRun suspends for plan when planConfirm", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";

  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-plan-"));
  try {
    const workspace = await makeWorkspace(root);
    workspace.planConfirm = true;
    const runId = randomUUID();
    const result = await startWikiRun({
      runId,
      workspace,
      autoApprove: false,
      skipPlanConfirm: false,
    });
    assert.equal(result.status, "awaiting_plan");
    assert.ok(result.plan);
    assert.equal(result.suspended, true);

    const resumed = await resumeWikiRun({
      runId,
      workspace,
      step: "plan-gate",
      resumeData: {
        action: "approve",
        plan: result.plan,
      },
      plan: result.plan,
    });
    // After plan approve: write then suspend publication (no autoApprove).
    assert.equal(resumed.status, "awaiting_publication");
    assert.ok(resumed.pages && resumed.pages.length >= 1);

    const published = await resumeWikiRun({
      runId,
      workspace,
      step: "publish-gate",
      resumeData: { action: "approve" },
      pages: resumed.pages,
      plan: resumed.plan ?? result.plan,
    });
    assert.equal(published.status, "published");
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
  }
});

test("startWikiRun returns cancelled when abortSignal already aborted", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";

  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-abort-"));
  try {
    const workspace = await makeWorkspace(root);
    const runId = randomUUID();
    const controller = new AbortController();
    controller.abort();
    const result = await startWikiRun({
      runId,
      workspace,
      autoApprove: true,
      skipPlanConfirm: true,
      abortSignal: controller.signal,
    });
    assert.equal(result.status, "cancelled");
    assert.equal(result.error, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
  }
});

test("startWikiRun emits produce_progress with ProduceToolDetails (not work_unit)", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";

  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-progress-"));
  try {
    const workspace = await makeWorkspace(root);
    const runId = randomUUID();
    const events: Array<{ type: string; message?: string; data?: unknown }> = [];
    const custom: Array<{ type: string; data: unknown }> = [];

    const result = await startWikiRun({
      runId,
      workspace,
      autoApprove: true,
      skipPlanConfirm: true,
      onEvent: (e) => events.push(e),
      parentSessionManager: {
        appendCustomEntry(customType, data) {
          custom.push({ type: customType, data });
          return `c-${custom.length}`;
        },
      },
    });
    assert.equal(result.status, "published");

    const progressEvents = events.filter((e) => e.type === "produce_progress");
    assert.ok(progressEvents.length >= 1, "expected produce_progress job events");
    assert.ok(!events.some((e) => e.type === "work_unit"), "must not emit work_unit");

    for (const e of progressEvents) {
      const d = e.data as ProduceToolDetails;
      assert.ok(d && typeof d === "object");
      assert.ok(typeof d.role === "string");
      assert.ok(
        d.status === "pending" ||
          d.status === "running" ||
          d.status === "settled" ||
          d.status === "failed",
      );
      assert.equal(e.message, d.status);
    }

    // Settle/fail units append okf.produce_progress (not okf.work_unit).
    assert.ok(custom.length >= 1, "expected settle custom entries");
    for (const c of custom) {
      assert.equal(c.type, OKF_PRODUCE_PROGRESS_CUSTOM_TYPE);
      assert.notEqual(c.type, "work_unit");
      assert.notEqual(c.type, "okf.work_unit");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
  }
});

test("createWikiRunProduceBridge maps progress to produce_progress details", () => {
  const events: Array<{ type: string; message?: string; data?: unknown }> = [];
  const bridge = createWikiRunProduceBridge({
    onEvent: (e) => events.push(e),
  });
  bridge.onProgress({
    role: "planner",
    status: "running",
    unitId: "planner",
    parentId: "root",
    task: "plan",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "produce_progress");
  assert.equal(events[0]!.message, "running");
  const d = events[0]!.data as ProduceToolDetails;
  assert.equal(d.unitId, "planner");
  assert.equal(d.role, "planner");
  assert.equal(d.task, "plan");
});
