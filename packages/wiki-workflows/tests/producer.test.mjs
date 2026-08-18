import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WikiLeadRun } from "../dist/lead.js";
import { createConfiguredWikiProducer } from "../dist/production-run.js";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-producer-v2-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.ts"), "export const answer = 42;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function spec() {
  return { pages: ["overview.md", "source/source.md", "source/runtime/domain.md"] };
}

function content(type, title) {
  return ["---", `type: ${type}`, `title: ${title}`, "description: Runtime behavior", "sources:", "  - id: runtime", "    resource: source/src/index.ts#L1-L1", "---", "", "Runtime behavior.[^runtime]", "", "[^runtime]: [Source](source/src/index.ts#L1-L1)", ""].join("\n");
}

function leadFence(request) {
  return {
    assertActive: request.assertActive,
    executionToken: request.executionToken,
    commitLead: request.commitLead,
    readLead: request.readLead,
  };
}

async function acceptTaxonomy(lead) {
  await completeDiscovery(lead, "source");
  await lead.saveTaxonomy({
    revision: 1,
    decisions: [{ sourceScopeId: "source", domainId: "runtime", conceptIds: [] }],
    conflictIds: [],
  });
}

async function completeDiscovery(lead, sourceScopeId) {
  const { batchId, contracts } = await lead.startNextReadyWave([{ sourceScopeId, instruction: "Survey the pinned Source" }]);
  for (const contract of contracts) {
    await lead.taskTransitions.taskStarted(batchId, contract.id, { attempt: 1 });
    await lead.taskTransitions.taskSettled(batchId, contract.id, { attempt: 1, receipt: {
      id: contract.id, role: "research", status: "complete", summary: "complete", outputs: [],
      completedAssignmentIds: contract.assignmentIds, needsFollowup: false, followups: [],
      domains: [{ sourceScopeId: contract.sourceScopeIds[0], domainId: "core", conceptIds: [] }],
      coverage: contract.assignmentIds, gaps: [], attempts: 1,
      contractId: contract.contractId, contractDigest: contract.contractDigest,
    } });
  }
  await lead.taskTransitions.tasksCollected(batchId, contracts.map((contract) => contract.id));
}

async function completeCandidate(request) {
  const lead = await WikiLeadRun.open({
    workspace: request.cwd, runId: request.runId, candidateWikiRoot: request.candidateWikiRoot,
    policy: request.generation, requiredSections: request.generation.templates.requiredSections,
    allowedSourceScopeIds: ["source"],
    ...leadFence(request),
  });
  await acceptTaxonomy(lead);
  await lead.saveSpec(spec());
  await lead.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  await lead.replacePage({ path: "wiki/source/source.md", content: content("Source", "API"), actor: "lead" });
  await lead.replacePage({ path: "wiki/source/runtime/domain.md", content: content("Domain", "Runtime domain"), actor: "lead" });
  await acceptReviews(lead);
}

async function acceptReviews(lead) {
  let reviews;
  while (true) {
    const wave = await lead.startNextReadyWave();
    if (wave.wave === "review") {
      reviews = wave;
      break;
    }
    if (wave.wave !== "write") throw new Error(`expected write or review, got ${wave.wave}`);
    for (const contract of wave.contracts) {
      await lead.taskTransitions.taskStarted(wave.batchId, contract.id, { attempt: 1 });
      await lead.taskTransitions.taskSettled(wave.batchId, contract.id, { attempt: 1, receipt: {
        id: contract.id, role: "write", status: "complete", summary: "written", outputs: [], coverage: contract.writePaths, gaps: [], attempts: 1,
        contractId: contract.contractId, contractDigest: contract.contractDigest,
      } });
    }
    await lead.taskTransitions.tasksCollected(wave.batchId, wave.contracts.map((contract) => contract.id));
  }
  for (const contract of reviews.contracts) {
    await lead.taskTransitions.taskStarted(reviews.batchId, contract.id, { attempt: 1 });
    await lead.taskTransitions.taskSettled(reviews.batchId, contract.id, { attempt: 1, receipt: {
      id: contract.id, role: "review", status: "complete", summary: "pass", outputs: [], coverage: contract.reviewPaths, gaps: [], attempts: 1,
      contractId: contract.contractId, contractDigest: contract.contractDigest,
      review: { verdict: "pass", reviewedPaths: contract.reviewPaths, findings: [], profileCoverage: [] },
    } });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function runningToolTelemetry(overrides = {}) {
  return {
    target: { kind: "lead" },
    attempt: 1,
    sampledAt: "2026-08-12T00:00:01.000Z",
    activity: "using_tool",
    activeTools: [{ id: "call-1", name: "read", startedAt: "2026-08-12T00:00:01.000Z", summary: "wiki/overview.md" }],
    process: [{
      sequence: 1, at: "2026-08-12T00:00:01.000Z", kind: "tool", severity: "info",
      target: { kind: "lead" }, message: "read", toolCallId: "call-1", toolName: "read",
      summary: "wiki/overview.md", completed: false,
    }],
    ...overrides,
  };
}

test("production applies lead observations during run, not only after it settles", async (t) => {
  const root = await workspace(t);
  const live = deferred();
  const release = deferred();
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    await request.record({ kind: "progress", message: "live lead" });
    live.resolve();
    await release.promise;
    await completeCandidate(request);
    return { kind: "complete", summary: "done" };
  } }) });
  const handle = await producer.start({ cwd: root });
  await live.promise;
  assert.equal((await handle.view()).progress?.lastMessage, "live lead");
  release.resolve();
  assert.equal((await handle.result()).summary, "done");
});

