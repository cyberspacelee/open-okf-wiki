import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseHandoff, parseReviewVerdict, verifyHandoff, writeHandoff } from "../extensions/wiki/lib/handoff.js";

test("writeHandoff round-trips through parse and verify", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-handoff-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const task = {
    id: "survey-abcd",
    agent: "survey",
    task: "Survey self",
    boardTaskId: "survey",
    partition: "self",
  };
  const relative = await writeHandoff({
    workspaceRoot: root,
    handoffsRoot: path.join(root, "handoffs"),
    task,
    text: "mapped the source",
    baseCandidateRevision: "abc",
  });
  const location = path.join(root, ...relative.split("/"));
  const parsed = parseHandoff(await readFile(location, "utf8"));
  assert.equal(parsed?.envelope.executionId, task.id);
  assert.match(parsed?.body ?? "", /mapped the source/);
  const verified = await verifyHandoff(location, {
    executionId: task.id,
    boardTaskId: task.boardTaskId,
    partition: task.partition,
    agent: task.agent,
    taskDigest: parsed.envelope.taskDigest,
  });
  assert.ok(verified);
  assert.equal(parseHandoff("not json\n<!-- wiki-handoff-body -->\n"), undefined);
  assert.equal(parseReviewVerdict("verdict: pass\n"), "pass");
  assert.equal(parseReviewVerdict("nope"), undefined);
});
