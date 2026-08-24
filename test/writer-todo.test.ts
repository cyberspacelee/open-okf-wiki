import assert from "node:assert/strict";
import test from "node:test";
import { createWriterTodoTracker } from "../extensions/wiki/lib/writer-todo.js";

const signal = new AbortController().signal;

async function writeTodo(items: Array<{ path: string; status: "pending" | "in_progress" | "completed" }>) {
  const tracker = createWriterTodoTracker({ path: "billing", mode: "subtree" });
  const result = await tracker.tool.execute("todo", { action: "write", items }, signal, undefined, undefined);
  return { tracker, result };
}

test("Writer Todo enforces target ownership and complete Candidate coverage", async () => {
  const outside = await writeTodo([{ path: "wiki/checkout/domain.md", status: "pending" }]);
  assert.equal(outside.result.isError, true);

  const incomplete = await writeTodo([
    { path: "wiki/billing/domain.md", status: "completed" },
    { path: "wiki/billing/invoice/concept.md", status: "pending" },
  ]);
  assert.throws(
    () => incomplete.tracker.assertComplete(["billing/domain.md", "billing/invoice/concept.md"]),
    /Todo is incomplete/,
  );

  const complete = await writeTodo([
    { path: "wiki/billing/domain.md", status: "completed" },
    { path: "wiki/billing/invoice/concept.md", status: "completed" },
  ]);
  assert.doesNotThrow(() => complete.tracker.assertComplete([
    "billing/domain.md",
    "billing/invoice/concept.md",
  ]));
  assert.throws(
    () => complete.tracker.assertComplete([
      "billing/domain.md",
      "billing/invoice/concept.md",
      "billing/invoice/state.md",
    ]),
    /does not cover target pages/,
  );
});
