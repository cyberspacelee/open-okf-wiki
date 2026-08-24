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
  const result = await runWikiSession(root, [], "unused", new AbortController().signal, {
    sessionDir: path.join(root, "sessions"),
    async createSession() {
      return {
        session: fakeSession([
          { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "src/a.ts" } },
          { type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: { path: "src/a.ts", offset: 1 } },
          { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "file content" }] }, isError: false },
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
  assert.equal(result.text, "ok");
  assert.deepEqual(events.map((event) => ({ kind: event.kind, id: event.id, tool: event.tool, status: event.status, args: event.args, result: event.result })), [
    { kind: "tool", id: "call-1", tool: "read", status: "running", args: { path: "src/a.ts" }, result: undefined },
    { kind: "tool", id: "call-1", tool: "read", status: "running", args: { path: "src/a.ts", offset: 1 }, result: undefined },
    { kind: "tool", id: "call-1", tool: "read", status: "complete", args: { path: "src/a.ts", offset: 1 }, result: "file content" },
    { kind: "tool", id: "call-2", tool: "grep", status: "running", args: { pattern: "x" }, result: undefined },
    { kind: "tool", id: "call-2", tool: "grep", status: "failed", args: { pattern: "x" }, result: undefined },
  ]);
});

test("session forwards input and streaming assistant output as semantic activity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-messages-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const events = [];
  const input = { role: "user", content: "Inspect authentication", timestamp: Date.parse("2026-08-22T00:00:00.000Z") };
  const started = { role: "assistant", content: [], timestamp: Date.parse("2026-08-22T00:00:01.000Z"), stopReason: "stop" };
  const partial = { ...started, content: [{ type: "text", text: "I will inspect" }] };
  const completed = { ...started, content: [{ type: "text", text: "I will inspect authentication." }] };
  await runWikiSession(root, [], "unused", new AbortController().signal, {
    sessionDir: path.join(root, "sessions"),
    async createSession() {
      return {
        session: fakeSession([
          { type: "message_start", message: input },
          { type: "message_start", message: started },
          { type: "message_update", message: partial, assistantMessageEvent: {} },
          { type: "message_end", message: completed },
        ]),
        modelFallbackMessage: undefined,
      };
    },
    onActivity(event) { events.push(event); },
  });
  assert.deepEqual(events.map((event) => ({ kind: event.kind, text: event.text, status: event.status, at: event.at })), [
    { kind: "input", text: "Inspect authentication", status: undefined, at: "2026-08-22T00:00:00.000Z" },
    { kind: "output", text: "I will inspect", status: "running", at: "2026-08-22T00:00:01.000Z" },
    { kind: "output", text: "I will inspect authentication.", status: "complete", at: "2026-08-22T00:00:01.000Z" },
  ]);
  assert.equal(events[1].id, events[2].id);
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
      session.getSessionStats = () => ({
        tokens: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, total: 14 },
        assistantMessages: 2,
        toolCalls: 3,
        cost: 0,
      });
      session.getContextUsage = () => ({ tokens: 1200, contextWindow: 200000, percent: 6 });
      return { session, modelFallbackMessage: undefined };
    },
    onActivity(event) {
      events.push(event);
    },
  });
  assert.equal(events[0].usage.input, 10);
  assert.equal(events[0].usage.output, 4);
  assert.equal(events[0].usage.total, 14);
  assert.equal(events[0].usage.turns, 2);
  assert.equal(events[0].usage.toolCalls, 3);
  assert.equal(events[0].usage.contextTokens, 1200);
  assert.equal(events[0].usage.contextWindow, 200000);
  assert.equal(events[0].usage.contextPercent, 6);
  assert.equal(events[1].usage.contextPercent, 6);
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

test("session validates the latest assistant output before ending", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-completion-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const prompts = [];
  const checked = [];
  let output = "";
  const result = await runWikiSession(root, [], "initial", new AbortController().signal, {
    async createSession() {
      return {
        session: {
          sessionFile: undefined,
          subscribe() { return () => {}; },
          async prompt(value) {
            prompts.push(value);
            output = prompts.length === 1 ? "invalid" : "valid";
          },
          async waitForIdle() {},
          getLastAssistantText() { return output; },
          dispose() {},
          abort() {},
        },
        modelFallbackMessage: undefined,
      };
    },
    async nextPrompt(latest) {
      checked.push(latest);
      return latest === "invalid" ? "repair" : undefined;
    },
  });
  assert.deepEqual(prompts, ["initial", "repair"]);
  assert.deepEqual(checked, ["invalid", "valid"]);
  assert.equal(result.text, "valid");
});

test("compaction queues the cached checkpoint as an immediate follow-up", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-compaction-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const deliveries = [];
  const session = fakeSession([{ type: "compaction_end", aborted: false, result: {} }]);
  session.sendCustomMessage = async (message, options) => {
    deliveries.push({ message, options });
  };
  const result = await runWikiSession(root, [], "unused", new AbortController().signal, {
    async createSession() {
      return { session, modelFallbackMessage: undefined };
    },
    onCompaction() {
      return "<wiki_checkpoint>durable</wiki_checkpoint>";
    },
  });
  assert.equal(result.text, "ok");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].options.deliverAs, "followUp");
  assert.equal(deliveries[0].message.customType, "wiki-checkpoint");
  assert.match(deliveries[0].message.content, /durable/);
});

test("failed compaction does not queue a recovery follow-up", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-compaction-failed-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  let deliveries = 0;
  const session = fakeSession([{
    type: "compaction_end",
    aborted: false,
    result: undefined,
    willRetry: false,
    errorMessage: "Auto-compaction failed",
  }]);
  session.sendCustomMessage = async () => { deliveries += 1; };
  await runWikiSession(root, [], "unused", new AbortController().signal, {
    async createSession() {
      return { session, modelFallbackMessage: undefined };
    },
    onCompaction() {
      return "<wiki_checkpoint>durable</wiki_checkpoint>";
    },
  });
  assert.equal(deliveries, 0);
});

test("a missing resume file creates a fresh session with requested model settings", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-missing-resume-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  let created;
  await runWikiSession(root, [], "unused", new AbortController().signal, {
    sessionFile: path.join(root, "missing.jsonl"),
    model: { provider: "test", id: "model" },
    thinkingLevel: "high",
    async createSession(options) {
      created = options;
      return { session: fakeSession([]), modelFallbackMessage: undefined };
    },
  });
  assert.deepEqual(created.model, { provider: "test", id: "model" });
  assert.equal(created.thinkingLevel, "high");
});
