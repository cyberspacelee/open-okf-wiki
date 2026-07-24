import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WikiProduceToolDetails } from "@okf-wiki/contract";
import { addSource, createWorkspace, listRuns, saveWorkspace } from "@okf-wiki/core";
import { subscribeAgentSessionEvents } from "./agent-session-events.ts";
import {
  deleteAgentSession,
  dispatchAgentCommand,
  ensureRegistered,
  evictLiveAgentSessionForTests,
  listLiveAgentSessionSummaries,
  loadAgentSessionHistory,
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

async function fixtureWorkspace(root: string) {
  const source = path.join(root, "source");
  await mkdir(source, { recursive: true });
  git(source, "init");
  git(source, "config", "user.email", "fixture@example.test");
  git(source, "config", "user.name", "Fixture");
  await writeFile(path.join(source, "README.md"), "# Fixture\n", "utf8");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "fixture");

  let workspace = await createWorkspace({
    name: "Registry Fixture",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  workspace = {
    ...(await addSource(workspace, { id: "main", path: source })).config,
    planConfirm: true,
  };
  await saveWorkspace(workspace);
  return workspace;
}

const SECRET_ERROR =
  "HTTP 401 Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz " +
  "api_key=super-secret-value path=/home/cyberspace/projects/secret/key.json";

test("H1: history snapshot redacts secrets while Pi storage stays intact", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-history-redact-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "History Redact",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);

  const sessionId = "history-redact";
  await registerAgentSession({ workspace, sessionId });
  const entry = await ensureRegistered(workspace, sessionId);

  entry.handle.session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "failed" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: SECRET_ERROR,
    timestamp: Date.now(),
  } as never);

  const history = await loadAgentSessionHistory(workspace, sessionId);
  assert.ok(history);
  const serialized = JSON.stringify(history.messages);
  assert.equal(serialized.includes("sk-live"), false);
  assert.equal(serialized.includes("super-secret-value"), false);
  assert.equal(serialized.includes("/home/cyberspace"), false);
  assert.match(
    serialized,
    /\[redacted-key\]|Bearer \[redacted\]|api_key=\[redacted\]|\[redacted-path\]/,
  );

  // Pi-owned durable messages must not be mutated by the operator snapshot.
  const liveSerialized = JSON.stringify(
    entry.handle.session.sessionManager
      .getBranch()
      .filter((row) => row.type === "message")
      .map((row) => row.message),
  );
  assert.equal(liveSerialized.includes("sk-live-abcdefghijklmnopqrstuvwxyz"), true);
});

test("H1: prompt failure message redacts secrets from assistant errorMessage", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-prompt-redact-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "Prompt Redact",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "prompt-redact";
  await registerAgentSession({ workspace, sessionId });
  const entry = await ensureRegistered(workspace, sessionId);

  const secret = "provider exploded Bearer sk-proj-ABCDEFGHIJKLMNOP path=/home/runner/work/okf/key";
  // Force the prompt catch path (assignment shadows the prototype method).
  Object.defineProperty(entry.handle.session, "prompt", {
    configurable: true,
    value: async () => {
      throw new Error(secret);
    },
  });

  const response = await dispatchAgentCommand(workspace, sessionId, {
    type: "prompt",
    text: "hi",
  });
  assert.equal(response.ok, false);
  assert.equal(response.status, "failed");
  assert.ok(response.message);
  assert.equal(response.message.includes("sk-proj"), false);
  assert.equal(response.message.includes("/home/runner"), false);
  assert.match(response.message, /\[redacted-key\]|Bearer \[redacted\]|\[redacted-path\]/);
});

