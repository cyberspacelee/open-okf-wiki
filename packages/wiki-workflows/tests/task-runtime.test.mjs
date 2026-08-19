import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiArtifactStore } from "../dist/artifact-store.js";
import { createWikiDelegateContract, WikiTaskExecutionError, WikiTaskPauseError } from "../dist/delegate-contracts.js";
import { WikiBudgetExhaustedError } from "../dist/failures.js";
import { WIKI_MANUAL_PAUSE } from "../dist/runtime-types.js";
import { classifyWikiAttemptFailure } from "../dist/failures.js";
import { WikiTaskRuntime, WikiWritePathLease } from "../dist/task-runtime.js";

function store() {
  const writes = [];
  return {
    writes,
    async write(input) {
      writes.push(input);
      const sha256 = createHash("sha256").update(input.content, "utf8").digest("hex");
      return { version: 1, runId: input.runId, contractId: input.contractId, attempt: input.attempt, scope: [...input.scope], kind: input.kind, relativePath: `.okf-wiki/blobs/${sha256}.md`, sha256, sizeBytes: Buffer.byteLength(input.content, "utf8"), mediaType: "text/markdown" };
    },
  };
}

function task(id, values = {}) {
  return { id, role: "research", instruction: `Research ${id}`, sourceScopeIds: ["api"], contextRefs: [], mode: "discovery", assignmentIds: [`${id}-assignment`], domainScopeIds: [], lensScopeIds: [], resolvesIds: [], ...values };
}

function runtime(agent, values = {}) {
  const { onStateChanged, restoredState, autoResearchCompletion = true, ...options } = values;
  const durable = normalizeState(restoredState ?? { batches: [] });
  const handoffAgent = {
    ...agent,
    async run(contract, context) {
      const result = await agent.run(contract, context);
      return result?.markdown ? {
        ...result,
        ...(contract.role === "research" && autoResearchCompletion && !result.research ? {
          status: "complete",
          research: {
            status: "complete",
            summary: result.summary,
            needsFollowup: false,
            followups: [],
            domains: [{ id: "core", conceptIds: [] }],
          },
        } : {}),
        markdown: testHandoff(contract, result.markdown),
      } : result;
    },
  };
  const subject = new WikiTaskRuntime({
    runId: "run-1", sourceScopes: ["api"], contextArtifacts: {},
    artifactStore: store(), agent: handoffAgent,
    restoredState: durable,
    ...memoryCommit(durable, onStateChanged),
    ...options,
  });
  nextBatches.set(subject, durable.batches.reduce((maximum, batch) => Math.max(maximum, batch.batchId + 1), 1));
  return subject;
}

function testHandoff(contract, body) {
  const role = contract.role === "research" ? "Research" : contract.role === "write" ? "Write" : "Review";
  const ids = contract.role === "research"
    ? contract.assignmentIds.map((id) => `assignment:${id}`).join("\n")
    : contract.role === "write"
      ? contract.writePaths.map((path) => `page:${path}`).join("\n")
      : "";
  const section = contract.role === "research" ? `## Scope\n${ids}\n## Coverage\n${ids}\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone`
    : contract.role === "write" ? `## Pages\n${ids}` : "## Findings\n";
  return `# ${role} Handoff\n${section}\n## Evidence\napi/test.ts#L1-L1\n\n${body}`;
}

async function runBatch(subject, tasks, signal = new AbortController().signal) {
  const { batchId } = await startBatch(subject, tasks, signal);
  return await subject.collect(batchId, { until: "all", timeoutSeconds: 60 });
}

const nextBatches = new WeakMap();
async function startBatch(subject, tasks, signal = new AbortController().signal) {
  const batchId = nextBatches.get(subject) ?? 1;
  const contracts = tasks.map((task) => contract(batchId, task));
  const result = await subject.start(contracts, signal);
  nextBatches.set(subject, batchId + 1);
  return result;
}

function contract(batchId, task) {
  const basis = task.role === "review" ? { version: 1, candidateRevision: 1, treeDigest: "a".repeat(64), policyDigest: "b".repeat(64), paths: task.reviewPaths } : undefined;
  return createWikiDelegateContract(batchId, task, basis);
}

function normalizeState(state) {
  return { batches: state.batches.map((batch) => ({ ...batch, tasks: batch.tasks.map((saved) => ({ ...saved, task: "contractVersion" in saved.task ? saved.task : contract(batch.batchId, saved.task) })) })) };
}

