/**
 * P1 fixture chain: openWikiRunUiProjection start → plan suspend → resume approve.
 * Uses the real product UI projection shell (minimal fork of handleWorkflowStream).
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { resetMastraForTests } from "./mastra-instance.js";
import { mapWorkflowResult } from "./workflow-result.js";
import { openWikiRunUiProjection } from "./workflow-ui-stream.js";

/** realpath: macOS /var → /private/var so publish assertNoSymlinkComponents accepts roots. */
async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function makeWorkspace(root: string): Promise<WorkspaceConfig> {
  const sourcePath = path.join(root, "src-repo");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# fixture source\n", "utf8");
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

  return {
    version: 1,
    id: "ws-ui-projection",
    name: "UI Projection WS",
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
    publicationPath: path.join(root, "wiki-out"),
    limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
    adaptive: false,
    reviewer: false,
    planConfirm: true,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  };
}

/** Drain UI chunk stream so the workflow can settle (closeOnSuspend). */
async function drainUiStream(
  stream: ReadableStream<unknown>,
): Promise<number> {
  const reader = stream.getReader();
  let n = 0;
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
      n += 1;
    }
  } finally {
    reader.releaseLock();
  }
  return n;
}

test("openWikiRunUiProjection fixture: start → plan suspend → resume → publish gate", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  process.env.OKF_WIKI_MASTRA_STORAGE = "memory";
  resetMastraForTests();

  const root = await tempDir("okf-ui-proj-");
  try {
    const workspace = await makeWorkspace(root);
    const runId = randomUUID();

    // Start with forcePlanConfirm so Session shell path suspends at plan-gate.
    const start = await openWikiRunUiProjection({
      kind: "start",
      runId,
      workspace,
      autoApprove: false,
      skipPlanConfirm: false,
      forcePlanConfirm: true,
    });
    const startChunks = await drainUiStream(start.stream);
    assert.ok(startChunks >= 1, "framework UI stream should emit parts");
    const startTerminal = mapWorkflowResult(await start.result());
    assert.equal(startTerminal.status, "awaiting_plan");
    assert.equal(startTerminal.suspended, true);
    assert.equal(startTerminal.suspendGate, "plan");
    assert.ok(startTerminal.plan, "plan payload required for resume");

    // Resume plan approve → write → publication suspend (no autoApprove).
    const resume = await openWikiRunUiProjection({
      kind: "resume",
      runId,
      step: "plan-gate",
      resumeData: {
        action: "approve",
        plan: startTerminal.plan,
      },
    });
    const resumeChunks = await drainUiStream(resume.stream);
    assert.ok(resumeChunks >= 1, "resume UI stream should emit parts");
    const afterPlan = mapWorkflowResult(await resume.result());
    assert.equal(afterPlan.status, "awaiting_publication");
    assert.equal(afterPlan.suspended, true);
    assert.equal(afterPlan.suspendGate, "publication");
    assert.ok(afterPlan.pages && afterPlan.pages.length >= 1);

    // Resume publish approve → published.
    const publish = await openWikiRunUiProjection({
      kind: "resume",
      runId,
      step: "publish-gate",
      resumeData: { action: "approve" },
    });
    await drainUiStream(publish.stream);
    const final = mapWorkflowResult(await publish.result());
    assert.equal(final.status, "published");
    assert.ok(final.pages && final.pages.length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
    delete process.env.OKF_WIKI_MASTRA_STORAGE;
    resetMastraForTests();
  }
});
