import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createOperatorSession, type OperatorSessionHistory } from "@okf-wiki/agent";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { createWorkspace, saveWorkspace } from "@okf-wiki/core";
import { emitAgentSessionEvent } from "../agent-session-events.ts";
import { resetAgentSessionRegistryForTests } from "../agent-session-registry.ts";
import { dispatch } from "../dispatch.ts";
import { handleAgentSessionEvents } from "./agent-sessions.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function nextSseData(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<unknown> {
  const decoder = new TextDecoder();
  for (;;) {
    const split = state.buffer.indexOf("\n\n");
    if (split >= 0) {
      const frame = state.buffer.slice(0, split);
      state.buffer = state.buffer.slice(split + 2);
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (data) return JSON.parse(data) as unknown;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("SSE ended before the next event");
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

test("Operator Session SSE starts with a durable snapshot then forwards genuine Pi events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-session-sse-"));
  const workspace = await createWorkspace({
    name: "Session SSE",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);

  const sessionId = "session-sse-1";
  const handle = await createOperatorSession({
    workspace,
    sessionId,
    wikiProduce: {
      fixture: true,
      gateCoordinator: {
        waitForDecision: async () => ({ action: "deny" as const }),
      },
    },
  });
  handle.session.setSessionName("Durable Pi Session");
  handle.session.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hello from durable JSONL" }],
    timestamp: Date.now(),
  });
  handle.session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "durable reply" }],
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
  });
  handle.dispose();

  const server = createServer((req, res) => void dispatch(req, res));
  const abort = new AbortController();
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url =
      "http://127.0.0.1:" +
      address.port +
      "/api/workspaces/" +
      workspace.id +
      "/agent/sessions/" +
      sessionId +
      "/events?rootPath=" +
      encodeURIComponent(root);
    const response = await fetch(url, { signal: abort.signal });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const state = { buffer: "" };

    const first = (await nextSseData(reader, state)) as {
      source?: string;
      kind?: string;
      sequence?: number;
      payload?: { messages?: Array<{ role?: string; content?: unknown }> };
    };
    assert.equal(first.source, "server");
    assert.equal(first.kind, "snapshot");
    assert.equal(first.sequence, undefined);
    assert.equal(first.payload?.messages?.[0]?.role, "user");

    const piEvent = {
      source: "pi" as const,
      kind: "message_end",
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "real Pi event" }],
        },
      },
    };
    emitAgentSessionEvent(workspace.id, sessionId, piEvent);

    const second = (await nextSseData(reader, state)) as Record<string, unknown>;
    assert.equal(second.sequence, undefined);
    assert.deepEqual(second, piEvent);
  } finally {
    abort.abort();
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a live Pi Session supports SSE before its first assistant message is persisted", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-live-session-sse-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await rm(root, { recursive: true, force: true });
  });

  const workspace = await createWorkspace({
    name: "Live Session SSE",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);

  const server = createServer((req, res) => void dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}/agent/sessions`;
  const query = `?rootPath=${encodeURIComponent(root)}`;
  const sessionId = "live-session-sse-1";

  const created = await fetch(`${base}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(created.status, 201, await created.clone().text());

  const abort = new AbortController();
  const response = await fetch(`${base}/${sessionId}/events${query}`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const snapshot = (await nextSseData(reader, { buffer: "" })) as {
    source?: string;
    kind?: string;
    payload?: { messages?: unknown[] };
  };
  assert.equal(snapshot.source, "server");
  assert.equal(snapshot.kind, "snapshot");
  assert.deepEqual(snapshot.payload?.messages, []);
  await reader.cancel();
  abort.abort();

  const deleted = await fetch(`${base}/${sessionId}${query}`, { method: "DELETE" });
  assert.equal(deleted.status, 200, await deleted.clone().text());
});

