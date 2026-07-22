/**
 * Wiki Run orchestration on Pi + WikiRunShell (fixture mode).
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  WorkspaceConfigSchema,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { startWikiRun, resumeWikiRun } from "./wiki-run.js";

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