function memoryCommit(state, notify) {
  const publish = async () => await notify?.(structuredClone(state));
  const saved = (batchId, taskId) => state.batches.find((batch) => batch.batchId === batchId)?.tasks.find((task) => task.task.id === taskId);
  return {
    async onBatchQueued(contracts) {
      if (!state.batches.some((batch) => batch.batchId === contracts[0].batchId)) state.batches.push({ batchId: contracts[0].batchId, tasks: contracts.map((task) => ({ task, phase: "queued", attempt: 0, collected: false })) });
      await publish();
    },
    async onTaskStarted(batchId, taskId, input) { Object.assign(saved(batchId, taskId), { phase: "running", attempt: input.attempt, collected: false, sessionFile: input.sessionFile, partial: input.partial, pause: undefined, receipt: undefined }); await publish(); },
    async onTaskPaused(batchId, taskId, input) { Object.assign(saved(batchId, taskId), { phase: "paused", attempt: input.attempt, pause: input.pause, sessionFile: input.sessionFile, partial: input.partial }); await publish(); },
    async onTaskSettled(batchId, taskId, input) { Object.assign(saved(batchId, taskId), { phase: "terminal", attempt: input.attempt, receipt: input.receipt, sessionFile: input.sessionFile, pause: undefined, partial: undefined }); await publish(); },
    async onTasksCollected(batchId, taskIds) { for (const taskId of taskIds) saved(batchId, taskId).collected = true; await publish(); },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for test condition");
}

test("preflights source scopes, context refs, and overlapping write paths", async () => {
  const r = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) });
  await assert.rejects(runBatch(r, [task("bad", { sourceScopeIds: ["secret"] })]), /undeclared source scope/);
  await assert.rejects(runBatch(r, [task("bad-ref", { contextRefs: ["missing"] })]), /undeclared context artifact/);
  await assert.rejects(runBatch(r, [
    task("w1", { role: "write", writePaths: ["wiki/core/page.md"] }),
    task("w2", { role: "write", writePaths: ["wiki/core/page.md"] }),
  ]), /overlap/);
});

test("durable queued contract commit completes before an Agent can launch", async () => {
  let releaseQueue;
  let launched = false;
  const queued = new Promise((resolve) => { releaseQueue = resolve; });
  const commit = memoryCommit({ batches: [] });
  const subject = new WikiTaskRuntime({
    runId: "run-1", sourceScopes: ["api"], artifactStore: store(),
    agent: { async run(value) { launched = true; return { summary: "ok", markdown: testHandoff(value, "ok"), research: { status: "complete", summary: "ok", needsFollowup: false, followups: [], domains: [{ id: "core", conceptIds: [] }] } }; } },
    ...commit,
    async onBatchQueued(contracts) { await queued; await commit.onBatchQueued(contracts); },
  });
  const starting = subject.start([contract(1, task("ordered"))], new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launched, false);
  releaseQueue();
  const { batchId } = await starting;
  assert.equal((await subject.collect(batchId, { until: "all", timeoutSeconds: 1 })).status, "complete");
  assert.equal(launched, true);
});

test("durable transition failure is consumed and surfaced by collect", async () => {
  const commit = memoryCommit({ batches: [] });
  const subject = new WikiTaskRuntime({
    runId: "run-1", sourceScopes: ["api"], artifactStore: store(),
    agent: { async run(value) { return { summary: "ok", markdown: testHandoff(value, "ok"), research: { status: "complete", summary: "ok", needsFollowup: false, followups: [], domains: [{ id: "core", conceptIds: [] }] } }; } },
    ...commit,
    async onTaskSettled() { throw new Error("durable settle failed"); },
  });
  const { batchId } = await subject.start([contract(1, task("persist-failure"))], new AbortController().signal);
  await assert.rejects(subject.collect(batchId, { until: "all", timeoutSeconds: 1 }), /durable settle failed/);
});

test("preflights delegated writes with the publication path contract", async () => {
  const r = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) });
  for (const writePath of [
    "wiki/Architecture.md",
    "wiki/feature map.md",
    "wiki/wiki/architecture.md",
    "wiki/core//page.md",
    "wiki/index.md",
    "wiki/log.md",
  ]) {
    await assert.rejects(
      runBatch(r, [task("writer", { role: "write", writePaths: [writePath] })]),
      /Unsafe Wiki write path|Invalid Wiki writePaths/,
      writePath,
    );
  }

  const result = await runBatch(r, [
    task("root", { role: "write", writePaths: ["wiki/architecture.md"] }),
    task("nested", { role: "write", writePaths: ["wiki/core/page.md"] }),
  ]);
  assert.equal(result.status, "complete");
});

test("preserves successful branches when a fanout is partial", async () => {
  const r = runtime({
    async run(value) {
      if (value.id === "bad") throw new WikiTaskExecutionError("invalid", "schema");
      return { summary: "accepted", markdown: "# Accepted", coverage: ["entrypoint"] };
    },
  });
  const result = await runBatch(r, [task("good"), task("bad")]);
  assert.equal(result.status, "partial");
  assert.equal(result.receipts.find((value) => value.id === "good").outputs.length, 1);
  assert.equal(result.receipts.find((value) => value.id === "bad").status, "failed");
});

test("incomplete research with a long failure message still settles a byte-bounded tool_failure followup", async () => {
  const message = "😀".repeat(200);
  const r = runtime({
    run: async () => {
      throw new WikiTaskExecutionError(message, "schema", { partialMarkdown: "# Findings" });
    },
  }, { autoResearchCompletion: false });
  const result = await runBatch(r, [task("long-failure")]);
  assert.equal(result.receipts[0].status, "incomplete");
  assert.equal(result.receipts[0].error?.code, "schema");
  assert.equal(result.receipts[0].followups.length, 1);
  assert.equal(result.receipts[0].followups[0].kind, "tool_failure");
  assert.equal(Buffer.byteLength(result.receipts[0].followups[0].question, "utf8"), 512);
  assert.equal(result.receipts[0].followups[0].question, "😀".repeat(128));
});

