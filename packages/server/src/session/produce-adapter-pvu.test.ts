/**
 * Parent Pi custom entry for settled PVUs (not LLM context, not fake tools).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendParentWorkUnitCustomEntry,
  OKF_WORK_UNIT_CUSTOM_TYPE,
} from "./produce-adapter.ts";
import type { WikiSessionHandle } from "@okf-wiki/agent";

test("appendParentWorkUnitCustomEntry writes settle-only custom entries", () => {
  const calls: Array<{ type: string; data: unknown }> = [];
  const handle = {
    session: {
      sessionManager: {
        appendCustomEntry(customType: string, data?: unknown) {
          calls.push({ type: customType, data });
          return "entry-1";
        },
      },
    },
  } as unknown as WikiSessionHandle;

  appendParentWorkUnitCustomEntry(handle, {
    unitId: "leaf-1",
    role: "leaf",
    status: "running",
    runId: "run-1",
    task: "research",
  });
  assert.equal(calls.length, 0, "running must not write custom entry");

  appendParentWorkUnitCustomEntry(handle, {
    unitId: "leaf-1",
    role: "leaf",
    status: "settled",
    runId: "run-1",
    task: "research",
    summary: "done",
    receiptPath: "analysis/receipts/leaf-1.json",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.type, OKF_WORK_UNIT_CUSTOM_TYPE);
  const data = calls[0]!.data as { unitId: string; summary?: string };
  assert.equal(data.unitId, "leaf-1");
  assert.equal(data.summary, "done");
});

test("appendParentWorkUnitCustomEntry no-ops without handle", () => {
  assert.doesNotThrow(() =>
    appendParentWorkUnitCustomEntry(undefined, {
      unitId: "x",
      role: "leaf",
      status: "failed",
      runId: "r",
      error: "boom",
    }),
  );
});
