import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "os";
import path from "node:path";
import test from "node:test";
import { createWikiDelegateContract } from "../dist/delegate-contracts.js";
import {
  createWikiRunRecord,
  projectRunView,
  UnsupportedWikiRunVersionError,
  WIKI_RUN_FORMAT,
} from "../dist/run-record.js";

async function root(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), "wiki-run-record-"));
  t.after(async () => await rm(value, { recursive: true, force: true }));
  return value;
}

const owner = { pid: process.pid };
const token = "execution-token-0000000000001";
const authority = { attempt: 1, executionToken: token };

function taskContract() {
  return createWikiDelegateContract(1, {
    id: "write-1", role: "write", instruction: "write", sourceScopeIds: ["source"],
    contextRefs: [], writePaths: ["wiki/overview.md"],
  });
}

function emptyLead(overrides = {}) {
  return {
    candidateRevision: 0,
    specRevision: 0,
    policyDigest: "a".repeat(64),
    compactionObserved: false,
    sourceScopeIds: ["source"],
    reviews: [],
    delegates: { batches: [] },
    ...overrides,
  };
}

function receiptFor(task) {
  return {
    id: task.id, role: task.role, status: "complete", summary: "written",
    outputs: [], coverage: ["wiki/overview.md"], gaps: [], attempts: 1,
    contractId: task.contractId, contractDigest: task.contractDigest,
  };
}

async function running(record, workspace) {
  await record.create({ id: "run-1", cwd: workspace, at: "2026-01-01T00:00:00.000Z" });
  await record.drive("run-1", { kind: "started", at: "2026-01-01T00:00:00.000Z" });
  await record.drive("run-1", { kind: "attempt_started", at: "2026-01-01T00:00:01.000Z", executionToken: token, owner });
}

function runningTask(task) {
  return { task, phase: "running", attempt: 1, collected: false };
}

function terminalTask(task) {
  return { task, phase: "terminal", attempt: 1, collected: false, receipt: receiptFor(task) };
}

test("list, view, and restore agree after a crash following commitLead", async (t) => {
  const workspace = await root(t);
  const task = taskContract();
  const setup = createWikiRunRecord(workspace);
  await running(setup, workspace);
  await setup.commitLead("run-1", emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [runningTask(task)] }] },
  }), authority);

  const live = createWikiRunRecord(workspace, {
    fault: async (point) => {
      if (point === "afterCommitLead") throw new Error("crash after control-plane commit");
    },
  });
  const settled = emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [terminalTask(task)] }] },
  });
  await assert.rejects(live.commitLead("run-1", settled, authority), /crash after control-plane commit/);

  const recovered = createWikiRunRecord(workspace);
  const listed = await recovered.list();
  const facts = await recovered.read("run-1");
  const view = projectRunView(facts);
  const resume = facts.lead.delegates.batches[0].tasks[0];

  assert.equal(listed[0].id, "run-1");
  assert.equal(projectRunView(listed[0]).progress.currentBatch.tasks[0].status, "complete");
  assert.equal(view.progress.currentBatch.tasks[0].status, "complete");
  assert.equal(resume.phase, "terminal");
  assert.equal(resume.receipt.summary, "written");
  assert.equal(listed[0].updatedAt, facts.updatedAt);
});

test("a crash before commitLead leaves list, view, and restore running", async (t) => {
  const workspace = await root(t);
  const task = taskContract();
  const setup = createWikiRunRecord(workspace);
  await running(setup, workspace);
  await setup.commitLead("run-1", emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [runningTask(task)] }] },
  }), authority);

  const live = createWikiRunRecord(workspace, {
    fault: async (point) => {
      if (point === "beforeCommitLead") throw new Error("crash before control-plane commit");
    },
  });

  await assert.rejects(live.commitLead("run-1", emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [terminalTask(task)] }] },
  }), authority), /crash before control-plane commit/);

  const recovered = createWikiRunRecord(workspace);
  const facts = await recovered.read("run-1");
  const view = projectRunView(facts);
  assert.equal(facts.lead.delegates.batches[0].tasks[0].phase, "running");
  assert.equal(facts.lead.delegates.batches[0].tasks[0].receipt, undefined);
  assert.equal(view.progress.currentBatch.tasks[0].status, "running");
  assert.equal(projectRunView((await recovered.list())[0]).progress.currentBatch.tasks[0].status, "running");
});