test("SSE snapshots precede queued live events and include the genuine active tool", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-ordered-session-sse-"));
  const workspace = await createWorkspace({
    name: "Ordered Session SSE",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);

  const sessionId = "ordered-session-sse-1";
  const historyStarted = deferred<void>();
  const history = deferred<OperatorSessionHistory | null>();
  const spec = defaultWikiRunSpec("Reconnect");
  let activeStatus: "awaiting_plan" | "awaiting_publication" = "awaiting_plan";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    void handleAgentSessionEvents(req, res, workspace.id, sessionId, url, {
      loadHistory: async () => {
        historyStarted.resolve(undefined);
        return history.promise;
      },
      getActiveTool: () => ({
        toolCallId: "tool-live-1",
        toolName: "wiki_produce",
        details: {
          status: activeStatus,
          runId: "run-live-1",
          spec,
          summary: "Awaiting WikiRunSpec approval",
        },
      }),
    });
  });
  const abort = new AbortController();
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/events?rootPath=${encodeURIComponent(root)}`;
    const responsePromise = fetch(url, { signal: abort.signal });
    await within(historyStarted.promise, "history loader");

    activeStatus = "awaiting_publication";
    const piEvent = {
      source: "pi" as const,
      kind: "tool_execution_update",
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        type: "tool_execution_update",
        toolCallId: "tool-live-1",
        toolName: "wiki_produce",
        partialResult: {
          details: {
            status: activeStatus,
            runId: "run-live-1",
            spec,
            pages: ["overview.md"],
            summary: "Awaiting publication approval",
          },
        },
      },
    };
    emitAgentSessionEvent(workspace.id, sessionId, piEvent);
    history.resolve({
      sessionId,
      // Partial Pi assistant row for projector coverage; product does not re-type messages.
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-live-1",
              name: "wiki_produce",
              arguments: {},
            },
          ],
          timestamp: Date.now(),
        } as OperatorSessionHistory["messages"][number],
      ],
    });

    const response = await within(responsePromise, "SSE response");
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const state = { buffer: "" };
    const snapshot = (await nextSseData(reader, state)) as {
      kind?: string;
      payload?: { activeTool?: { toolCallId?: string; details?: { status?: string } } };
    };
    assert.equal(snapshot.kind, "snapshot");
    assert.equal(snapshot.payload?.activeTool?.toolCallId, "tool-live-1");
    assert.equal(snapshot.payload?.activeTool?.details?.status, "awaiting_plan");
    assert.deepEqual(await nextSseData(reader, state), piEvent);
    await reader.cancel();
  } finally {
    abort.abort();
    history.resolve({ sessionId, messages: [] });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("SSE disconnect during history load unsubscribes exactly once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-early-close-sse-"));
  const workspace = await createWorkspace({
    name: "Early Close SSE",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);

  const sessionId = "early-close-sse-1";
  const historyStarted = deferred<void>();
  const history = deferred<null>();
  const cleaned = deferred<void>();
  const handlerDone = deferred<void>();
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let handlerError: unknown;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    void handleAgentSessionEvents(req, res, workspace.id, sessionId, url, {
      loadHistory: async () => {
        historyStarted.resolve(undefined);
        return history.promise;
      },
      subscribe: () => {
        subscribeCalls += 1;
        return () => {
          unsubscribeCalls += 1;
          cleaned.resolve(undefined);
        };
      },
    })
      .catch((error: unknown) => {
        handlerError = error;
      })
      .finally(() => handlerDone.resolve(undefined));
  });

  let client: ReturnType<typeof httpRequest> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/events?rootPath=${encodeURIComponent(root)}`;
    client = httpRequest(url);
    client.on("error", () => undefined);
    client.end();

    await within(historyStarted.promise, "history loader");
    client.destroy();
    await within(cleaned.promise, "SSE cleanup");
    assert.equal(subscribeCalls, 1);
    assert.equal(unsubscribeCalls, 1);

    history.resolve(null);
    await within(handlerDone.promise, "SSE handler completion");
    assert.equal(handlerError, undefined);
    assert.equal(unsubscribeCalls, 1);
  } finally {
    client?.destroy();
    history.resolve(null);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
