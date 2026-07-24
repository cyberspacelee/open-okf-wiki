import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordingProduceEvents } from "./events.js";

describe("produce coarse callbacks", () => {
  it("records phases, page status, and defects without a child trail", () => {
    const { sink, events } = recordingProduceEvents();

    sink.progress?.({ phase: "writing", written: 1, total: 2 });
    sink.planProgress?.({ pages: [{ path: "overview.md", status: "done" }] });
    sink.defects?.({ round: 1, clean: true, defectCount: 0 });

    assert.deepEqual(
      events.map((event) => event.kind),
      ["progress", "plan_progress", "defects"],
    );
  });
});