test("record projects a running tool into view and inspectAgent immediately", async (t) => {
  const root = await workspace(t);
  const live = deferred();
  const release = deferred();
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    await request.record({ kind: "telemetry", target: { kind: "lead" }, telemetry: runningToolTelemetry() });
    live.resolve();
    await release.promise;
    return { kind: "pause", reason: "quota", summary: "wait" };
  } }) });
  const handle = await producer.start({ cwd: root });
  await live.promise;
  const view = await handle.view();
  assert.equal(view.progress?.lead?.activity, "using_tool");
  assert.equal(view.progress?.lead?.activeTools[0]?.name, "read");
  assert.equal(view.progress?.lead?.activeTools[0]?.id, "call-1");
  assert.equal(view.progress?.recentActivity?.some((entry) => entry.toolCallId === "call-1" && entry.completed === false), true);
  const inspection = await handle.inspectAgent({ kind: "lead" });
  assert.equal(inspection?.process[0]?.toolCallId, "call-1");
  assert.equal(inspection?.process[0]?.completed, false);
  assert.equal(inspection?.agent.activeTools[0]?.name, "read");
  const disk = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", handle.id, "run.json"), "utf8"));
  assert.equal(disk.progress, undefined);
  assert.equal(disk.lead.delegates.batches.length, 0);
  release.resolve();
  while ((await handle.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
});

test("live telemetry yields on updates without writing an event type", async (t) => {
  const root = await workspace(t);
  const live = deferred();
  const afterTool = deferred();
  const release = deferred();
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    await request.record({ kind: "telemetry", target: { kind: "lead" }, telemetry: runningToolTelemetry() });
    live.resolve();
    await afterTool.promise;
    await request.record({
      kind: "telemetry", target: { kind: "lead" }, telemetry: runningToolTelemetry({
        sampledAt: "2026-08-12T00:00:02.000Z",
        lastHeartbeatAt: "2026-08-12T00:00:02.000Z",
        process: undefined,
      }),
    });
    await release.promise;
    return { kind: "pause", reason: "quota", summary: "wait" };
  } }) });
  const handle = await producer.start({ cwd: root });
  await live.promise;
  const seen = [];
  const stop = new AbortController();
  const consume = (async () => {
    try {
      for await (const update of handle.updates(stop.signal)) seen.push(update);
    } catch { /* aborted */ }
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  afterTool.resolve();
  const deadline = Date.now() + 2_000;
  while (!seen.some((update) => update.view.progress?.lead?.lastHeartbeatAt === "2026-08-12T00:00:02.000Z") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const sidecar = seen.find((update) => update.view.progress?.lead?.lastHeartbeatAt === "2026-08-12T00:00:02.000Z");
  assert.ok(sidecar);
  assert.equal(sidecar.view.progress?.lead?.activeTools[0]?.name, "read");
  release.resolve();
  const pausedUpdateDeadline = Date.now() + 2_000;
  while (!seen.some((update) => update.event.type === "paused") && Date.now() < pausedUpdateDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const pausedUpdate = seen.find((update) => update.event.type === "paused");
  assert.ok(pausedUpdate);
  stop.abort();
  await consume;
  const pausedDeadline = Date.now() + 2_000;
  while ((await handle.view()).status !== "paused" && Date.now() < pausedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await handle.view()).status, "paused");
});

test("reopened handle overlays persisted agent sidecars into its live view", async (t) => {
  const root = await workspace(t);
  const observed = deferred();
  const release = deferred();
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    await request.record({ kind: "telemetry", target: { kind: "lead" }, telemetry: runningToolTelemetry({ process: undefined, usage: { turns: 4 } }) });
    observed.resolve();
    await release.promise;
    return { kind: "pause", reason: "quota", summary: "wait" };
  } }) });
  const handle = await producer.start({ cwd: root });
  await observed.promise;
  release.resolve();
  while ((await handle.view()).status !== "paused") await new Promise((resolve) => setTimeout(resolve, 5));

  const reopened = await createConfiguredWikiProducer().open(handle.id, root);
  const view = await reopened.view();
  assert.equal(view.progress?.lead?.activeTools[0]?.id, "call-1");
  assert.equal(view.progress?.usage?.turns, 4);
  assert.equal((await reopened.inspectAgent({ kind: "lead" }))?.agent.activeTools[0]?.id, "call-1");
});

