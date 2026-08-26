import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseHandoff, parseReviewVerdict, sealHandoff, verifyHandoff, workerOutputIssues } from "../extensions/wiki/lib/handoff.js";

const SURVEY_RECEIPT = [
  "## Source", "self", "## Domains", "none", "## Concepts", "none",
  "## Cross-Source leads", "none", "## Contract hints", "none",
  "## Tables", "none", "## Survey gaps", "none", "",
].join("\n\n");

test("sealHandoff round-trips through parse and verify", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-handoff-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const task = {
    id: "survey-abcd",
    agent: "survey",
    task: "Survey self",
    boardTaskId: "survey",
    partition: "self",
  };
  const relative = await sealHandoff({
    workspaceRoot: root,
    handoffsRoot: path.join(root, "handoffs"),
    task,
    text: SURVEY_RECEIPT,
    baseCandidateRevision: "abc",
  });
  const location = path.join(root, ...relative.split("/"));
  const parsed = parseHandoff(await readFile(location, "utf8"));
  assert.equal(parsed?.envelope.executionId, task.id);
  assert.match(parsed?.body ?? "", /## Source/);
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

test("worker handoffs reject empty required sections", () => {
  assert.ok(workerOutputIssues("survey", "").length > 0);
  assert.ok(workerOutputIssues("write", "## Status\n\nblocked").length > 0);
  assert.match(workerOutputIssues("survey", `I have enough evidence.\n\n${SURVEY_RECEIPT}`)[0] ?? "", /preamble/);
});

test("writer handoffs distinguish completed work from an evidence block", () => {
  const receipt = (status: string, gaps: string) => [
    "## Status", status,
    "## Written", "none",
    "## Rejected hints", "none",
    "## Evidence gaps", gaps,
    "",
  ].join("\n\n");
  assert.deepEqual(workerOutputIssues("write", receipt("complete", "none")), []);
  assert.deepEqual(workerOutputIssues("write", receipt("blocked", "src/order.ts#L10-L20 lacks an enforcement point")), []);
  assert.match(workerOutputIssues("write", receipt("complete", "missing evidence"))[0] ?? "", /Evidence gaps/);
  assert.match(workerOutputIssues("write", receipt("blocked", "none"))[0] ?? "", /blocked/);
});

test("worker handoffs allow Run-language prose while keeping stable schema headings", () => {
  const synthesis = [
    "## Workspace", "这是工作区边界。", "## Relationships", "暂无已确认关系。",
    "## End-to-end flows", "暂无。", "## Shared contracts", "暂无。", "## Gaps", "没有缺口。", "",
  ].join("\n\n");
  assert.deepEqual(workerOutputIssues("synthesize", synthesis), []);
});

test("review output requires one complete repair record per failed page", () => {
  const pages = ["wiki/one.md", "wiki/two.md"];
  const incomplete = [
    "verdict: changes_requested", "", "## Coverage", "",
    "- page: wiki/one.md | result: changes_requested | evidence: src/one.ts#L1 contradicted",
    "- page: wiki/two.md | result: changes_requested | evidence: src/two.ts#L1 contradicted",
    "", "## Repairs", "", "partition: one", "page: wiki/one.md", "obligation: Details",
    "defect: wrong", "evidence: src/one.ts#L1", "acceptance: corrected", "",
  ].join("\n");
  assert.deepEqual(workerOutputIssues("review", incomplete, pages), ["Missing repair record for wiki/two.md"]);
  const complete = `${incomplete.trim()}\n\npartition: two\npage: wiki/two.md\nobligation: Details\ndefect: wrong\nevidence: src/two.ts#L1\nacceptance: corrected\n`;
  assert.deepEqual(workerOutputIssues("review", complete, pages), []);
});
