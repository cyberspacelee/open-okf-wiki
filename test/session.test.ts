import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runWikiSession } from "../extensions/wiki/lib/pi/session.js";

function fakeSession(events) {
  return {
    sessionFile: undefined,
    subscribe(listener) {
      for (const event of events) listener(event);
      return () => {};
    },
    async prompt() {},
    async waitForIdle() {},
    getLastAssistantText() { return "ok"; },
    dispose() {},
    abort() {},
  };
}

test("session forwards tool start, update, and end to onActivity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const events = [];
  const text = await runWikiSession(root, [], "unused", new AbortController().signal, {
    sessionDir: path.join(root, "sessions"),
    async createSession() {
      return {
        session: fakeSession([
          { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "src/a.ts" } },
          { type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: { path: "src/a.ts", offset: 1 } },
          { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {}, isError: false },
          { type: "tool_execution_start", toolCallId: "call-2", toolName: "grep", args: { pattern: "x" } },
          { type: "tool_execution_end", toolCallId: "call-2", toolName: "grep", result: {}, isError: true },
          { type: "message_update", message: {}, assistantMessageEvent: {} },
        ]),
        modelFallbackMessage: undefined,
      };
    },
    onActivity(event) {
      events.push(event);
    },
  });
  assert.equal(text, "ok");
  assert.deepEqual(events.map((event) => ({ id: event.id, tool: event.tool, status: event.status, args: event.args })), [
    { id: "call-1", tool: "read", status: "running", args: { path: "src/a.ts" } },
    { id: "call-1", tool: "read", status: "running", args: { path: "src/a.ts", offset: 1 } },
    { id: "call-1", tool: "read", status: "complete", args: { path: "src/a.ts", offset: 1 } },
    { id: "call-2", tool: "grep", status: "running", args: { pattern: "x" } },
    { id: "call-2", tool: "grep", status: "failed", args: { pattern: "x" } },
  ]);
});

test("session samples token usage on tool start and end", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-usage-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const events = [];
  await runWikiSession(root, [], "unused", new AbortController().signal, {
    sessionDir: path.join(root, "sessions"),
    async createSession() {
      const session = fakeSession([
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "ls", args: { path: "." } },
        { type: "tool_execution_end", toolCallId: "call-1", toolName: "ls", result: {}, isError: false },
      ]);
      session.getSessionStats = () => ({ tokens: { input: 10, output: 4, total: 14 } });
      return { session, modelFallbackMessage: undefined };
    },
    onActivity(event) {
      events.push(event);
    },
  });
  assert.deepEqual(events[0].usage, { input: 10, output: 4, total: 14 });
  assert.deepEqual(events[1].usage, { input: 10, output: 4, total: 14 });
});

test("session applies workspace retry controls to Pi settings", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-retry-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  let retry;
  let provider;
  await runWikiSession(root, [], "unused", new AbortController().signal, {
    transientRetries: 5,
    baseRetryDelayMs: 750,
    async createSession(options) {
      retry = options.settingsManager.getRetrySettings();
      provider = options.settingsManager.getProviderRetrySettings();
      return { session: fakeSession([]), modelFallbackMessage: undefined };
    },
  });
  assert.deepEqual(retry, { enabled: true, maxRetries: 5, baseDelayMs: 750 });
  assert.equal(provider.maxRetries, 5);
});