test("telemetry does not change a durable task phase", async (t) => {
  const workspace = await root(t);
  const task = taskContract();
  const record = createWikiRunRecord(workspace);
  await running(record, workspace);
  await record.commitLead("run-1", emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [runningTask(task)] }] },
  }), authority);

  await record.noteLive("run-1", {
    kind: "telemetry",
    target: { kind: "task", batch: 1, taskId: "write-1" },
    telemetry: {
      target: { kind: "task", batch: 1, taskId: "write-1" },
      attempt: 1,
      sampledAt: "2026-01-01T02:00:00.000Z",
      activity: "using_tool",
      activeTools: [{ name: "read", startedAt: "2026-01-01T02:00:00.000Z" }],
      process: [{
        sequence: 1, at: "2026-01-01T02:00:00.000Z", kind: "tool", severity: "info",
        message: "", toolCallId: "call-1", toolName: "read",
      }],
    },
  }, authority);

  const facts = await record.read("run-1");
  assert.equal(facts.lead.delegates.batches[0].tasks[0].phase, "running");
  const disk = JSON.parse(await readFile(path.join(workspace, "runs", "run-1", "run.json"), "utf8"));
  assert.equal(disk.progress, undefined);
  assert.equal(disk.version, 3);
  assert.equal(disk.version, WIKI_RUN_FORMAT);
  const tail = await record.readTail("run-1", { kind: "task", batch: 1, taskId: "write-1" });
  assert.equal(tail.agent.activity, "using_tool");
});

