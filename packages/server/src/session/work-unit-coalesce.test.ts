/**
 * work_unit emit coalescing: pure message streaming vs structural/terminal.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ProductWorkUnitEvent } from "@okf-wiki/contract";
import {
  createWorkUnitCoalescer,
  isCoalesceableWorkUnitUpdate,
  WORK_UNIT_COALESCE_MS,
  type WorkUnitCoalesceTimers,
} from "./work-unit-coalesce.ts";

function unit(
  overrides: Partial<ProductWorkUnitEvent> &
    Pick<ProductWorkUnitEvent, "unitId" | "status">,
): ProductWorkUnitEvent {
  return {
    source: "product",
    kind: "work_unit",
    sessionId: "sess-1",
    runId: "run-1",
    role: "leaf",
    updatedAt: 1,
    timestamp: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

/** Manual fake timers: track scheduled callbacks without wall clock. */
function createFakeTimers(): WorkUnitCoalesceTimers & {
  advance(ms: number): void;
  pendingCount(): number;
} {
  let nextId = 1;
  let now = 0;
  const jobs = new Map<number, { due: number; fn: () => void }>();

  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      jobs.set(id, { due: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      jobs.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      const due = [...jobs.entries()]
        .filter(([, j]) => j.due <= now)
        .sort((a, b) => a[1].due - b[1].due);
      for (const [id, job] of due) {
        jobs.delete(id);
        job.fn();
      }
    },
    pendingCount() {
      return jobs.size;
    },
  };
}

test("isCoalesceableWorkUnitUpdate: pure message streaming only", () => {
  const open = unit({ unitId: "u1", status: "running" });
  const msg1 = unit({
    unitId: "u1",
    status: "running",
    message: { text: "a" },
    updatedAt: 2,
  });
  const msg2 = unit({
    unitId: "u1",
    status: "running",
    message: { text: "ab", thinking: "hmm" },
    updatedAt: 3,
  });
  assert.equal(isCoalesceableWorkUnitUpdate(undefined, open), false);
  assert.equal(isCoalesceableWorkUnitUpdate(open, msg1), true);
  assert.equal(isCoalesceableWorkUnitUpdate(msg1, msg2), true);

  const pending = unit({ unitId: "u1", status: "pending" });
  assert.equal(isCoalesceableWorkUnitUpdate(open, pending), false);

  const settled = unit({
    unitId: "u1",
    status: "settled",
    message: { text: "done" },
    summary: "ok",
  });
  assert.equal(isCoalesceableWorkUnitUpdate(msg2, settled), false);

  const withTool = unit({
    unitId: "u1",
    status: "running",
    message: { text: "ab" },
    tools: [
      {
        toolCallId: "t1",
        toolName: "read",
        state: "input-available",
      },
    ],
  });
  assert.equal(isCoalesceableWorkUnitUpdate(msg2, withTool), false);
});

test("open/pending and first running emit immediately", () => {
  const emitted: ProductWorkUnitEvent[] = [];
  const timers = createFakeTimers();
  const c = createWorkUnitCoalescer({
    emit: (e) => emitted.push(e),
    timers,
  });

  c.push(unit({ unitId: "u1", status: "pending" }));
  c.push(unit({ unitId: "u1", status: "running", task: "write page" }));
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0]?.status, "pending");
  assert.equal(emitted[1]?.status, "running");
  assert.equal(timers.pendingCount(), 0);
});

test("pure message updates coalesce to latest within window", () => {
  const emitted: ProductWorkUnitEvent[] = [];
  const timers = createFakeTimers();
  const c = createWorkUnitCoalescer({
    emit: (e) => emitted.push(e),
    timers,
    windowMs: WORK_UNIT_COALESCE_MS,
  });

  c.push(unit({ unitId: "u1", status: "running" }));
  assert.equal(emitted.length, 1);

  c.push(
    unit({
      unitId: "u1",
      status: "running",
      message: { text: "h" },
      updatedAt: 10,
    }),
  );
  c.push(
    unit({
      unitId: "u1",
      status: "running",
      message: { text: "he" },
      updatedAt: 11,
    }),
  );
  c.push(
    unit({
      unitId: "u1",
      status: "running",
      message: { text: "hello", thinking: "plan" },
      updatedAt: 12,
    }),
  );

  // Still only the open snapshot until timer fires.
  assert.equal(emitted.length, 1);
  assert.equal(timers.pendingCount(), 1);

  timers.advance(WORK_UNIT_COALESCE_MS - 1);
  assert.equal(emitted.length, 1);

  timers.advance(1);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]?.message?.text, "hello");
  assert.equal(emitted[1]?.message?.thinking, "plan");
  assert.equal(emitted[1]?.updatedAt, 12);
  assert.equal(timers.pendingCount(), 0);
});