test("research leaf without completion becomes schema-incomplete and retains its Markdown artifact", async () => {
  const artifacts = store();
  const r = runtime({ run: async () => ({ summary: "partial findings", markdown: "# Findings" }) }, {
    artifactStore: artifacts,
    autoResearchCompletion: false,
  });
  const result = await runBatch(r, [task("missing-completion")]);
  assert.equal(result.receipts[0].status, "incomplete");
  assert.equal(result.receipts[0].error?.code, "schema");
  assert.equal(result.receipts[0].outputs.length, 1);
  assert.equal(artifacts.writes.length, 1);
  assert.match(artifacts.writes[0].content, /# Research Handoff/);
});

test("TaskRuntime injects all host assignments for complete and none for incomplete", async () => {
  const complete = runtime({ run: async () => ({
    summary: "complete", markdown: "# Findings", research: {
      status: "complete", summary: "complete", needsFollowup: false, followups: [], domains: [{ id: "core", conceptIds: [] }],
    },
  }) }, { autoResearchCompletion: false });
  const completeResult = await runBatch(complete, [task("complete-host-coverage")]);
  assert.equal(completeResult.receipts[0].status, "complete");
  assert.deepEqual(completeResult.receipts[0].completedAssignmentIds, ["complete-host-coverage-assignment"]);

  const incomplete = runtime({ run: async () => ({
    summary: "incomplete", markdown: "# Findings", research: {
      status: "incomplete", summary: "incomplete", needsFollowup: true,
      followups: [{ kind: "tool_failure", question: "Retry source", sourceScopeIds: ["api"] }],
      domains: [],
    },
  }) }, { autoResearchCompletion: false });
  const incompleteResult = await runBatch(incomplete, [task("incomplete-host-coverage")]);
  assert.equal(incompleteResult.receipts[0].status, "incomplete");
  assert.deepEqual(incompleteResult.receipts[0].completedAssignmentIds, []);

  const invalid = runtime({ run: async () => ({
    summary: "missing blocker", markdown: "# Findings", research: {
      status: "incomplete", summary: "missing blocker", needsFollowup: false, followups: [], domains: [],
    },
  }) }, { autoResearchCompletion: false });
  const invalidResult = await runBatch(invalid, [task("invalid-incomplete")]);
  assert.equal(invalidResult.receipts[0].status, "incomplete");
  assert.equal(invalidResult.receipts[0].error?.code, "schema");
  assert.equal(invalidResult.receipts[0].completedAssignmentIds.length, 0);
});

test("receipts omit empty coverage and gaps while retaining non-empty values", async () => {
  const r = runtime({
    async run(value) {
      return {
        summary: value.id,
        markdown: value.id,
        ...(value.id === "with-details" ? {
          coverage: ["entrypoint"],
          gaps: [{ question: "Need one more source", sourceScopeIds: ["api"] }],
        } : {}),
      };
    },
  });
  const result = await runBatch(r, [task("without-details"), task("with-details")]);
  const empty = result.receipts.find((receipt) => receipt.id === "without-details");
  const detailed = result.receipts.find((receipt) => receipt.id === "with-details");
  assert.equal(Object.hasOwn(empty, "coverage"), false);
  assert.equal(Object.hasOwn(empty, "gaps"), false);
  assert.deepEqual(detailed.coverage, ["entrypoint"]);
  assert.deepEqual(detailed.gaps, [{ question: "Need one more source", sourceScopeIds: ["api"] }]);
});

test("provider errors fail the task without a wiki-level fresh session", async () => {
  for (const error of [
    new WikiTaskExecutionError("429", "rate_limit", { retryAfterMs: 250 }),
    Object.assign(new Error("400 Invalid Request"), { status: 400 }),
    new WikiTaskExecutionError("server unavailable", "server_error"),
  ]) {
    let calls = 0;
    const r = runtime({ async run() {
      calls += 1;
      throw error;
    } });
    const result = await runBatch(r, [task("provider")]);
    assert.equal(calls, 1, String(error));
    assert.equal(result.receipts[0].attempts, 1, String(error));
    assert.equal(result.receipts[0].error?.retryable, false, String(error));
  }
});

test("local schema and validation failures still do not retry", async () => {
  let calls = 0;
  const r = runtime({ async run() {
    calls += 1;
    throw new WikiTaskExecutionError("Wiki page validation failed", "schema");
  } });
  const result = await runBatch(r, [task("schema")]);
  assert.equal(calls, 1);
  assert.equal(result.receipts[0].attempts, 1);
  assert.equal(result.receipts[0].error?.retryable, false);
});

test("shared attempt classification treats provider 400 before the invalid-request trap", () => {
  const invalid = classifyWikiAttemptFailure(Object.assign(new Error("400 Invalid Request"), { status: 400 }));
  assert.equal(invalid.code, "server_error");
  assert.equal(invalid.retryable, false);

  const overflow = classifyWikiAttemptFailure(new Error("400 status code (no body)"));
  assert.equal(overflow.code, "context_exhausted");
  assert.equal(overflow.retryable, false);

  const qwen = classifyWikiAttemptFailure(new Error("Range of input length should be [1, 131072]"));
  assert.equal(qwen.code, "context_exhausted");
  assert.equal(qwen.retryable, false);

  const local = classifyWikiAttemptFailure(new Error("invalid request: missing model"));
  assert.equal(local.code, "invalid_request");
  assert.equal(local.retryable, false);
});

test("quota exits through control flow without a second session", async () => {
  let quotaAttempts = 0;
  const quota = runtime({ async run() {
    quotaAttempts += 1;
    throw new WikiTaskExecutionError("quota exceeded", "quota", { retryAfterMs: 30_000 });
  } });
  await assert.rejects(
    runBatch(quota, [task("quota")]),
    (error) => error instanceof WikiTaskPauseError && error.reason === "quota" && error.retryAfterMs === 30_000,
  );
  assert.equal(quotaAttempts, 1);
});

test("timeout and context exhaustion return incomplete receipts and retain sealed partial Markdown", async () => {
  for (const code of ["timeout", "context_exhausted"]) {
    const artifacts = store();
    let calls = 0;
    const r = runtime({ async run() {
      calls += 1;
      throw new WikiTaskExecutionError(code, code, { partialMarkdown: `# Partial ${code}`, coverage: ["partial"] });
    } }, { artifactStore: artifacts });
    const result = await runBatch(r, [task(code)]);
    assert.equal(result.receipts[0].status, "incomplete");
    assert.equal(result.receipts[0].outputs.length, 1);
    assert.equal(result.receipts[0].attempts, 1);
    assert.equal(calls, 1);
    assert.equal(artifacts.writes.length, 1);
  }
});

test("batch of two tasks emits queued then interleaved start/end progress", async () => {
  /** @type {WikiTaskProgressEvent[]} */
  const events = [];
  const r = runtime({
    async run() {
      return { summary: "ok", markdown: "ok" };
    },
  }, {
    onTask(event) {
      events.push(event);
    },
  });
  const result = await runBatch(r, [task("a"), task("b")]);
  assert.equal(result.status, "complete");
  const phases = events.map((event) => event.phase);
  assert.deepEqual(phases.slice(0, 2), ["queued", "queued"]);
  const rest = phases.slice(2);
  assert.equal(rest.filter((phase) => phase === "start").length, 2);
  assert.equal(rest.filter((phase) => phase === "end").length, 2);
  assert.ok(rest.every((phase) => phase === "start" || phase === "end"));
  assert.equal(events.filter((event) => event.phase === "end" && event.receipt).length, 2);
});

test("failed and incomplete tasks still emit end with receipt status", async () => {
  /** @type {WikiTaskProgressEvent[]} */
  const failedEvents = [];
  const failed = runtime({
    async run() {
      throw new WikiTaskExecutionError("invalid", "schema");
    },
  }, {
    onTask(event) {
      failedEvents.push(event);
    },
  });
  const failedResult = await runBatch(failed, [task("fail")]);
  assert.equal(failedResult.receipts[0].status, "failed");
  const failedEnd = failedEvents.find((event) => event.phase === "end");
  assert.ok(failedEnd);
  assert.equal(failedEnd.receipt?.status, "failed");

  /** @type {WikiTaskProgressEvent[]} */
  const incompleteEvents = [];
  const incomplete = runtime({
    async run() {
      throw new WikiTaskExecutionError("timed out", "timeout", { partialMarkdown: "# Partial" });
    },
  }, {
    onTask(event) {
      incompleteEvents.push(event);
    },
  });
  const incompleteResult = await runBatch(incomplete, [task("slow")]);
  assert.equal(incompleteResult.receipts[0].status, "incomplete");
  const incompleteEnd = incompleteEvents.find((event) => event.phase === "end");
  assert.ok(incompleteEnd);
  assert.equal(incompleteEnd.receipt?.status, "incomplete");
});

test("quota and usage_limit persist a resumable pause without a terminal receipt", async () => {
  for (const code of ["quota", "usage_limit"]) {
    /** @type {WikiTaskProgressEvent[]} */
    const events = [];
    let latestState;
    const r = runtime({
      async run() {
        throw new WikiTaskExecutionError(`${code} exceeded`, code);
      },
    }, {
      onTask(event) {
        events.push(event);
      },
      onStateChanged(state) { latestState = structuredClone(state); },
    });
    await assert.rejects(
      runBatch(r, [task(code)]),
      (error) => error instanceof WikiTaskPauseError && error.reason === code,
    );
    const paused = latestState.batches[0].tasks[0];
    assert.equal(paused.phase, "paused");
    assert.equal(paused.pause.code, code);
    assert.equal(paused.receipt, undefined);
    const phases = events.map((event) => event.phase);
    assert.deepEqual(phases, ["queued", "start"]);
  }
});

test("onTask throwing does not fail delegate of a successful agent", async () => {
  /** @type {WikiTaskProgressEvent[]} */
  const events = [];
  const r = runtime({
    async run() {
      return { summary: "ok", markdown: "ok" };
    },
  }, {
    onTask(event) {
      events.push(event);
      throw new Error("onTask boom");
    },
  });
  const result = await runBatch(r, [task("ok")]);
  assert.equal(result.status, "complete");
  assert.equal(result.receipts[0].status, "complete");
  const phases = events.map((event) => event.phase);
  assert.deepEqual(phases, ["queued", "start", "end"]);
});

test("forwards normalized attempt-aware telemetry before task end", async () => {
  const events = [];
  let releaseFirst;
  const firstDelivery = new Promise((resolve) => { releaseFirst = resolve; });
  const r = runtime({
    async run(value, context) {
      const target = { kind: "task", batch: context.batch, taskId: value.id };
      await context.onTelemetry({ target, attempt: context.attempt, sampledAt: "2026-01-01T00:00:01.000Z", activity: "using_tool", activeTools: [{ name: "read", startedAt: "2026-01-01T00:00:00.000Z" }] });
      await context.onTelemetry({ target, attempt: context.attempt, sampledAt: "2026-01-01T00:00:02.000Z", activity: "settled", activeTools: [], usage: { turns: 2 } });
      return { summary: "ok", markdown: "ok" };
    },
  }, {
    async onTask(event) {
      events.push(event);
      if (event.phase === "update" && event.telemetry.sampledAt.endsWith("01.000Z")) await firstDelivery;
    },
  });
  const delegated = runBatch(r, [task("live")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.phase === "end").length, 0);
  releaseFirst();
  await delegated;

  const updates = events.filter((event) => event.phase === "update");
  assert.equal(updates.length, 2);
  assert.ok(updates.every((event) => !("usage" in event)));
  assert.equal(updates.at(-1).telemetry.attempt, 1);
  assert.equal(updates.at(-1).telemetry.usage.turns, 2);
  const end = events.find((event) => event.phase === "end");
  assert.equal(end.usage.turns, 2);
});

test("passes an incrementing batch identity to delegated agents", async () => {
  const batches = [];
  const r = runtime({
    async run(_task, context) {
      batches.push(context.batch);
      return { summary: "ok", markdown: "ok" };
    },
  });
  await runBatch(r, [task("first")]);
  await runBatch(r, [task("second")]);
  assert.deepEqual(batches, [1, 2]);
});

test("start accepts a non-next batch identity when it is not a duplicate", async () => {
  const r = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) });
  const started = await r.start([contract(2, task("skip-ahead"))], new AbortController().signal);
  assert.equal(started.batchId, 2);
  assert.equal((await r.collect(2, { until: "all", timeoutSeconds: 1 })).status, "complete");
  const first = await r.start([contract(1, task("earlier"))], new AbortController().signal);
  assert.equal(first.batchId, 1);
  assert.equal((await r.collect(1, { until: "all", timeoutSeconds: 1 })).status, "complete");
});