test("H1: live Pi subscribe emits redacted SSE payloads", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-sse-redact-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "SSE Redact",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "sse-redact";
  await registerAgentSession({ workspace, sessionId });
  const entry = await ensureRegistered(workspace, sessionId);

  const seen: unknown[] = [];
  const unsub = subscribeAgentSessionEvents(workspace.id, sessionId, (event) => {
    seen.push(event.payload);
  });
  t.after(unsub);

  const secretEvent = {
    type: "auto_retry_start",
    errorMessage: SECRET_ERROR,
  };

  // AgentSession keeps listeners in `_eventListeners` (pi-coding-agent). The
  // registry's redacting fan-out is one of them — fire it with a secret payload.
  const listeners = (
    entry.handle.session as unknown as {
      _eventListeners: Array<(event: unknown) => void>;
    }
  )._eventListeners;
  assert.ok(Array.isArray(listeners) && listeners.length > 0);
  for (const listener of listeners) {
    listener(secretEvent);
  }

  assert.ok(seen.length > 0, "registry should have fanned out a Pi SSE event");
  const blob = JSON.stringify(seen);
  assert.equal(blob.includes("sk-live"), false);
  assert.equal(blob.includes("super-secret-value"), false);
  assert.equal(blob.includes("/home/cyberspace"), false);
  assert.match(blob, /\[redacted-key\]|Bearer \[redacted\]|api_key=\[redacted\]|\[redacted-path\]/);
});

test("H2: concurrent ensureRegistered opens a single live SessionManager", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-open-race-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "Open Race",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "open-race";

  // Persist a real SessionManager JSONL (Pi only flushes after an assistant
  // message), then drop the live handle so the next ensureRegistered is cold.
  await registerAgentSession({ workspace, sessionId });
  const warm = await ensureRegistered(workspace, sessionId);
  warm.handle.session.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "persist me" }],
    timestamp: Date.now(),
  } as never);
  warm.handle.session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never);
  evictLiveAgentSessionForTests(workspace.id, sessionId);
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);

  const [a, b, c] = await Promise.all([
    ensureRegistered(workspace, sessionId),
    ensureRegistered(workspace, sessionId),
    ensureRegistered(workspace, sessionId),
  ]);

  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(a.handle, b.handle);
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 1);
  assert.equal(listLiveAgentSessionSummaries(workspace.id)[0]?.id, sessionId);
});

test("H2: delete wins over concurrent cold ensureRegistered (no reanimation)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-delete-open-race-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "Delete Open Race",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "delete-open-race";
  const sessionsDir = path.join(workspace.rootPath, ".okf-wiki", "pi-sessions");

  // Persist a real SessionManager JSONL, then drop the live handle so the next
  // ensureRegistered is a cold open that can race with delete.
  await registerAgentSession({ workspace, sessionId });
  const warm = await ensureRegistered(workspace, sessionId);
  warm.handle.session.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "persist me" }],
    timestamp: Date.now(),
  } as never);
  warm.handle.session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never);
  evictLiveAgentSessionForTests(workspace.id, sessionId);
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);
  const beforeFiles = await readdir(sessionsDir);
  assert.ok(
    beforeFiles.some((name) => name.includes(sessionId)),
    `expected persisted JSONL for ${sessionId}, got ${beforeFiles.join(", ")}`,
  );

  // Start cold open first so it is in-flight when delete begins, then race a
  // second waiter + delete. Delete must serialize against the open single-flight.
  const openA = ensureRegistered(workspace, sessionId).then(
    (entry) => ({ ok: true as const, entry }),
    (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const openB = ensureRegistered(workspace, sessionId).then(
    (entry) => ({ ok: true as const, entry }),
    (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  const dispatch = dispatchAgentCommand(workspace, sessionId, {
    type: "prompt",
    text: "hello after race",
  }).then(
    (response) => ({ ok: true as const, response }),
    (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }),
  );

  const deleted = await deleteAgentSession(workspace, sessionId);
  assert.ok(deleted.removed >= 1);

  const [a, b, cmd] = await Promise.all([openA, openB, dispatch]);
  // Waiters may succeed briefly (then be disposed) or reject with delete/not-found;
  // either way they must not leave a live reanimation after delete resolves.
  for (const result of [a, b]) {
    if (!result.ok) {
      assert.match(
        result.message,
        /deleted|not found|being deleted/i,
        `unexpected open failure: ${result.message}`,
      );
    }
  }
  void cmd; // may reject or return failed — disk/live assertions below are the contract

  // After delete resolves: no live entry, JSONL gone.
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);
  const afterFiles = await readdir(sessionsDir).catch(() => [] as string[]);
  assert.equal(
    afterFiles.some((name) => name.includes(sessionId)),
    false,
    `session JSONL must be gone after delete; found ${afterFiles.join(", ")}`,
  );

  // Post-delete open must fail (session is gone; product does not resurrect).
  await assert.rejects(
    () => ensureRegistered(workspace, sessionId),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not found|deleted/i);
      return true;
    },
  );
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);
  const finalFiles = await readdir(sessionsDir).catch(() => [] as string[]);
  assert.equal(
    finalFiles.some((name) => name.includes(sessionId)),
    false,
    `post-delete open must not recreate JSONL; found ${finalFiles.join(", ")}`,
  );
});