test("tool map change flushes immediately (drops superseded pending body)", () => {
  const emitted: ProductWorkUnitEvent[] = [];
  const timers = createFakeTimers();
  const c = createWorkUnitCoalescer({
    emit: (e) => emitted.push(e),
    timers,
  });

  c.push(unit({ unitId: "u1", status: "running" }));
  c.push(
    unit({
      unitId: "u1",
      status: "running",
      message: { text: "partial" },
      updatedAt: 2,
    }),
  );
  assert.equal(emitted.length, 1);
  assert.equal(timers.pendingCount(), 1);

  const toolSnap = unit({
    unitId: "u1",
    status: "running",
    message: { text: "partial" },
    tools: [
      {
        toolCallId: "tc1",
        toolName: "read",
        state: "input-available",
        input: { path: "a.ts" },
      },
    ],
    updatedAt: 3,
  });
  c.push(toolSnap);

  // Pending message superseded; tool snapshot emitted now.
  assert.equal(timers.pendingCount(), 0);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]?.tools?.[0]?.toolCallId, "tc1");

  // Tool state change also immediate.
  c.push(
    unit({
      unitId: "u1",
      status: "running",
      message: { text: "partial" },
      tools: [
        {
          toolCallId: "tc1",
          toolName: "read",
          state: "output-available",
          input: { path: "a.ts" },
          output: { content: "body" },
        },
      ],
      updatedAt: 4,
    }),
  );
  assert.equal(emitted.length, 3);
  assert.equal(emitted[2]?.tools?.[0]?.state, "output-available");
});

test("settled flushes pending coalesced snapshot first, then terminal", () => {
  const emitted: ProductWorkUnitEvent[] = [];
  const timers = createFakeTimers();
  const c = createWorkUnitCoalescer({
    emit: (e) => emitted.push(e),
    timers,
  });

  c.push(unit({ unitId: "u1", status: "running" }));
  c.push(
    unit({
      unitId: "u1",
      status: "running",
      message: { text: "almost" },
      updatedAt: 2,
    }),
  );
  assert.equal(emitted.length, 1);

  c.push(
    unit({
      unitId: "u1",
      status: "settled",
      message: { text: "final" },
      summary: "done",
      updatedAt: 3,
    }),
  );

  assert.equal(emitted.length, 3);
  assert.equal(emitted[1]?.status, "running");
  assert.equal(emitted[1]?.message?.text, "almost");
  assert.equal(emitted[2]?.status, "settled");
  assert.equal(emitted[2]?.message?.text, "final");
  assert.equal(emitted[2]?.summary, "done");
  assert.equal(timers.pendingCount(), 0);
});

test("failed flushes pending then terminal; never drops failed", () => {
  const emitted: ProductWorkUnitEvent[] = [];
  const timers = createFakeTimers();
  const c = createWorkUnitCoalescer({
    emit: (e) => emitted.push(e),
    timers,
  });

  c.push(unit({ unitId: "u1", status: "running" }));
  c.push(
    unit({
      unitId: "u1",
      status: "running",
      message: { text: "…" },
      updatedAt: 2,
    }),
  );
  c.push(
    unit({
      unitId: "u1",
      status: "failed",
      error: "boom",
      updatedAt: 3,
    }),
  );

  assert.equal(emitted.length, 3);
  assert.equal(emitted[1]?.status, "running");
  assert.equal(emitted[2]?.status, "failed");
  assert.equal(emitted[2]?.error, "boom");
});

test("units are independent; flushAll drains all pending", () => {
  const emitted: ProductWorkUnitEvent[] = [];
  const timers = createFakeTimers();
  const c = createWorkUnitCoalescer({
    emit: (e) => emitted.push(e),
    timers,
  });

  c.push(unit({ unitId: "a", status: "running" }));
  c.push(unit({ unitId: "b", status: "running" }));
  c.push(
    unit({
      unitId: "a",
      status: "running",
      message: { text: "A" },
      updatedAt: 2,
    }),
  );
  c.push(
    unit({
      unitId: "b",
      status: "running",
      message: { text: "B" },
      updatedAt: 2,
    }),
  );
  assert.equal(emitted.length, 2);
  assert.equal(timers.pendingCount(), 2);

  c.flushAll();
  assert.equal(emitted.length, 4);
  const texts = emitted.slice(2).map((e) => e.message?.text).sort();
  assert.deepEqual(texts, ["A", "B"]);
  assert.equal(timers.pendingCount(), 0);
});

test("dispose cancels pending without emit", () => {
  const emitted: ProductWorkUnitEvent[] = [];
  const timers = createFakeTimers();
  const c = createWorkUnitCoalescer({
    emit: (e) => emitted.push(e),
    timers,
  });

  c.push(unit({ unitId: "u1", status: "running" }));
  c.push(
    unit({
      unitId: "u1",
      status: "running",
      message: { text: "x" },
      updatedAt: 2,
    }),
  );
  c.dispose();
  timers.advance(WORK_UNIT_COALESCE_MS * 2);
  assert.equal(emitted.length, 1);
  assert.equal(timers.pendingCount(), 0);
});