test("waitForResult resolves from a hub terminal without polling disk on a 50ms interval", async (t) => {
  const root = await workspace(t);
  const entered = deferred();
  const release = deferred();
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    entered.resolve();
    await release.promise;
    await completeCandidate(request);
    return { kind: "complete", summary: "hub-terminal" };
  } }) });
  const handle = await producer.start({ cwd: root });
  await entered.promise;
  const pending = handle.result();
  release.resolve();
  assert.equal((await pending).summary, "hub-terminal");
});

test("updates replay every durable transition with its same-sequence view including terminal", async (t) => {
  const root = await workspace(t);
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    await completeCandidate(request);
    await request.record({ kind: "progress", message: "Lead is working" });
    return { kind: "complete", summary: "done" };
  } }) });
  const handle = await producer.start({ cwd: root, focus: " runtime " });
  const result = await handle.result();
  assert.equal(result.summary, "done");
  assert.equal((await handle.view()).focus, "runtime");
  assert.equal((await handle.view()).operation, undefined);
  const updates = [];
  for await (const update of handle.updates()) updates.push(update);
  assert.equal(updates.at(-1).event.type, "completed");
  assert.equal(updates.at(-1).view.status, "succeeded");
});

test("paused run serializes its workspace and resume reuses the exact pinned plan", async (t) => {
  const root = await workspace(t);
  const gate = deferred();
  let firstPlan;
  let calls = 0;
  const producer = createConfiguredWikiProducer({ createLead(plan) {
    if (!firstPlan) firstPlan = structuredClone(plan);
    else {
      const { leadSessionFile, leadSessionAttempt, ...base } = plan;
      assert.deepEqual(base, firstPlan);
      assert.equal(leadSessionFile, path.join(root, "lead-session.jsonl"));
      assert.equal(leadSessionAttempt, 1);
    }
    return { async run(request) {
      calls += 1;
      if (calls === 1) {
        await request.record({ kind: "telemetry", target: { kind: "lead" }, telemetry: {
          target: { kind: "lead" }, attempt: 1, sampledAt: "2026-01-01T00:00:00.000Z", activity: "streaming", activeTools: [],
          sessionFile: path.join(root, "lead-session.jsonl"),
        } });
        return { kind: "pause", reason: "quota", summary: "wait" };
      }
      await completeCandidate(request);
      await gate.promise;
      return { kind: "complete", summary: "resumed" };
    } };
  } });
  const first = await producer.start({ cwd: root });
  while ((await first.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(producer.start({ cwd: root }), /already active/);
  assert.equal((await first.control("resume")).status, "running");
  gate.resolve();
  assert.equal((await first.result()).summary, "resumed");
  assert.equal(calls, 2);
});

test("source drift after Lead completion fails without publishing the candidate", async (t) => {
  const root = await workspace(t);
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    await completeCandidate(request);
    await writeFile(path.join(root, "src", "index.ts"), "export const answer = 43;\n");
    return { kind: "complete", summary: "stale" };
  } }) });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(handle.result(), /sources changed while the Wiki run was active/);
  await assert.rejects(readFile(path.join(root, "wiki", "overview.md"), "utf8"), { code: "ENOENT" });
  assert.equal((await handle.view()).status, "failed");
});