test("start rejects a duplicate batch identity and mixed batch contracts", async () => {
  const r = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) });
  await r.start([contract(1, task("first"))], new AbortController().signal);
  await assert.rejects(
    r.start([contract(1, task("dup"))], new AbortController().signal),
    /Duplicate delegate batch: 1/,
  );
  await assert.rejects(
    r.start([contract(3, task("a")), contract(4, task("b"))], new AbortController().signal),
    /must belong to one batch/,
  );
});

test("failed start that never registered does not poison a later start of the same batch", async () => {
  const commit = memoryCommit({ batches: [] });
  let failQueue = true;
  const subject = new WikiTaskRuntime({
    runId: "run-1", sourceScopes: ["api"], artifactStore: store(),
    agent: { async run(value) { return { summary: "ok", markdown: testHandoff(value, "ok"), research: { status: "complete", summary: "ok", needsFollowup: false, followups: [], domains: [{ id: "core", conceptIds: [] }] } }; } },
    ...commit,
    async onBatchQueued(contracts) {
      if (failQueue) throw new Error("queue commit failed");
      await commit.onBatchQueued(contracts);
    },
  });
  await assert.rejects(subject.start([contract(1, task("retry"))], new AbortController().signal), /queue commit failed/);
  failQueue = false;
  const started = await subject.start([contract(1, task("retry"))], new AbortController().signal);
  assert.equal(started.batchId, 1);
  assert.equal((await subject.collect(1, { until: "all", timeoutSeconds: 1 })).status, "complete");
});