test("H2: concurrent delete is single-flight; create blocked mid-cascade", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-delete-flight-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await createWorkspace({
    name: "Delete Flight",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const sessionId = "delete-flight";

  await registerAgentSession({ workspace, sessionId });
  const entry = await ensureRegistered(workspace, sessionId);

  // Hold waitForSessionQuiet via registry busy (do not force isIdle=false —
  // that can stall session.abort() and empty the event loop).
  entry.busy = true;

  const deleteA = deleteAgentSession(workspace, sessionId);
  // Yield so delete marks the barrier and enters waitForSessionQuiet.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const deleteB = deleteAgentSession(workspace, sessionId);

  // Create with the same id must fail cleanly while delete is in flight.
  await assert.rejects(
    () => registerAgentSession({ workspace, sessionId }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /being deleted/i);
      return true;
    },
  );
  // Cold open must also refuse while the cascade holds the barrier.
  await assert.rejects(
    () => ensureRegistered(workspace, sessionId),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /being deleted/i);
      return true;
    },
  );

  // Release settle so both delete waiters can finish the shared flight.
  entry.busy = false;

  const [a, b] = await Promise.all([deleteA, deleteB]);
  assert.equal(a.sessionId, sessionId);
  assert.equal(b.sessionId, sessionId);
  assert.equal(a.removed, b.removed);
  assert.ok(a.removed >= 1);
  // Shared flight: no live entry left, no mid-cascade reopen window.
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);

  // After delete completes, create may reuse the id as a brand-new session.
  const recreated = await registerAgentSession({ workspace, sessionId });
  assert.equal(recreated.id, sessionId);
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 1);
});

test("H3: delete mid-gate aborts, settles, and cascades run data", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-registry-delete-gate-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await removeRunRoot(root);
  });

  const workspace = await fixtureWorkspace(root);
  const sessionId = "delete-mid-gate";
  await registerAgentSession({ workspace, sessionId });

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
              `missing ${status}; saw ${events
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
  const runId = plan.runId;
  const runDir = path.join(workspace.rootPath, ".okf-wiki", "runs", runId);
  await access(runDir);

  const deleted = await deleteAgentSession(workspace, sessionId);
  assert.ok(deleted.removed >= 1);

  // Prompt should settle without throw storms.
  const promptResult = await prompt;
  assert.equal(typeof promptResult.ok, "boolean");

  // Live cache cleared.
  assert.equal(listLiveAgentSessionSummaries(workspace.id).length, 0);

  // Run artifacts and session gone.
  await assert.rejects(access(runDir));
  await assert.rejects(access(path.join(workspace.rootPath, ".okf-wiki", "runs", `${runId}.json`)));
  const remaining = await listRuns(workspace.rootPath);
  assert.equal(remaining.filter((run) => run.sessionId === sessionId).length, 0);

  // Brief settle: no new run dirs reappear for this session.
  await new Promise((r) => setTimeout(r, 200));
  const remainingAfter = await listRuns(workspace.rootPath);
  assert.equal(remainingAfter.filter((run) => run.sessionId === sessionId).length, 0);
});