test("same deterministic run id in two workspaces keeps executions and update hubs isolated", async (t) => {
  const left = await workspace(t);
  const right = await workspace(t);
  const seen = [];
  const producer = createConfiguredWikiProducer({
    createId: () => "same-run",
    createLead: () => ({ async run(request) {
      seen.push(request.cwd);
      return { kind: "pause", reason: "quota", summary: `paused:${request.cwd}` };
    } }),
  });
  const [leftRun, rightRun] = await Promise.all([producer.start({ cwd: left }), producer.start({ cwd: right })]);
  while ((await leftRun.view()).status === "running" || (await rightRun.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(leftRun.id, "same-run");
  assert.equal(rightRun.id, "same-run");
  assert.deepEqual(new Set(seen), new Set([left, right]));
  const leftUpdates = [];
  for await (const update of leftRun.updates()) { leftUpdates.push(update); if (update.event.type === "paused") break; }
  assert.ok(leftUpdates.every((update) => update.view.cwd === left));
});

test("resume requested while an abort-ignoring attempt settles is deferred and eventually launches", async (t) => {
  const root = await workspace(t);
  const release = deferred();
  let calls = 0;
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run() {
    calls += 1;
    if (calls === 1) await release.promise;
    return { kind: "pause", reason: "quota", summary: `attempt ${calls}` };
  } }) });
  const run = await producer.start({ cwd: root });
  while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await run.control("pause")).status, "paused");
  assert.equal((await run.control("resume")).status, "running");
  release.resolve();
  while (calls < 2 || (await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal((await run.view()).status, "paused");
});

test("cancel fences observations from a slow prior attempt", async (t) => {
  const root = await workspace(t);
  const entered = deferred();
  const release = deferred();
  const attempted = deferred();
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    entered.resolve();
    await release.promise;
    attempted.resolve();
    try { await request.record({ kind: "progress", message: "late write" }); }
    catch { /* attempt already fenced */ }
    return { kind: "complete", summary: "too late" };
  } }) });
  const run = await producer.start({ cwd: root });
  await entered.promise;
  await run.control("cancel");
  release.resolve();
  await attempted.promise;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await run.view()).status, "cancelled");
});

test("cancel fences direct Candidate mutations from an abort-ignoring Lead", async (t) => {
  const root = await workspace(t);
  const ready = deferred();
  const release = deferred();
  const attempted = deferred();
  let lateError;
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    const lead = await WikiLeadRun.open({
      workspace: request.cwd, runId: request.runId, candidateWikiRoot: request.candidateWikiRoot,
      policy: request.generation, requiredSections: request.generation.templates.requiredSections,
      allowedSourceScopeIds: ["source"],
      ...leadFence(request),
    });
    await acceptTaxonomy(lead);
    await lead.saveSpec(spec());
    ready.resolve();
    await release.promise;
    try { await lead.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" }); }
    catch (error) { lateError = error; }
    finally { attempted.resolve(); }
    return { kind: "complete", summary: "too late" };
  } }) });
  const run = await producer.start({ cwd: root });
  await ready.promise;
  await run.control("cancel");
  release.resolve();
  await attempted.promise;
  assert.match(String(lateError), /no longer.*active|execution fence/i);
  await assert.rejects(readFile(path.join(root, ".okf-wiki", "runs", run.id, "candidate", "wiki", "overview.md"), "utf8"), { code: "ENOENT" });
});