test("telemetry delivery failures do not fail or delay task completion", async () => {
  const r = runtime({
    async run(value, context) {
      context.onTelemetry({ sampledAt: new Date().toISOString(), activity: "responding" });
      return { summary: "ok", markdown: "ok" };
    },
  }, {
    onTask(event) {
      if (event.phase === "update") throw new Error("telemetry unavailable");
    },
  });
  const result = await runBatch(r, [task("observable")]);
  assert.equal(result.status, "complete");
});

test("start returns before background tasks finish and collect exposes an immediate snapshot", async () => {
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const r = runtime({ async run() {
    await blocked;
    return { summary: "ok", markdown: "ok" };
  } });

  const started = await startBatch(r, [task("background")], new AbortController().signal);
  assert.deepEqual(started, { batchId: 1 });
  assert.throws(() => r.assertFinishable(), /terminal tasks/);
  const live = await r.collect(started.batchId, { until: "all", timeoutSeconds: 0 });
  assert.equal(live.status, "running");
  assert.deepEqual(live.pendingTaskIds, ["background"]);

  finish();
  const complete = await r.collect(started.batchId, { until: "all", timeoutSeconds: 1 });
  assert.equal(complete.status, "complete");
  assert.doesNotThrow(() => r.assertFinishable());
});

test("collect any returns partial progress while all waits for every task", async () => {
  const finishes = new Map();
  const r = runtime({ async run(value) {
    await new Promise((resolve) => { finishes.set(value.id, resolve); });
    return { summary: value.id, markdown: value.id };
  } }, { concurrency: 2 });
  const { batchId } = await startBatch(r, [task("first"), task("second")], new AbortController().signal);
  while (finishes.size < 2) await new Promise((resolve) => setImmediate(resolve));

  finishes.get("second")();
  const any = await r.collect(batchId, { until: "any", timeoutSeconds: 1 });
  assert.equal(any.status, "running");
  assert.deepEqual(any.receipts.map((value) => value.id), ["second"]);
  assert.deepEqual(any.pendingTaskIds, ["first"]);
  assert.equal((await r.collect(batchId, { until: "all", timeoutSeconds: 0 })).status, "running");

  finishes.get("first")();
  const all = await r.collect(batchId, { until: "all", timeoutSeconds: 1 });
  assert.equal(all.status, "complete");
  assert.deepEqual(all.receipts.map((value) => value.id), ["first", "second"]);
});

