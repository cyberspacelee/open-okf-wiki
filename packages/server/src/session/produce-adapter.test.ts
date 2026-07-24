/**
 * produce_progress job events are not product injects; parent trail is wiki_produce tool.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getRecentAgentSessionEvents,
  resetAgentSessionEventBusesForTests,
} from "../agent-session-events.ts";
import { mapOrchestratorOnEvent } from "./produce-adapter.ts";

describe("mapOrchestratorOnEvent — produce_progress", () => {
  it("does not emit product inject or okf.produce_progress SSE for produce_progress", () => {
    resetAgentSessionEventBusesForTests();
    const entry = {
      workspaceId: "ws1",
      sessionId: "sess1",
      runId: "run1",
      workspaceRoot: "/tmp/ws1",
    };
    const onEvent = mapOrchestratorOnEvent(entry);
    onEvent({
      type: "produce_progress",
      message: "running",
      data: { role: "planner", status: "running", unitId: "planner" },
    });
    const recent = getRecentAgentSessionEvents("ws1", "sess1");
    assert.equal(recent.length, 0);
  });

  it("still maps phase to product run_phase", () => {
    resetAgentSessionEventBusesForTests();
    const entry = {
      workspaceId: "ws2",
      sessionId: "sess2",
      runId: "run2",
      workspaceRoot: "/tmp/ws2",
    };
    const onEvent = mapOrchestratorOnEvent(entry);
    onEvent({ type: "phase", message: "producing", data: { label: "writing" } });
    const recent = getRecentAgentSessionEvents("ws2", "sess2");
    assert.ok(recent.some((e) => e.source === "product" && e.kind === "run_phase"));
  });
});