test("format 3 is current and older run.json snapshots fail closed", async (t) => {
  assert.equal(WIKI_RUN_FORMAT, 3);
  const workspace = await root(t);
  const record = createWikiRunRecord(workspace);
  await running(record, workspace);

  const runFile = path.join(workspace, "runs", "run-1", "run.json");
  const snapshot = JSON.parse(await readFile(runFile, "utf8"));
  assert.equal(snapshot.version, 3);
  for (const version of [1, 2]) {
    snapshot.version = version;
    await writeFile(runFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    await assert.rejects(createWikiRunRecord(workspace).read("run-1"), UnsupportedWikiRunVersionError);
  }

  const other = await root(t);
  const runDir = path.join(other, "runs", "old-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "lead-state.json"), `${JSON.stringify({ version: 1, runId: "old-run" })}\n`);
  await assert.rejects(createWikiRunRecord(other).read("old-run"), UnsupportedWikiRunVersionError);
});

test("a dead pid is stale and interrupt keeps delegates", async (t) => {
  const workspace = await root(t);
  const task = taskContract();
  const record = createWikiRunRecord(workspace);
  await running(record, workspace);
  await record.commitLead("run-1", emptyLead({
    delegates: { batches: [{ batchId: 1, tasks: [terminalTask(task)] }] },
  }), authority);
  assert.equal(await record.executionOwner("run-1"), "live");

  const runFile = path.join(workspace, "runs", "run-1", "run.json");
  const snapshot = JSON.parse(await readFile(runFile, "utf8"));
  snapshot.pid = 2 ** 22;
  await writeFile(runFile, `${JSON.stringify(snapshot, null, 2)}\n`);

  const fresh = createWikiRunRecord(workspace);
  assert.equal(await fresh.executionOwner("run-1"), "stale");
  await fresh.drive("run-1", { kind: "interrupted", at: "2026-01-01T00:00:09.000Z" });
  const facts = await fresh.read("run-1");
  assert.equal(facts.status, "paused");
  assert.equal(facts.lead.delegates.batches[0].tasks[0].phase, "terminal");
  assert.equal(facts.lead.delegates.batches[0].tasks[0].receipt.summary, "written");
});

function processTail(target, summaries, atBase, role = target.kind === "lead" ? "lead" : "write") {
  return {
    agent: {
      target, role, status: "running", attempt: 1, activity: "waiting_model",
      activeTools: [], health: "healthy", updatedAt: atBase,
    },
    process: summaries.map((summary, index) => ({
      sequence: index + 1,
      at: new Date(Date.parse(atBase) + index * 1000).toISOString(),
      kind: "tool",
      severity: "info",
      message: "",
      toolName: "read",
      summary,
      completed: true,
      target,
    })),
  };
}

test("run view keeps each agent's process after later batches", () => {
  const leadTarget = { kind: "lead" };
  const first = { kind: "task", batch: 1, taskId: "write-b1-t1" };
  const second = { kind: "task", batch: 2, taskId: "write-b2-t1" };
  const third = { kind: "task", batch: 3, taskId: "write-b3-t1" };
  const facts = {
    version: WIKI_RUN_FORMAT,
    id: "run-1",
    cwd: "/repo",
    status: "running",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T01:00:00.000Z",
    attempt: 1,
    executionToken: token,
    pid: 1,
    stage: "lead",
    lead: emptyLead({
      delegates: {
        batches: [1, 2, 3].map((batch) => ({
          batchId: batch,
          tasks: [terminalTask(createWikiDelegateContract(batch, {
            id: `write-b${batch}-t1`, role: "write", instruction: "write",
            sourceScopeIds: ["source"], contextRefs: [], writePaths: ["wiki/overview.md"],
          }))],
        })),
      },
    }),
  };
  const view = projectRunView(facts, [
    processTail(leadTarget, Array.from({ length: 8 }, (_, index) => `lead-${index + 1}.md`), "2026-08-12T00:00:00.000Z"),
    processTail(first, Array.from({ length: 12 }, (_, index) => `b1-${index + 1}.md`), "2026-08-12T00:10:00.000Z"),
    processTail(second, Array.from({ length: 12 }, (_, index) => `b2-${index + 1}.md`), "2026-08-12T00:20:00.000Z"),
    processTail(third, Array.from({ length: 12 }, (_, index) => `b3-${index + 1}.md`), "2026-08-12T00:30:00.000Z"),
  ]);
  assert.equal(view.progress.lead.process.length, 8);
  assert.equal(view.progress.lead.process[0].summary, "lead-1.md");
  assert.equal(view.progress.batches[0].tasks[0].process.length, 12);
  assert.equal(view.progress.batches[0].tasks[0].process[0].summary, "b1-1.md");
  assert.equal(view.progress.batches[2].tasks[0].process.at(-1).summary, "b3-12.md");
  assert.equal(view.progress.recentActivity.length, 20);
  assert.equal(view.progress.recentActivity[0].summary, "b2-5.md");
  assert.equal(view.progress.recentActivity.at(-1).summary, "b3-12.md");
});

test("duplicate task ids keep independent process tails across batches", async (t) => {
  const workspace = await root(t);
  const record = createWikiRunRecord(workspace);
  await running(record, workspace);
  const first = createWikiDelegateContract(1, {
    id: "write-auth", role: "write", instruction: "write", sourceScopeIds: ["source"],
    contextRefs: [], writePaths: ["wiki/overview.md"],
  });
  const second = createWikiDelegateContract(2, {
    id: "write-auth", role: "write", instruction: "write", sourceScopeIds: ["source"],
    contextRefs: [], writePaths: ["wiki/overview.md"],
  });
  await record.commitLead("run-1", emptyLead({
    delegates: { batches: [
      { batchId: 1, tasks: [terminalTask(first)] },
      { batchId: 2, tasks: [runningTask(second)] },
    ] },
  }), authority);
  await record.noteLive("run-1", {
    kind: "telemetry",
    target: { kind: "task", batch: 1, taskId: "write-auth" },
    telemetry: {
      target: { kind: "task", batch: 1, taskId: "write-auth" },
      attempt: 1,
      sampledAt: "2026-01-01T02:00:00.000Z",
      activity: "settled",
      process: [{
        sequence: 1, at: "2026-01-01T02:00:00.000Z", kind: "tool", severity: "info",
        message: "", toolName: "read", summary: "batch-1.md", completed: true,
        target: { kind: "task", batch: 1, taskId: "write-auth" },
      }],
    },
  }, authority);
  await record.noteLive("run-1", {
    kind: "telemetry",
    target: { kind: "task", batch: 2, taskId: "write-auth" },
    telemetry: {
      target: { kind: "task", batch: 2, taskId: "write-auth" },
      attempt: 1,
      sampledAt: "2026-01-01T03:00:00.000Z",
      activity: "using_tool",
      process: [{
        sequence: 1, at: "2026-01-01T03:00:00.000Z", kind: "tool", severity: "info",
        message: "", toolName: "read", summary: "batch-2.md", completed: true,
        target: { kind: "task", batch: 2, taskId: "write-auth" },
      }],
    },
  }, authority);
  assert.equal((await record.readTail("run-1", { kind: "task", batch: 1, taskId: "write-auth" })).process[0].summary, "batch-1.md");
  assert.equal((await record.readTail("run-1", { kind: "task", batch: 2, taskId: "write-auth" })).process[0].summary, "batch-2.md");
});

test("legacy task tails without a batch directory remain readable", async (t) => {
  const workspace = await root(t);
  const record = createWikiRunRecord(workspace);
  await running(record, workspace);
  const legacy = path.join(workspace, "runs", "run-1", "agents", "tasks", "write-1.json");
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, `${JSON.stringify({
    agent: {
      target: { kind: "task", batch: 1, taskId: "write-1" },
      role: "write", status: "running", attempt: 1, activity: "waiting_model",
      activeTools: [], health: "healthy", updatedAt: "2026-01-01T02:00:00.000Z",
    },
    process: [{
      sequence: 1, at: "2026-01-01T02:00:00.000Z", kind: "tool", severity: "info",
      message: "", toolName: "read", summary: "legacy.md", completed: true,
    }],
  })}\n`);
  assert.equal((await record.readTail("run-1", { kind: "task", batch: 1, taskId: "write-1" })).process[0].summary, "legacy.md");
});
