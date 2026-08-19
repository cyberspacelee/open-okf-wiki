import assert from "node:assert/strict";
import test from "node:test";
import { PiSessionObserver } from "../dist/pi/observer.js";

function createSession() {
  let listener;
  return {
    subscribe(fn) {
      listener = fn;
      return () => { listener = undefined; };
    },
    emit(event) { listener?.(event); },
    getSessionStats() {
      return { assistantMessages: 0, toolCalls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
    },
  };
}

function latestProcess(reports) {
  for (let index = reports.length - 1; index >= 0; index--) {
    const process = reports[index]?.process;
    if (Array.isArray(process)) return process;
  }
  return [];
}

function latestTelemetry(reports) {
  return [...reports].reverse().find((entry) => Array.isArray(entry?.process)) ?? reports.at(-1);
}

function waitForProcess(reports, match) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const process = latestProcess(reports);
      if (match(process)) {
        resolve({ telemetry: latestTelemetry(reports), process });
        return;
      }
      if (Date.now() - started > 1500) {
        reject(new Error(`timed out waiting for process: ${JSON.stringify(process)}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function observe(run) {
  const reports = [];
  const session = createSession();
  let now = Date.parse("2026-08-12T00:00:00.000Z");
  const observer = new PiSessionObserver(session, {
    target: { kind: "lead" },
    attempt: 1,
    timeoutMs: 60_000,
    workspaceRoot: "/repo",
    report: (telemetry) => { reports.push(telemetry); },
    now: () => now,
  });
  observer.start();
  try {
    return await run({
      session,
      advance(ms) { now += ms; },
      wait(match) { return waitForProcess(reports, match); },
    });
  } finally {
    await observer.stop();
  }
}

test("Lead observer deadline tracks remaining thinking time", async () => {
  const reports = [];
  const session = createSession();
  let now = Date.parse("2026-08-12T00:00:00.000Z");
  let remaining = 60_000;
  const observer = new PiSessionObserver(session, {
    target: { kind: "lead" },
    attempt: 1,
    timeoutMs: 60_000,
    remainingTimeoutMs: () => remaining,
    workspaceRoot: "/repo",
    report: (telemetry) => { reports.push(telemetry); },
    now: () => now,
  });
  observer.start();
  try {
    assert.equal(reports[0].deadlineAt, "2026-08-12T00:01:00.000Z");
    remaining = 10_000;
    now += 5_000;
    session.emit({ type: "turn_start" });
    await waitFor(() => reports.some((entry) => entry.deadlineAt === "2026-08-12T00:00:15.000Z"));
  } finally {
    await observer.stop();
  }
});

test("tool start writes one incomplete process row", async () => {
  await observe(async ({ session, wait }) => {
    session.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "/repo/src/a.ts" },
    });
    const { telemetry, process } = await wait((entries) => entries.some((entry) => entry.toolCallId === "c1"));
    assert.equal(telemetry.activeTools.length, 1);
    assert.equal(telemetry.activeTools[0].id, "c1");
    assert.equal(process.length, 1);
    assert.equal(process[0].completed, false);
    assert.equal(process[0].kind, "tool");
    assert.equal(process[0].toolCallId, "c1");
    assert.equal(process[0].toolName, "read");
    assert.equal(process[0].summary, "src/a.ts");
  });
});

test("tool update changes the same process row summary", async () => {
  await observe(async ({ session, wait }) => {
    session.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "/repo/src/a.ts" },
    });
    await wait((entries) => entries.length === 1 && entries[0].summary === "src/a.ts");
    session.emit({
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "/repo/src/b.ts" },
      partialResult: {},
    });
    const { process } = await wait((entries) => entries.length === 1 && entries[0].summary === "src/b.ts");
    assert.equal(process.length, 1);
    assert.equal(process[0].toolCallId, "c1");
    assert.equal(process[0].completed, false);
    assert.equal(process[0].summary, "src/b.ts");
  });
});

test("tool end converts the same process row in place", async () => {
  await observe(async ({ session, wait, advance }) => {
    session.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "/repo/src/a.ts" },
    });
    const started = await wait((entries) => entries.length === 1 && entries[0].completed === false);
    advance(1_200);
    session.emit({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      result: { content: [] },
      isError: false,
    });
    const { telemetry, process } = await wait((entries) => entries.length === 1 && entries[0].completed === true);
    assert.equal(telemetry.activeTools.length, 0);
    assert.equal(process.length, 1);
    assert.equal(process[0].completed, true);
    assert.equal(process[0].toolCallId, "c1");
    assert.equal(process[0].toolName, "read");
    assert.equal(process[0].summary, "src/a.ts");
    assert.equal(process[0].severity, "info");
    assert.equal(process[0].sequence, started.process[0].sequence);
    assert.equal(process[0].durationMs, 1_200);
  });
});

test("tool end without a start row appends a completed process row", async () => {
  await observe(async ({ session, wait }) => {
    session.emit({
      type: "tool_execution_end",
      toolCallId: "orphan",
      toolName: "write",
      result: { content: [{ type: "text", text: "Path is not assigned" }] },
      isError: true,
    });
    const { process } = await wait((entries) => entries.some((entry) => entry.toolCallId === "orphan"));
    assert.equal(process.length, 1);
    assert.equal(process[0].completed, true);
    assert.equal(process[0].toolCallId, "orphan");
    assert.equal(process[0].toolName, "write");
    assert.equal(process[0].severity, "error");
    assert.equal(process[0].message, "Path is not assigned");
  });
});

test("file-first Wiki tool summaries expose only fixed labels and closed control fields", async () => {
  await observe(async ({ session, wait }) => {
    const secret = `PRIVATE-${"x".repeat(4_000)}`;
    const calls = [
      ["wiki_delegate_start", { tasks: [{ id: "task-secret", role: "research", instruction: secret, sourceScopeIds: ["source-secret"], contextRefs: ["artifact-secret"], resolvesIds: ["blocker-secret"] }] }, "start ready wave"],
      ["wiki_taxonomy", { decisions: [{ sourceScopeId: "source-secret", domainId: secret }] }, "accept taxonomy"],
      ["wiki_plan", { pages: ["wiki/private/path.md"], body: secret }, "accept Wiki plan"],
      ["wiki_finish", { summary: secret }, "finish Wiki"],
      ["wiki_delegate_collect", { batchId: 42, taskIds: ["task-secret"], until: "all", timeoutSeconds: 60, unknown: secret }, "collect  all  60s"],
      ["wiki_delegate_cancel", { batchId: 42, taskIds: ["task-secret"], reason: secret, reasonCode: "blocked" }, "cancel wave  blocked"],
      ["wiki_research_finish", { status: "incomplete", summary: secret, followups: [{ question: secret, sourceScopeIds: ["source-secret"] }] }, "finish research  incomplete"],
      ["wiki_review_finish", { verdict: "changes_requested", reviewedPaths: ["wiki/private/path.md"], findings: [{ id: "finding-secret", path: "wiki/private/path.md" }] }, "finish review  changes requested"],
      ["wiki_write_finish", { summary: secret }, "finish write"],
    ];
    calls.forEach(([toolName, args], index) => session.emit({
      type: "tool_execution_start",
      toolCallId: `wiki-${index}`,
      toolName,
      args,
    }));
    const { telemetry, process } = await wait((entries) => entries.filter((entry) => entry.toolCallId?.startsWith("wiki-")).length === calls.length);
    assert.deepEqual(process.map((entry) => entry.summary), calls.map((entry) => entry[2]));
    const serialized = JSON.stringify({ telemetry, process });
    for (const leaked of ["PRIVATE-", "task-secret", "source-secret", "artifact-secret", "blocker-secret", "private/path", "finding-secret", "42"]) {
      assert.equal(serialized.includes(leaked), false, `leaked ${leaked}`);
    }
  });
});

test("Wiki summaries ignore invalid control values and suppress Wiki error result bodies", async () => {
  await observe(async ({ session, wait }) => {
    session.emit({
      type: "tool_execution_start",
      toolCallId: "wiki-invalid",
      toolName: "wiki_delegate_cancel",
      args: { reasonCode: "PRIVATE-UNKNOWN", summary: "PRIVATE-BODY" },
    });
    await wait((entries) => entries.some((entry) => entry.toolCallId === "wiki-invalid" && !entry.completed));
    session.emit({
      type: "tool_execution_end",
      toolCallId: "wiki-invalid",
      toolName: "wiki_delegate_cancel",
      isError: true,
      result: { content: [{ type: "text", text: "PRIVATE-FILE-BODY\nmore" }] },
    });
    const { process } = await wait((entries) => entries.some((entry) => entry.toolCallId === "wiki-invalid" && entry.completed));
    const entry = process.find((item) => item.toolCallId === "wiki-invalid");
    assert.equal(entry.summary, "cancel wave");
    assert.equal(entry.message, "failed");
    assert.equal(JSON.stringify(entry).includes("PRIVATE"), false);
  });
});

test("Wiki tool errors surface the host-labeled one-line reject reason", async () => {
  await observe(async ({ session, wait }) => {
    session.emit({
      type: "tool_execution_start",
      toolCallId: "wiki-rejected",
      toolName: "wiki_research_finish",
      args: { status: "complete" },
    });
    await wait((entries) => entries.some((entry) => entry.toolCallId === "wiki-rejected" && !entry.completed));
    session.emit({
      type: "tool_execution_end",
      toolCallId: "wiki-rejected",
      toolName: "wiki_research_finish",
      isError: true,
      result: { content: [{ type: "text", text: "wiki_research_finish rejected: missing headings: Scope" }] },
    });
    const { process } = await wait((entries) => entries.some((entry) => entry.toolCallId === "wiki-rejected" && entry.completed));
    const entry = process.find((item) => item.toolCallId === "wiki-rejected");
    assert.equal(entry.severity, "error");
    assert.equal(entry.message, "missing headings: Scope");
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function deliverySession() {
  let listener;
  return {
    sessionFile: "/tmp/wiki-session.jsonl",
    emit(event) { listener?.(event); },
    subscribe(next) {
      listener = next;
      return () => { listener = undefined; };
    },
    getSessionStats() {
      return { assistantMessages: 1, toolCalls: 0, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 };
    },
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("heartbeat and message_update coalesce to the latest pending snapshot", async () => {
  const session = deliverySession();
  const gate = deferred();
  const reports = [];
  let tick = 0;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 10, now: () => 1_700_000_000_000 + (tick += 1),
    async report(telemetry) {
      reports.push(telemetry);
      if (reports.length === 1) await gate.promise;
    },
  });
  subject.start();
  await waitFor(() => reports.length === 1);
  for (let index = 0; index < 12; index += 1) {
    session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "..." }] } });
  }
  await new Promise((resolve) => setTimeout(resolve, 280));
  gate.resolve();
  await subject.stop();
  const afterStart = reports.slice(1);
  assert.ok(afterStart.length >= 1);
  assert.ok(afterStart.length <= 3, `coalesceable snapshots should not queue 1:1, got ${afterStart.length}`);
});

test("tool start and end are delivered even while later heartbeats coalesce", async () => {
  const session = deliverySession();
  const gate = deferred();
  const reports = [];
  let tick = 0;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 15, now: () => 1_700_000_000_000 + (tick += 1),
    async report(telemetry) {
      reports.push(telemetry);
      if (reports.length === 1) await gate.promise;
    },
  });
  subject.start();
  await waitFor(() => reports.length === 1);
  session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "wiki/overview.md" } });
  session.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false, result: { content: [] } });
  for (let index = 0; index < 8; index += 1) {
    session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "..." }] } });
  }
  await new Promise((resolve) => setTimeout(resolve, 280));
  gate.resolve();
  await subject.stop();
  assert.ok(reports.some((telemetry) => telemetry.activeTools?.some((tool) => tool.id === "call-1")));
  assert.ok(reports.some((telemetry) => telemetry.process?.some((entry) => entry.kind === "tool" && entry.toolCallId === "call-1" && entry.completed)));
});

test("heartbeats omit the process array when nothing process-related changed", async () => {
  const session = deliverySession();
  const reports = [];
  let tick = 0;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 15, now: () => 1_700_000_000_000 + (tick += 1),
    async report(telemetry) { reports.push(telemetry); },
  });
  subject.start();
  session.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "wiki/overview.md" } });
  session.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false, result: { content: [] } });
  await waitFor(() => reports.some((telemetry) => telemetry.process?.some((entry) => entry.completed)));
  const before = reports.length;
  await waitFor(() => reports.length > before + 1);
  await subject.stop();
  assert.ok(reports.slice(before).some((telemetry) => !Object.hasOwn(telemetry, "process")));
});

test("a full lifecycle queue drops only coalesceable items and then degrades", async () => {
  const session = deliverySession();
  const gate = deferred();
  const reports = [];
  const health = [];
  let tick = 0;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 1_000, now: () => 1_700_000_000_000 + (tick += 1),
    async report(telemetry) {
      reports.push(telemetry);
      if (reports.length === 1) await gate.promise;
    },
    onHealth(input) { health.push(input); },
  });
  subject.start();
  await waitFor(() => reports.length === 1);
  for (let index = 0; index < 80; index += 1) {
    session.emit({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "read", args: { path: "wiki/overview.md" } });
    session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "..." }] } });
  }
  await waitFor(() => health.some((entry) => entry.status === "degraded" && /saturated/i.test(entry.message ?? "")));
  gate.resolve();
  await subject.stop();
  assert.ok(reports.length <= 50, `delivery must stay bounded, got ${reports.length}`);
  assert.ok(reports.some((telemetry) => telemetry.activeTools?.some((tool) => tool.id === "call-0")));
});

test("an overloaded delivery queue retains the final 80-tool lifecycle and retries a failed final report", async () => {
  const session = deliverySession();
  const gate = deferred();
  const reports = [];
  const health = [];
  let initialStarted = false;
  let finalReportFailures = 0;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 1_000,
    report: async (telemetry) => {
      if (reports.length === 0) {
        initialStarted = true;
        await gate.promise;
      }
      const final = telemetry.activity === "settled" && telemetry.process?.some((entry) => entry.toolCallId === "call-79" && entry.completed);
      if (final && finalReportFailures === 0) {
        finalReportFailures += 1;
        throw new Error("temporary reporter failure");
      }
      reports.push(telemetry);
    },
    onHealth(input) { health.push(input); },
  });
  subject.start();
  await waitFor(() => initialStarted);
  for (let index = 0; index < 80; index += 1) {
    session.emit({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "read", args: { path: "wiki/overview.md" } });
    session.emit({ type: "tool_execution_end", toolCallId: `call-${index}`, toolName: "read", isError: false, result: { content: [] } });
  }
  session.emit({ type: "agent_settled" });
  gate.resolve();
  await subject.stop();
  const final = reports.at(-1);
  assert.equal(final.activity, "settled");
  assert.ok(final.process?.some((entry) => entry.toolCallId === "call-79" && entry.completed));
  assert.equal(finalReportFailures, 1);
  assert.ok(reports.length >= 2, "the final snapshot should be delivered after a temporary report failure");
  assert.equal(health.at(-1)?.status, "healthy");
  assert.ok(reports.length <= 50, `delivery reports should stay bounded, got ${reports.length}`);
});

test("a failed lifecycle snapshot survives later heartbeat coalescing and is retried", async () => {
  const session = deliverySession();
  const reports = [];
  const health = [];
  let failed = false;
  const subject = new PiSessionObserver(session, {
    target: { kind: "lead" }, attempt: 1, timeoutMs: 60_000, workspaceRoot: "/tmp/wiki",
    heartbeatMs: 1_000,
    async report(telemetry) {
      const completed = telemetry.process?.some((entry) => entry.toolCallId === "call-final" && entry.completed);
      if (completed && !failed) {
        failed = true;
        throw new Error("temporary lifecycle failure");
      }
      reports.push(telemetry);
    },
    onHealth(input) { health.push(input); },
  });
  subject.start();
  await waitFor(() => reports.length === 1);
  session.emit({ type: "tool_execution_start", toolCallId: "call-final", toolName: "read", args: { path: "wiki/overview.md" } });
  session.emit({ type: "tool_execution_end", toolCallId: "call-final", toolName: "read", isError: false, result: { content: [] } });
  for (let index = 0; index < 4; index += 1) {
    session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `frame-${index}` }] } });
  }
  await new Promise((resolve) => setTimeout(resolve, 280));
  await subject.stop();
  assert.equal(failed, true);
  assert.ok(reports.some((telemetry) => telemetry.process?.some((entry) => entry.toolCallId === "call-final" && entry.completed)));
  assert.equal(health.at(-1)?.status, "healthy");
});
