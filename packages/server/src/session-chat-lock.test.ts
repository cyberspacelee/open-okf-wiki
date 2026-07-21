/**
 * Session chat concurrent-turn lock (in-process + durable TTL).
 * Focused unit coverage — no full HTTP boot, no fake exit 0.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isSessionChatInFlightForTests,
  isSessionChatTurnBlocked,
  sessionChatLockKey,
  setSessionChatInFlightForTests,
} from "./routes/sessions.ts";

test("sessionChatLockKey normalizes root path", () => {
  const a = sessionChatLockKey("/tmp/ws", "s1");
  const b = sessionChatLockKey("/tmp/ws/../ws", "s1");
  assert.equal(a, b);
  assert.match(a, /s1$/);
  assert.notEqual(
    sessionChatLockKey("/tmp/ws", "s1"),
    sessionChatLockKey("/tmp/ws", "s2"),
  );
});

test("isSessionChatTurnBlocked: in-process lock rejects any turn", () => {
  const session = {
    status: "active" as const,
    updatedAt: new Date().toISOString(),
  };
  assert.equal(
    isSessionChatTurnBlocked({
      inFlight: true,
      wouldRunWorkflow: false,
      session,
    }),
    true,
  );
  assert.equal(
    isSessionChatTurnBlocked({
      inFlight: false,
      wouldRunWorkflow: false,
      session,
    }),
    false,
  );
});

test("isSessionChatTurnBlocked: durable running TTL blocks workflow turns only", () => {
  const now = Date.now();
  const running = {
    status: "running" as const,
    updatedAt: new Date(now - 60_000).toISOString(),
  };
  const active = {
    status: "active" as const,
    updatedAt: new Date(now).toISOString(),
  };
  assert.equal(
    isSessionChatTurnBlocked({
      inFlight: false,
      wouldRunWorkflow: true,
      session: running,
      nowMs: now,
    }),
    true,
  );
  assert.equal(
    isSessionChatTurnBlocked({
      inFlight: false,
      wouldRunWorkflow: false,
      session: running,
      nowMs: now,
    }),
    false,
    "help/chat without workflow may proceed while status=running is stale edge",
  );
  assert.equal(
    isSessionChatTurnBlocked({
      inFlight: false,
      wouldRunWorkflow: true,
      session: active,
      nowMs: now,
    }),
    false,
  );

  // Stale running beyond TTL is not locked.
  const stale = {
    status: "running" as const,
    updatedAt: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
  };
  assert.equal(
    isSessionChatTurnBlocked({
      inFlight: false,
      wouldRunWorkflow: true,
      session: stale,
      nowMs: now,
    }),
    false,
  );
});

test("in-process Set: set/clear for tests is hermetic", () => {
  const key = sessionChatLockKey("/tmp/okf-lock-test", "sess-lock");
  setSessionChatInFlightForTests(key, false);
  assert.equal(isSessionChatInFlightForTests(key), false);
  setSessionChatInFlightForTests(key, true);
  assert.equal(isSessionChatInFlightForTests(key), true);
  assert.equal(
    isSessionChatTurnBlocked({
      inFlight: isSessionChatInFlightForTests(key),
      wouldRunWorkflow: true,
      session: {
        status: "active",
        updatedAt: new Date().toISOString(),
      },
    }),
    true,
  );
  setSessionChatInFlightForTests(key, false);
  assert.equal(isSessionChatInFlightForTests(key), false);
});
