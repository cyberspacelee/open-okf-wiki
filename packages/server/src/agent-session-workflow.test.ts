import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WikiProduceToolDetails } from "@okf-wiki/contract";
import { addSource, createWorkspace, saveWorkspace } from "@okf-wiki/core";
import { subscribeAgentSessionEvents } from "./agent-session-events.ts";
import {
  dispatchAgentCommand,
  getActiveAgentSessionTool,
  registerAgentSession,
  resetAgentSessionRegistryForTests,
} from "./agent-session-registry.ts";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

async function removeRunRoot(root: string): Promise<void> {
  const makeWritable = async (entryPath: string): Promise<void> => {
    await chmod(entryPath, 0o700).catch(() => undefined);
    const entries = await readdir(entryPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(entryPath, entry.name);
      if (entry.isDirectory()) await makeWritable(child);
      else await chmod(child, 0o600).catch(() => undefined);
    }
  };
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

function detailsFromEvent(event: { payload?: unknown }): WikiProduceToolDetails | undefined {
  const payload = event.payload as {
    partialResult?: { details?: WikiProduceToolDetails };
    result?: { details?: WikiProduceToolDetails };
  };
  return payload?.partialResult?.details ?? payload?.result?.details;
}

test("fixture prompt emits genuine wiki_produce gate updates through Pi", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-session-workflow-"));
  const source = path.join(root, "source");
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  await mkdir(source, { recursive: true });
  git(source, "init");
  git(source, "config", "user.email", "fixture@example.test");
  git(source, "config", "user.name", "Fixture");
  await writeFile(path.join(source, "README.md"), "# Fixture\n", "utf8");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "fixture");

  let workspace = await createWorkspace({
    name: "Fixture Workflow",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);

  const sessionId = "fixture-workflow";
  await registerAgentSession({ workspace, sessionId });

  // A live Operator Session can outlive Workspace edits. wiki_produce must
  // resolve the saved Workspace when execution begins, not use this Session's
  // empty bootstrap snapshot.
  workspace = {
    ...(await addSource(workspace, { id: "main", path: source })).config,
    planConfirm: true,
  };
  await saveWorkspace(workspace);

  const events: Array<{ kind: string; payload?: unknown }> = [];
  const waiters = new Map<string, () => void>();
  const unsubscribe = subscribeAgentSessionEvents(workspace.id, sessionId, (event) => {
    events.push(event);
    const status = detailsFromEvent(event)?.status;
    if (status) waiters.get(status)?.();
  });
  t.after(unsubscribe);

  const waitForStatus = (status: string) =>
    new Promise<void>((resolve, reject) => {
      if (events.some((event) => detailsFromEvent(event)?.status === status)) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `missing ${status} Pi update; saw ${events
                .map((event) => detailsFromEvent(event)?.status ?? event.kind)
                .join(", ")}`,
            ),
          ),
        10_000,
      );
      waiters.set(status, () => {
        clearTimeout(timer);
        waiters.delete(status);
        resolve();
      });
    });

  const prompt = dispatchAgentCommand(workspace, sessionId, {
    type: "prompt",
    text: "Produce the wiki",
  });
  await waitForStatus("awaiting_plan");
  const plan = detailsFromEvent(
    events.find((event) => detailsFromEvent(event)?.status === "awaiting_plan")!,
  )!;
  assert.ok(plan.runId);
  const activePlan = getActiveAgentSessionTool(workspace.id, sessionId);
  assert.equal(activePlan?.details.status, "awaiting_plan");
  assert.equal(activePlan?.details.runId, plan.runId);
  assert.equal(activePlan?.toolName, "wiki_produce");
  assert.equal(
    (
      await dispatchAgentCommand(workspace, sessionId, {
        type: "resume_gate",
        gate: "plan",
        action: "approve",
        runId: plan.runId,
        spec: plan.spec,
      })
    ).ok,
    true,
  );

  await waitForStatus("awaiting_publication");
  const publication = detailsFromEvent(
    events.find((event) => detailsFromEvent(event)?.status === "awaiting_publication")!,
  )!;
  const activePublication = getActiveAgentSessionTool(workspace.id, sessionId);
  assert.equal(activePublication?.details.status, "awaiting_publication");
  assert.deepEqual(activePublication?.details.pages, publication.pages);
  assert.equal(
    (
      await dispatchAgentCommand(workspace, sessionId, {
        type: "resume_gate",
        gate: "publication",
        action: "approve",
        runId: publication.runId,
      })
    ).ok,
    true,
  );

  assert.equal((await prompt).ok, true);
  await waitForStatus("published");
  assert.equal(getActiveAgentSessionTool(workspace.id, sessionId), undefined);
  assert.ok(events.some((event) => event.kind === "tool_execution_start"));
  assert.ok(events.some((event) => event.kind === "tool_execution_end"));
});
