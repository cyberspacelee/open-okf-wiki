import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runWikiSession } from "../extensions/wiki/lib/pi/session.js";

test("session forwards tool_execution_start to onActivity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-session-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const events = [];
  const text = await runWikiSession(root, [], "unused", new AbortController().signal, {
    sessionDir: path.join(root, "sessions"),
    async createSession() {
      return {
        session: {
          sessionFile: undefined,
          subscribe(listener) {
            listener({
              type: "tool_execution_start",
              toolCallId: "call-1",
              toolName: "read",
              args: { path: "src/a.ts" },
            });
            return () => {};
          },
          async prompt() {},
          async waitForIdle() {},
          getLastAssistantText() { return "ok"; },
          dispose() {},
          abort() {},
        },
        modelFallbackMessage: undefined,
      };
    },
    onActivity(event) {
      events.push(event);
    },
  });
  assert.equal(text, "ok");
  assert.equal(events.length, 1);
  assert.equal(events[0].tool, "read");
  assert.deepEqual(events[0].args, { path: "src/a.ts" });
});
