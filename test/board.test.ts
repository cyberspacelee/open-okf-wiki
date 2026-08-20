import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createBoardStore,
  emptyBoard,
  formatBoard,
  replaceBoard,
} from "../extensions/wiki/lib/board.js";

test("replaceBoard assigns ids, keeps a goal, and allows one in_progress task", () => {
  const board = replaceBoard(emptyBoard("Auth wiki"), {
    tasks: [
      { content: "Survey the source", status: "completed" },
      { id: "write-overview", content: "Write overview.md", status: "in_progress", note: "started" },
      { content: "Review pages", status: "pending" },
    ],
  });
  assert.equal(board.goal, "Auth wiki");
  assert.deepEqual(board.tasks.map((task) => task.id), ["1", "write-overview", "3"]);
  assert.match(formatBoard(board), /Goal: Auth wiki/);
  assert.match(formatBoard(board), /\[>\] write-overview: Write overview.md — started/);
  assert.throws(
    () => replaceBoard(board, {
      tasks: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    }),
    /at most one in_progress/,
  );
});

test("board store survives a new reader on the same run directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-board-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const store = createBoardStore(root, emptyBoard("initial"));
  await store.write(replaceBoard(await store.read(), {
    goal: "Keep the goal after compaction",
    tasks: [{ id: "survey", content: "Map domains", status: "in_progress" }],
  }));
  const restored = createBoardStore(root);
  const board = await restored.read();
  assert.equal(board.goal, "Keep the goal after compaction");
  assert.equal(board.tasks[0]?.status, "in_progress");
  assert.match(await readFile(path.join(root, "board.json"), "utf8"), /Keep the goal/);
});

test("board rejects an oversized recovery frame before persistence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-board-budget-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const store = createBoardStore(root, emptyBoard("initial"));
  await store.write(emptyBoard("initial"));
  await assert.rejects(() => store.write({
    goal: "large",
    tasks: [{ id: "large", content: "界".repeat(1_600), status: "in_progress" }],
  }), /1500-token recovery budget/);
  assert.equal((await store.read()).goal, "initial");
});
