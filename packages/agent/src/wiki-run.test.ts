/**
 * Wiki workflow orchestration (fixture mode) — single production path.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { resetMastraForTests } from "./mastra-instance.js";
import { startWikiRun, resumeWikiRun } from "./wiki-run.js";

async function makeWorkspace(root: string): Promise<WorkspaceConfig> {
  const sourcePath = path.join(root, "src-repo");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# fixture source\n", "utf8");
  // Minimal git tree so later gates can probe if needed.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("git", ["init"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: sourcePath,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: sourcePath });
  await execFileAsync("git", ["add", "."], { cwd: sourcePath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: sourcePath });

  const publicationPath = path.join(root, "wiki-out");
  return {
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
    adaptive: false,
    reviewer: false,
    planConfirm: false,
    createdAt: new Date().toISOString(),
  };
}

test("startWikiRun fixture auto-publishes without planConfirm", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  process.env.OKF_WIKI_MASTRA_STORAGE = "memory";
  resetMastraForTests();

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
    delete process.env.OKF_WIKI_MASTRA_STORAGE;
    resetMastraForTests();
  }
});

test("startWikiRun suspends for plan when planConfirm", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  process.env.OKF_WIKI_MASTRA_STORAGE = "memory";
  resetMastraForTests();

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
      gate: "plan",
      action: "approve",
      plan: result.plan,
    });
    // After plan approve: write then suspend publication (no autoApprove).
    assert.equal(resumed.status, "awaiting_publication");
    assert.ok(resumed.pages && resumed.pages.length >= 1);

    const published = await resumeWikiRun({
      runId,
      gate: "publication",
      action: "approve",
    });
    assert.equal(published.status, "published");
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
    delete process.env.OKF_WIKI_MASTRA_STORAGE;
    resetMastraForTests();
  }
});

test("startWikiRun hard-stops when product abortSignal fires mid-fixture", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  process.env.OKF_WIKI_MASTRA_STORAGE = "memory";
  process.env.OKF_WIKI_FIXTURE_DELAY_MS = "400";
  resetMastraForTests();

  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-abort-"));
  try {
    const workspace = await makeWorkspace(root);
    const runId = randomUUID();
    const controller = new AbortController();
    const started = startWikiRun({
      runId,
      workspace,
      autoApprove: true,
      skipPlanConfirm: true,
      abortSignal: controller.signal,
    });
    // Abort while fixture delay is still slicing (50ms steps).
    await new Promise((r) => setTimeout(r, 80));
    controller.abort();
    const result = await started;
    assert.equal(result.status, "cancelled");
    assert.equal(result.error, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
    delete process.env.OKF_WIKI_MASTRA_STORAGE;
    delete process.env.OKF_WIKI_FIXTURE_DELAY_MS;
    resetMastraForTests();
  }
});