test("collect timeout is bounded and does not cancel background work", async () => {
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const r = runtime({ async run() {
    await blocked;
    return { summary: "ok", markdown: "ok" };
  } });
  const { batchId } = await startBatch(r, [task("slow")], new AbortController().signal);
  const timedOut = await r.collect(batchId, { until: "any", timeoutSeconds: 0.01 });
  assert.equal(timedOut.status, "running");
  assert.throws(() => r.assertFinishable(), /terminal tasks/);
  const largeCap = r.collect(batchId, { until: "all", timeoutSeconds: 1201 });
  finish();
  assert.equal((await largeCap).status, "complete");
});

test("collect without timeoutSeconds waits until the batch is terminal", async () => {
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const r = runtime({ async run() {
    await blocked;
    return { summary: "ok", markdown: "ok" };
  } });
  const { batchId } = await startBatch(r, [task("slow")], new AbortController().signal);
  const waiting = r.collect(batchId, { until: "all" });
  let settled = false;
  const done = waiting.then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal((await r.collect(batchId, { until: "any", timeoutSeconds: 0 })).status, "running");
  finish();
  assert.equal((await done).status, "complete");
});

test("cancel supports selected tasks and the remaining batch", async () => {
  const r = runtime({ async run(_value, context) {
    await new Promise((resolve, reject) => {
      if (context.signal.aborted) return reject(context.signal.reason);
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    });
    return { summary: "unreachable", markdown: "unreachable" };
  } }, { concurrency: 2 });
  const { batchId } = await startBatch(r, [task("keep"), task("stop")], new AbortController().signal);

  const partial = await r.cancel(batchId, ["stop"], "no longer needed");
  assert.equal(partial.status, "running");
  assert.equal(partial.receipts[0].id, "stop");
  assert.equal(partial.receipts[0].error?.code, "cancelled");
  assert.deepEqual(partial.pendingTaskIds, ["keep"]);

  const cancelled = await r.cancel(batchId, undefined, "stop batch");
  assert.equal(cancelled.status, "failed");
  assert.ok(cancelled.receipts.every((value) => value.error?.code === "cancelled"));
});

test("the run-level signal cancels every task in a batch", async () => {
  const r = runtime({ async run(_value, context) {
    await new Promise((resolve, reject) => {
      if (context.signal.aborted) return reject(context.signal.reason);
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    });
    return { summary: "unreachable", markdown: "unreachable" };
  } }, { concurrency: 2 });
  const run = new AbortController();
  const { batchId } = await startBatch(r, [task("one"), task("two")], run.signal);
  run.abort();

  const result = await r.collect(batchId, { until: "all", timeoutSeconds: 1 });
  assert.equal(result.status, "failed");
  assert.ok(result.receipts.every((value) => value.error?.code === "cancelled"));
});

test("write path leases serialize overlapping writes across batches", async () => {
  const finishes = new Map();
  const started = [];
  let active = 0;
  let maxActive = 0;
  const r = runtime({ async run(value) {
    started.push(value.id);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => { finishes.set(value.id, resolve); });
    active -= 1;
    return { summary: "ok", markdown: "ok" };
  } }, { concurrency: 2 });
  const write = (id) => task(id, { role: "write", writePaths: ["wiki/core/shared.md"] });
  const first = await startBatch(r, [write("first-write")], new AbortController().signal);
  const second = await startBatch(r, [write("second-write")], new AbortController().signal);
  while (!finishes.has("first-write")) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first-write"]);

  finishes.get("first-write")();
  await r.collect(first.batchId, { until: "all", timeoutSeconds: 1 });
  while (!finishes.has("second-write")) await new Promise((resolve) => setImmediate(resolve));
  finishes.get("second-write")();
  await r.collect(second.batchId, { until: "all", timeoutSeconds: 1 });
  assert.equal(maxActive, 1);
});

test("task and batch limits reject new starts with budget errors", async () => {
  const byTasks = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) }, { maxDelegatedTasks: 1 });
  await assert.rejects(
    startBatch(byTasks, [task("one"), task("two")], new AbortController().signal),
    (error) => error?.name === "WikiBudgetExhaustedError" && error.code === "delegated_tasks_exhausted",
  );

  const byBatches = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) }, { maxDelegateBatches: 1 });
  await startBatch(byBatches, [task("allowed")], new AbortController().signal);
  await assert.rejects(
    startBatch(byBatches, [task("blocked")], new AbortController().signal),
    (error) => error?.name === "WikiBudgetExhaustedError" && error.code === "delegate_batches_exhausted",
  );
});

