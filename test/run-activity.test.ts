import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunActivity } from "../extensions/wiki/lib/run-activity.js";

test("RunActivity retains complete semantic history and replays finalized output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-activity-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const timeline = new RunActivity(root);
  const at = "2026-08-22T00:00:00.000Z";
  timeline.noteAgent("lead", "lead", undefined, "running");
  timeline.observe({ kind: "input", id: "input-1", at, text: "Generate the Wiki" });
  timeline.observe({ kind: "output", id: "output-1", at, text: "I will", status: "running" });
  timeline.observe({
    kind: "output",
    id: "output-1",
    at: "2026-08-22T00:00:01.000Z",
    text: "I will inspect the Source.",
    status: "complete",
    usage: { input: 100, output: 20, total: 120, turns: 2, toolCalls: 20 },
  });
  for (let index = 0; index < 20; index += 1) {
    timeline.observe({
      kind: "tool",
      id: `tool-${index}`,
      at,
      tool: "read",
      args: { path: `src/${index}.ts` },
      status: "complete",
      result: `result ${index}`,
    });
  }
  await timeline.flush();

  const reopened = await RunActivity.open(root);
  const lead = reopened.agents()[0];
  assert.equal(lead.agent, "lead");
  assert.equal(lead.activity.length, 22);
  assert.equal(lead.usage?.input, 100);
  assert.equal(lead.usage?.toolCalls, 20);
  assert.equal(lead.activity[1].at, at);
  assert.deepEqual(lead.activity.filter((entry) => entry.kind === "output").map((entry) => entry.text), ["I will inspect the Source."]);
  assert.ok(lead.activity.some((entry) => entry.id === "tool-0"));
  assert.ok(lead.activity.some((entry) => entry.id === "tool-19" && entry.kind === "tool" && entry.result === "result 19"));
});