test("a second handle from the same producer attaches to the live run", async (t) => {
  const root = await workspace(t);
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const producer = createConfiguredWikiProducer({ createId: () => "shared-run", createLead: () => ({ async run() {
    calls += 1;
    if (calls === 1) { entered.resolve(); await release.promise; }
    return { kind: "pause", reason: "quota", summary: `attempt:${calls}` };
  } }) });
  const first = await producer.start({ cwd: root });
  await entered.promise;
  const before = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", first.id, "run.json"), "utf8"));
  const second = await producer.open(first.id, path.join(root, "src"));
  assert.ok(second);
  assert.equal((await second.control("pause")).status, "paused");
  const resumed = await second.control("resume");
  const after = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", first.id, "run.json"), "utf8"));
  assert.equal(resumed.status, "running");
  assert.equal(after.attempt, before.attempt + 1);
  assert.notEqual(after.executionToken, before.executionToken);
  release.resolve();
  while (calls < 2 || (await second.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
});

test("two producer instances do not intern the same Run handle; open/list use the Workspace not leftover .okf-wiki", async (t) => {
  const root = await workspace(t);
  let firstCalls = 0;
  let secondCalls = 0;
  const firstProducer = createConfiguredWikiProducer({ createId: () => "workspace-run", createLead: () => ({ async run() {
    firstCalls += 1;
    return { kind: "pause", reason: "quota", summary: `first:${firstCalls}` };
  } }) });
  const started = await firstProducer.start({ cwd: root });
  while ((await started.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));

  const nested = path.join(root, "src", "nested");
  await mkdir(path.join(nested, ".okf-wiki"), { recursive: true });
  const listed = await firstProducer.list(nested);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "workspace-run");
  assert.equal(listed[0].cwd, root);

  const stray = await mkdtemp(path.join(os.tmpdir(), "wiki-no-workspace-"));
  t.after(async () => await rm(stray, { recursive: true, force: true }));
  assert.equal(await firstProducer.open(started.id, stray), undefined);
  assert.deepEqual(await firstProducer.list(stray), []);

  const secondProducer = createConfiguredWikiProducer({ createLead: () => ({ async run() {
    secondCalls += 1;
    throw new Error("second producer must not inherit first internment");
  } }) });
  const reopened = await secondProducer.open(started.id, nested);
  assert.ok(reopened);
  assert.notEqual(reopened, started);

  await started.control("resume");
  while ((await started.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(firstCalls, 2);
  assert.equal(secondCalls, 0);
  assert.equal((await started.view()).status, "paused");

  await reopened.control("resume");
  while ((await reopened.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(secondCalls, 1);
  assert.equal((await reopened.view()).status, "failed");
});

test("inspectAgent without options does not read the session transcript", async (t) => {
  const root = await workspace(t);
  const sessionFile = path.join(root, "lead-session.jsonl");
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-08-12T00:00:00.000Z", cwd: root }),
    JSON.stringify({
      type: "message", id: "a1", parentId: null, timestamp: "2026-08-12T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I will inspect the source first." }],
        timestamp: Date.parse("2026-08-12T00:00:01.000Z"),
      },
    }),
  ].join("\n"));
  const live = deferred();
  const release = deferred();
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    await request.record({ kind: "telemetry", target: { kind: "lead" }, telemetry: {
      target: { kind: "lead" }, attempt: 1, sampledAt: "2026-08-12T00:00:00.000Z", activity: "streaming", activeTools: [],
      sessionFile,
    } });
    live.resolve();
    await release.promise;
    return { kind: "pause", reason: "quota", summary: "wait" };
  } }) });
  const handle = await producer.start({ cwd: root });
  await live.promise;
  const overview = await handle.inspectAgent({ kind: "lead" });
  assert.ok(overview);
  assert.equal("messages" in overview, false);
  const processView = await handle.inspectAgent({ kind: "lead" }, { transcript: false });
  assert.equal("messages" in processView, false);
  const output = await handle.inspectAgent({ kind: "lead" }, { transcript: true });
  assert.deepEqual(output.messages, [{ at: "2026-08-12T00:00:01.000Z", text: "I will inspect the source first." }]);
  release.resolve();
  while ((await handle.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
});

test("resume uses pinned paths even when workspace config becomes invalid", async (t) => {
  const root = await workspace(t);
  let calls = 0;
  const producer = createConfiguredWikiProducer({ createId: () => "pinned-open", createLead: () => ({ async run() {
    calls += 1;
    return { kind: "pause", reason: "quota", summary: "wait" };
  } }) });
  const run = await producer.start({ cwd: root });
  while ((await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(path.join(root, "workspace.yaml"), "not: [valid\n");
  await run.control("resume");
  while ((await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal((await run.view()).status, "paused");
});

test("resume rejects a modified materialized production skill", async (t) => {
  const root = await workspace(t);
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run() {
    return { kind: "pause", reason: "quota", summary: "wait" };
  } }) });
  const run = await producer.start({ cwd: root });
  while ((await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(path.join(root, ".okf-wiki", "runs", run.id, "skill", "references", "common.md"), "changed\n");
  await run.control("resume");
  await assert.rejects(run.result(), /production skill changed/);
  assert.equal((await run.view()).status, "failed");
});