test("background task failures are consumed without an unhandled rejection", async () => {
  const unhandled = [];
  const listener = (error) => { unhandled.push(error); };
  process.on("unhandledRejection", listener);
  try {
    const r = runtime({ async run() { throw new Error("background failure"); } });
    const { batchId } = await startBatch(r, [task("detached")], new AbortController().signal);
    await r.collect(batchId, { until: "all", timeoutSeconds: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("restores queued and running tasks with exact attempt and session identity", async () => {
  const contexts = new Map();
  const restoredState = {
    batches: [{
      batchId: 1,
      tasks: [
        { task: task("queued"), phase: "queued", attempt: 1, collected: false },
        { task: task("running"), phase: "running", attempt: 2, sessionFile: "/sessions/running.jsonl", collected: false },
      ],
    }],
  };
  let latestState;
  const r = runtime({ async run(value, context) {
    contexts.set(value.id, { attempt: context.attempt, sessionFile: context.sessionFile });
    return { summary: "resumed", markdown: "resumed" };
  } }, {
    restoredState,
    onStateChanged(state) { latestState = structuredClone(state); },
  });

  await r.resume(new AbortController().signal);
  const result = await r.collect(1, { until: "all", timeoutSeconds: 1 });
  assert.equal(result.status, "complete");
  assert.deepEqual(contexts.get("queued"), { attempt: 2, sessionFile: undefined });
  assert.deepEqual(contexts.get("running"), { attempt: 2, sessionFile: "/sessions/running.jsonl" });
  assert.ok(latestState.batches[0].tasks.every((value) => value.phase === "terminal" && value.collected));
});

test("terminal uncollected receipts survive reconstruction and block finish", async () => {
  let latestState;
  const first = runtime({ run: async () => ({ summary: "done", markdown: "done" }) }, {
    onStateChanged(state) { latestState = structuredClone(state); },
  });
  const { batchId } = await startBatch(first, [task("durable")], new AbortController().signal);
  await waitFor(() => latestState?.batches[0]?.tasks[0]?.phase === "terminal");
  assert.throws(() => first.assertFinishable(), /collected receipts/);

  const restored = runtime({ run: async () => { throw new Error("terminal tasks must not restart"); } }, {
    restoredState: latestState,
    onStateChanged(state) { latestState = structuredClone(state); },
  });
  await restored.resume(new AbortController().signal);
  assert.throws(() => restored.assertFinishable(), /collected receipts/);
  assert.equal((await restored.collect(batchId, { until: "all", timeoutSeconds: 0 })).status, "complete");
  assert.doesNotThrow(() => restored.assertFinishable());
  assert.equal(latestState.batches[0].tasks[0].collected, true);
});

test("restored counters preserve budgets and next batch identity", async () => {
  let latestState;
  const original = runtime({ run: async () => ({ summary: "done", markdown: "done" }) }, {
    onStateChanged(state) { latestState = structuredClone(state); },
  });
  await runBatch(original, [task("same-id")]);

  const exhausted = runtime({ run: async () => ({ summary: "unused", markdown: "unused" }) }, {
    restoredState: latestState,
    maxDelegatedTasks: 1,
    maxDelegateBatches: 1,
  });
  await assert.rejects(startBatch(exhausted, [task("new")], new AbortController().signal), (error) => error.code === "delegate_batches_exhausted");

  const taskExhausted = runtime({ run: async () => ({ summary: "unused", markdown: "unused" }) }, {
    restoredState: latestState,
    maxDelegatedTasks: 1,
    maxDelegateBatches: 2,
  });
  await assert.rejects(startBatch(taskExhausted, [task("new")], new AbortController().signal), (error) => error.code === "delegated_tasks_exhausted");

  const continued = runtime({ run: async () => ({ summary: "continued", markdown: "continued" }) }, {
    restoredState: latestState,
    maxDelegatedTasks: 2,
    maxDelegateBatches: 2,
  });
  const started = await startBatch(continued, [task("next-id")], new AbortController().signal);
  assert.equal(started.batchId, 2);
  assert.equal((await continued.collect(2, { until: "all", timeoutSeconds: 1 })).status, "complete");
});

test("provider quota resumes the same attempt and session before succeeding", async () => {
  let latestState;
  const first = runtime({ async run(value, context) {
    await context.onTelemetry({
      target: { kind: "task", batch: context.batch, taskId: value.id },
      attempt: context.attempt,
      sampledAt: "2026-01-01T00:00:00.000Z",
      activity: "waiting_model",
      activeTools: [],
      sessionFile: "/sessions/quota.jsonl",
    });
    throw new WikiTaskExecutionError("quota exhausted", "quota", { retryAfterMs: 500 });
  } }, { onStateChanged(state) { latestState = structuredClone(state); } });
  await startBatch(first, [task("quota-state")], new AbortController().signal);
  await waitFor(() => latestState?.batches[0]?.tasks[0]?.phase === "paused");
  assert.throws(() => first.assertFinishable(), (error) => error instanceof WikiTaskPauseError && error.reason === "quota");
  await assert.rejects(first.collect(1, { until: "all", timeoutSeconds: 0 }), (error) => error instanceof WikiTaskPauseError);
  assert.equal(latestState.batches[0].tasks[0].attempt, 1);
  assert.equal(latestState.batches[0].tasks[0].sessionFile, "/sessions/quota.jsonl");
  assert.equal(latestState.batches[0].tasks[0].receipt, undefined);

  let resumedContext;
  const restored = runtime({ async run(_value, context) {
    resumedContext = { attempt: context.attempt, sessionFile: context.sessionFile };
    return { summary: "recovered", markdown: "recovered" };
  } }, { restoredState: latestState });
  await restored.resume(new AbortController().signal);
  const result = await restored.collect(1, { until: "all", timeoutSeconds: 1 });
  assert.equal(result.status, "complete");
  assert.deepEqual(resumedContext, { attempt: 1, sessionFile: "/sessions/quota.jsonl" });
  assert.doesNotThrow(() => restored.assertFinishable());
});

test("manual pause preserves a running task for exact resume without a cancelled receipt", async () => {
  let latestState;
  const run = new AbortController();
  const first = runtime({ async run(value, context) {
    await context.onTelemetry({
      target: { kind: "task", batch: context.batch, taskId: value.id },
      attempt: context.attempt,
      sampledAt: "2026-01-01T00:00:00.000Z",
      activity: "waiting_model",
      activeTools: [],
      sessionFile: "/sessions/manual.jsonl",
    });
    await new Promise((resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
    return { summary: "unreachable", markdown: "unreachable" };
  } }, { onStateChanged(state) { latestState = structuredClone(state); } });
  await startBatch(first, [task("manual")], run.signal);
  await waitFor(() => latestState?.batches[0]?.tasks[0]?.sessionFile === "/sessions/manual.jsonl");
  run.abort(WIKI_MANUAL_PAUSE);
  await waitFor(() => latestState?.batches[0]?.tasks[0]?.phase === "paused");
  assert.equal(latestState.batches[0].tasks[0].receipt, undefined);
  assert.equal(latestState.batches[0].tasks[0].pause, undefined);

  let resumedContext;
  const restored = runtime({ async run(_value, context) {
    resumedContext = { attempt: context.attempt, sessionFile: context.sessionFile };
    return { summary: "resumed", markdown: "resumed" };
  } }, { restoredState: latestState });
  await restored.resume(new AbortController().signal);
  assert.equal((await restored.collect(1, { until: "all", timeoutSeconds: 1 })).status, "complete");
  assert.deepEqual(resumedContext, { attempt: 1, sessionFile: "/sessions/manual.jsonl" });
});

test("artifacts persist with the delegate contract id", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-task-artifacts-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const artifactStore = createWikiArtifactStore({ workspace });
  const durable = { batches: [] };
  let consumedHandles;
  const r = new WikiTaskRuntime({
    runId: "run-1",
    sourceScopes: ["api"],
    artifactStore,
    ...memoryCommit(durable),
    agent: { async run(value, context) {
      if (value.id === "consumer") consumedHandles = Object.keys(context.contextArtifacts).sort();
      return { summary: value.id, markdown: testHandoff(value, `${value.id}:${context.batch}`) };
    } },
  });
  const first = await runBatch(r, [task("research-a")]);
  const second = await runBatch(r, [task("research-b")]);
  const handles = [first.receipts[0].outputs[0].contractId, second.receipts[0].outputs[0].contractId];
  assert.deepEqual(handles, ["b1-research-a", "b2-research-b"]);
  await runBatch(r, [task("consumer", { contextRefs: handles })]);
  assert.deepEqual(consumedHandles, handles);

  const manifest = JSON.parse(await readFile(path.join(workspace, ".okf-wiki", "runs", "run-1", "manifest.json"), "utf8"));
  assert.ok(handles.every((handle) => manifest.artifacts.some((artifact) => artifact.contractId === handle)));
  assert.equal(manifest.artifacts.filter((artifact) => handles.includes(artifact.contractId)).length, 2);
});

test("rejects duplicate task ids across batches", async () => {
  const r = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) });
  await startBatch(r, [task("reused")]);
  await assert.rejects(startBatch(r, [task("reused")]), /Duplicate delegate task id across batches: reused/);
});

test("progress events carry immutable batch identity for duplicate ids across batches", async () => {
  const events = [];
  const r = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) }, {
    onTask(event) { events.push(event); },
  });
  await runBatch(r, [task("first")]);
  await runBatch(r, [task("second")]);
  assert.deepEqual([...new Set(events.slice(0, 3).map((event) => event.batchId))], [1]);
  assert.deepEqual([...new Set(events.slice(3).map((event) => event.batchId))], [2]);
  assert.ok(events.every((event) => Object.hasOwn(event, "batchId")));
});

test("review admission observes the shared run write lease", async () => {
  const lease = new WikiWritePathLease();
  const release = await lease.acquire(["wiki/core/page.md"], new AbortController().signal);
  const r = runtime({ run: async () => ({ summary: "ok", markdown: "ok" }) }, { writeLease: lease });
  await assert.rejects(
    startBatch(r, [task("review", { role: "review", reviewPaths: ["wiki/core/page.md"] })], new AbortController().signal),
    /review is blocked.*writes are active/i,
  );
  release();
});

test("shared attempt classification preserves session budget codes", () => {
  for (const code of ["session_turns_exhausted", "session_tool_calls_exhausted"]) {
const failure = classifyWikiAttemptFailure(new WikiBudgetExhaustedError("session budget exhausted", code));
    assert.equal(failure.code, code);
    assert.equal(failure.retryable, false);
  }
});
