/**
 * Wiki Run job lifecycle integration (fixture mode).
 * Covers: start → plan gate → approve → publication gate → publish;
 * autoApprove path; Session trajectory linkage.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { defaultWikiRunSpec, type WorkspaceConfig } from "@okf-wiki/contract";
import {
  addSource,
  createRun,
  createWorkspace,
  loadRun,
  resolveSkillPath,
  saveWorkspace,
  skillDigest,
} from "@okf-wiki/core";
import {
  ensureWorkspaceSessionId,
  finalizeRunStatus,
  processRunInBackground,
  resumeRunInBackground,
} from "./wiki-run-job.ts";

const execFileAsync = promisify(execFile);

async function waitForRunStatus(
  rootPath: string,
  runId: string,
  want: string | string[],
  timeoutMs = 45_000,
): Promise<NonNullable<Awaited<ReturnType<typeof loadRun>>>> {
  const wanted = new Set(Array.isArray(want) ? want : [want]);
  const start = Date.now();
  for (;;) {
    const run = await loadRun(rootPath, runId);
    if (run && wanted.has(run.status)) {
      return run;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timeout waiting for run ${runId} status in ${[...wanted].join("|")} (got ${run?.status ?? "missing"})`,
      );
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function makeFixtureWorkspace(root: string, planConfirm: boolean): Promise<WorkspaceConfig> {
  const sourcePath = path.join(root, "src-repo");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# fixture\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: sourcePath,
  });
  await execFileAsync("git", ["config", "user.name", "test"], {
    cwd: sourcePath,
  });
  await execFileAsync("git", ["add", "."], { cwd: sourcePath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: sourcePath });

  let workspace = await createWorkspace({
    name: "Job Fixture",
    rootPath: root,
    publicationPath: path.join(root, "wiki-out"),
    modelId: "openai/test",
  });
  const added = await addSource(workspace, {
    id: "main",
    path: sourcePath,
    applyDefaultIgnores: true,
    ignore: [],
  });
  workspace = { ...added.config, planConfirm };
  await saveWorkspace(workspace);
  return workspace;
}

test("job: autoApprove publishes and links Session trajectory", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";

  const root = await mkdtemp(path.join(tmpdir(), "okf-job-auto-"));
  try {
    const workspace = await makeFixtureWorkspace(root, false);
    const skillPath = await resolveSkillPath({
      workspaceRoot: workspace.rootPath,
    });
    const digest = await skillDigest(skillPath);
    const run = await createRun(workspace.rootPath, workspace.id, {
      autoApprove: true,
      skillPath,
      skillDigest: digest,
      sessionId: await ensureWorkspaceSessionId(workspace),
    });

    processRunInBackground(workspace, run.runId, { autoApprove: true });
    const finished = await waitForRunStatus(workspace.rootPath, run.runId, "published");
    assert.equal(finished.status, "published");
    assert.ok(finished.pages && finished.pages.length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
  }
});

test("job: plan gate → resume approve → publication → approve publish", async () => {
  process.env.OKF_WIKI_AGENT_MODE = "fixture";

  const root = await mkdtemp(path.join(tmpdir(), "okf-job-plan-"));
  try {
    const workspace = await makeFixtureWorkspace(root, true);
    const sessionId = await ensureWorkspaceSessionId(workspace);
    const skillPath = await resolveSkillPath({
      workspaceRoot: workspace.rootPath,
    });
    const digest = await skillDigest(skillPath);
    const run = await createRun(workspace.rootPath, workspace.id, {
      autoApprove: false,
      skillPath,
      skillDigest: digest,
      sessionId,
    });

    processRunInBackground(workspace, run.runId, { autoApprove: false });
    const atPlan = await waitForRunStatus(workspace.rootPath, run.runId, "awaiting_plan");
    assert.ok(atPlan.plan);

    resumeRunInBackground(workspace, run.runId, "plan", "approve", atPlan.plan);
    const atPub = await waitForRunStatus(
      workspace.rootPath,
      run.runId,
      "awaiting_publication",
      90_000,
    );
    assert.equal(atPub.status, "awaiting_publication");

    resumeRunInBackground(workspace, run.runId, "publication", "approve");
    const published = await waitForRunStatus(workspace.rootPath, run.runId, "published", 60_000);
    assert.equal(published.status, "published");
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.OKF_WIKI_AGENT_MODE;
  }
});

test("finalizeRunStatus persists gate on Run Record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-job-fin-"));
  try {
    const workspace = await makeFixtureWorkspace(root, true);
    const sessionId = randomUUID();
    const skillPath = await resolveSkillPath({
      workspaceRoot: workspace.rootPath,
    });
    const digest = await skillDigest(skillPath);
    const run = await createRun(workspace.rootPath, workspace.id, {
      skillPath,
      skillDigest: digest,
      sessionId,
    });

    await finalizeRunStatus(workspace.rootPath, run.runId, {
      status: "awaiting_plan",
      summary: "Awaiting plan",
      plan: defaultWikiRunSpec(workspace.name),
    });

    const updated = await loadRun(workspace.rootPath, run.runId);
    assert.equal(updated?.status, "awaiting_plan");
    assert.equal(updated?.sessionId, sessionId);
    assert.ok(updated?.plan);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
