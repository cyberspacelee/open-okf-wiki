import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWikiCliCommand,
  renderWikiAgent,
  renderWikiRun,
  renderWikiSnapshot,
  renderWikiRuns,
  wikiCliHelp,
} from "../dist/cli.js";
import { formatWikiContext, projectWikiAgentLines } from "../dist/ui/observability.js";

test("parses the compact Wiki command surface", () => {
  assert.deepEqual(parseWikiCliCommand(""), { action: "run" });
  assert.deepEqual(parseWikiCliCommand("auth and sessions"), {
    action: "run",
    focus: "auth and sessions",
  });
  assert.deepEqual(parseWikiCliCommand('full "public API"'), {
    action: "run",
    focus: "full public API",
  });
  assert.deepEqual(parseWikiCliCommand("status run-1"), { action: "status", runId: "run-1" });
  assert.deepEqual(parseWikiCliCommand("runs"), { action: "runs" });
  assert.deepEqual(parseWikiCliCommand("pause"), { action: "pause" });
  assert.deepEqual(parseWikiCliCommand("resume"), { action: "resume" });
  assert.deepEqual(parseWikiCliCommand("cancel run.2"), { action: "cancel", runId: "run.2" });
  assert.deepEqual(parseWikiCliCommand("init"), {
    action: "init", language: "zh", exclude: [], defaultSourceIgnores: true,
  });
  assert.deepEqual(parseWikiCliCommand('init docs --lang en --exclude "vendor/**" --exclude generated/** --no-default-ignores'), {
    action: "init", workspace: "docs", language: "en", exclude: ["vendor/**", "generated/**"], defaultSourceIgnores: false,
  });
  assert.deepEqual(parseWikiCliCommand("source add link ../api --name backend --workspace docs"), {
    action: "source-add", kind: "link", localPath: "../api", name: "backend", workspace: "docs",
  });
  assert.deepEqual(parseWikiCliCommand("source add clone https://example.test/web.git --ref main --name web"), {
    action: "source-add", kind: "clone", url: "https://example.test/web.git", ref: "main", name: "web",
  });
});

test("rejects ambiguous control commands", () => {
  assert.throws(() => parseWikiCliCommand("runs extra"), /does not accept arguments/);
  assert.throws(() => parseWikiCliCommand("resume one two"), /Usage/);
  assert.throws(() => parseWikiCliCommand("status ../run"), /Invalid Wiki run id/);
  assert.throws(() => parseWikiCliCommand("init a b"), /Usage/);
  assert.throws(() => parseWikiCliCommand("init --lang fr"), /zh or en/);
  assert.throws(() => parseWikiCliCommand("init --exclude"), /requires a value/);
  assert.throws(() => parseWikiCliCommand("source add link ../api --ref main"), /Unknown/);
  assert.throws(() => parseWikiCliCommand("source add clone"), /Usage/);
});

test("renders plain run, list, and progress output", () => {
  assert.equal(renderWikiRun(undefined), "Wiki: no run.");
  assert.equal(renderWikiRun({
    id: "run-1",
    cwd: "/repo",
    status: "running",
    focus: "auth",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  }), "Wiki run-1 | running | auth");
  assert.equal(renderWikiRuns([]), "Wiki runs: none.");
  assert.match(renderWikiRuns([{ id: "run-1", status: "paused", updatedAt: "2026-08-12" }]), /run-1 \| paused/);
});

test("status snapshots state their freshness", () => {
  const rendered = renderWikiSnapshot({
    id: "run-1", cwd: "/repo", status: "running",
    createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:01:02.000Z",
  });
  const expected = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "medium",
  }).format(Date.parse("2026-08-12T00:01:02.000Z"));
  assert.ok(rendered.endsWith(`snapshot as of ${expected}`));
});

test("renders absolute dates in the system timezone and preserves invalid values", () => {
  const instant = "2026-08-12T00:01:02.000Z";
  const expected = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "medium",
  }).format(Date.parse(instant));
  const paused = renderWikiRun({
    id: "run-1", cwd: "/repo", status: "paused",
    createdAt: instant, updatedAt: instant,
    progress: { stage: "lead" },
    pause: { reason: "quota", retryAt: instant },
  });
  assert.ok(paused.includes(`retry at ${expected}`));
  assert.ok(renderWikiRuns([{ id: "run-1", status: "paused", updatedAt: instant }]).includes(expected));
  assert.match(renderWikiRuns([{ id: "run-2", status: "paused", updatedAt: "not-a-date" }]), /not-a-date/);
});

test("help lists management and run commands", () => {
  const help = wikiCliHelp();
  assert.match(help, /\/wiki \[focus\]/);
  assert.doesNotMatch(help, /regenerate|refresh/);
  assert.match(help, /\/wiki init/);
  assert.match(help, /\/wiki source add link/);
  assert.match(help, /\/wiki source add clone/);
  assert.match(help, /\/wiki status \[run-id\] \[lead\|batch-N\/task-id\] \[--process\]/);
  assert.doesNotMatch(help, /open|history|artifacts|stop/);
});

test("parses status with agent target and process flag", () => {
  assert.deepEqual(parseWikiCliCommand("status"), { action: "status" });
  assert.deepEqual(parseWikiCliCommand("status run-1"), { action: "status", runId: "run-1" });
  assert.deepEqual(parseWikiCliCommand("status run-1 lead --process"), {
    action: "status", runId: "run-1", target: { kind: "lead" }, process: true,
  });
});

test("parses leader and batch-qualified agent targets", () => {
  assert.deepEqual(parseWikiCliCommand("status run-1 lead"), {
    action: "status", runId: "run-1", target: { kind: "lead" },
  });
  assert.deepEqual(parseWikiCliCommand("status run-1 batch-2/write-auth --process"), {
    action: "status", runId: "run-1", target: { kind: "task", batch: 2, taskId: "write-auth" }, process: true,
  });
});

test("rejects status --process without a task id and invalid task ids", () => {
  const usage = /Usage: \/wiki status \[run-id\] \[lead\|batch-N\/task-id\] \[--process\]/;
  assert.throws(() => parseWikiCliCommand("status --process"), usage);
  assert.throws(() => parseWikiCliCommand("status run-1 --process"), usage);
  assert.throws(() => parseWikiCliCommand("status run-1 lead extra"), usage);
  assert.throws(() => parseWikiCliCommand("status ../task"), /Invalid Wiki run id/);
  assert.throws(() => parseWikiCliCommand("status run-1 task-9"), /must be lead/);
});

test("renders a progress card with stage, batch, and task icons", () => {
  const rendered = renderWikiRun({
    id: "run-1",
    cwd: "/repo",
    status: "running",
    focus: "auth",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:04:12.000Z",
    progress: {
      stage: "lead",
      lastMessage: "Wrote auth/domain.md",
      currentBatch: { batch: 2, status: "running", completed: 3, total: 5, tasks: [
        { target: { kind: "task", batch: 2, taskId: "t1" }, role: "research", status: "complete", attempt: 1, activity: "settled", activeTools: [], health: "healthy" },
        { target: { kind: "task", batch: 2, taskId: "t2" }, role: "write", status: "running", attempt: 2, activity: "waiting_model", activeTools: [], health: "healthy" },
        { target: { kind: "task", batch: 2, taskId: "t3" }, role: "review", status: "queued", attempt: 1, activity: "starting", activeTools: [], health: "healthy" },
        { target: { kind: "task", batch: 2, taskId: "t4" }, role: "write", status: "failed", attempt: 1, activity: "settled", activeTools: [], health: "healthy" },
        { target: { kind: "task", batch: 2, taskId: "t5" }, role: "review", status: "incomplete", attempt: 1, activity: "settled", activeTools: [], health: "healthy" },
      ] },
    },
  });
  assert.equal(rendered, [
    "Wiki run-1  ◆ running  [4m12s]",
    "stage  generate · batch 2 · 3/5 done, 1 running",
    "focus  auth",
    "",
    "  ✓ research  t1  [attempt 1]",
    "  ◆ write  t2  [attempt 2]",
    "  · review  t3  [attempt 1]",
    "  ✗ write  t4  [attempt 1]",
    "  ◐ review  t5  [attempt 1]",
    "last  Wrote auth/domain.md",
  ].join("\n"));
});

test("renders context stats for an agent", () => {
  assert.equal(
    formatWikiContext({
      turns: 3,
      toolCalls: 4,
      input: 1200,
      output: 620,
      contextTokens: 8100,
      contextWindow: 200_000,
      contextPercent: 4.1,
      cost: 0.012,
    }),
    "3 turns  4 tools  ↑1.2k  ↓620  ctx 8.1k/200k 4%  $0.01",
  );
});

test("structured agent tabs preserve the exact plain-text output", () => {
  const lastActivityAt = "2026-08-12T00:01:01.000Z";
  const lastHeartbeatAt = "2026-08-12T00:01:02.000Z";
  const deadlineAt = "2026-08-12T00:05:00.000Z";
  const formatDate = (value) => new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "medium",
  }).format(Date.parse(value));
  const inspection = {
    runId: "run-1",
    agent: {
      target: { kind: "task", batch: 2, taskId: "write-auth" },
      role: "write",
      status: "incomplete",
      attempt: 2,
      activity: "using_tool",
      activeTools: [
        { id: "call-1", name: "read", startedAt: lastActivityAt },
        { id: "call-2", name: "write", startedAt: lastActivityAt },
      ],
      health: "healthy",
      lastActivityAt,
      lastHeartbeatAt,
      deadlineAt,
      usage: { turns: 2, toolCalls: 3 },
      summary: "first summary line\nsecond summary line",
    },
    process: [],
    handoff: "first handoff line\nsecond handoff line",
  };
  const expected = {
    overview: [
      "Wiki run-1  ·  batch-2/write-auth",
      "write  incomplete  ·  using tool  ·  attempt 2",
      "tools  read, write",
      `heartbeat  ${formatDate(lastHeartbeatAt)}`,
      `Pi activity  ${formatDate(lastActivityAt)}`,
      `deadline  ${formatDate(deadlineAt)}`,
      "context  2 turns  3 tools",
      "summary",
      "  first summary line",
      "second summary line",
    ].join("\n"),
    process: [
      "Wiki run-1  ·  batch-2/write-auth  ·  process",
      "process  unavailable for this agent",
    ].join("\n"),
    output: [
      "Wiki run-1  ·  batch-2/write-auth",
      "output",
      "first handoff line",
      "second handoff line",
    ].join("\n"),
  };

  for (const tab of ["overview", "process", "output"]) {
    const flattened = projectWikiAgentLines(inspection, tab)
      .map((line) => line.map((span) => span.text).join(""))
      .join("\n");
    assert.equal(renderWikiAgent(inspection, tab), expected[tab]);
    assert.equal(flattened, expected[tab]);
  }
});

test("process tab shows tool outcomes without start or complete verbs", () => {
  const inspection = {
    runId: "run-1",
    agent: {
      target: { kind: "lead" }, role: "lead", status: "running", attempt: 1,
      activity: "using_tool", activeTools: [], health: "healthy",
    },
    process: [
      { sequence: 1, at: "2026-08-12T00:00:01.000Z", kind: "tool", severity: "info", message: "read started", toolName: "read", completed: false },
      { sequence: 2, at: "2026-08-12T00:00:02.000Z", kind: "tool", severity: "info", message: "", toolName: "read", summary: "src/a.ts", durationMs: 1200, completed: true },
      { sequence: 3, at: "2026-08-12T00:00:03.000Z", kind: "tool", severity: "error", message: "Path is not assigned", toolName: "write", durationMs: 800, completed: true },
      { sequence: 4, at: "2026-08-12T00:00:04.000Z", kind: "compaction", severity: "info", message: "Context compaction completed", durationMs: 400, completed: true },
    ],
  };

  const rendered = renderWikiAgent(inspection, "process");
  assert.equal(rendered, [
    "Wiki run-1  ·  lead  ·  process",
    "◆ read",
    "✓ read · 1s  src/a.ts",
    "✗ write · 1s  Path is not assigned",
    "✓ compaction · 0s  Context compaction completed",
  ].join("\n"));
  assert.doesNotMatch(rendered, /read started|read succeeded|write failed:/);
  const lines = projectWikiAgentLines(inspection, "process");
  assert.equal(lines[1].find((span) => span.text === "◆ ")?.role, "accent");
  assert.equal(lines[2].find((span) => span.text === "✓ ")?.role, "success");
  assert.equal(lines[3].find((span) => span.text.includes("Path is not assigned"))?.role, "error");
});

test("process tab shows tool rows and omits assistant messages", () => {
  const inspection = {
    runId: "run-1",
    agent: {
      target: { kind: "lead" }, role: "lead", status: "running", attempt: 1,
      activity: "streaming", activeTools: [], health: "healthy",
    },
    process: [
      { sequence: 1, at: "2026-08-12T00:00:01.000Z", kind: "tool", severity: "info", message: "", toolName: "read", summary: "src/a.ts", completed: false },
      { sequence: 2, at: "2026-08-12T00:00:02.000Z", kind: "tool", severity: "info", message: "", toolName: "grep", summary: "TODO  src", completed: true },
    ],
    messages: [
      { at: "2026-08-12T00:00:01.000Z", text: "I will read auth next.\nThen write the page." },
    ],
  };

  const rendered = renderWikiAgent(inspection, "process");
  assert.equal(rendered, [
    "Wiki run-1  ·  lead  ·  process",
    "◆ read  src/a.ts",
    "✓ grep  TODO  src",
  ].join("\n"));
  assert.doesNotMatch(rendered, /I will read auth next|Then write the page|◆ model/);
});

test("retrying agents share one warning presentation across structured and plain output", () => {
  const inspection = {
    runId: "run-2",
    agent: {
      target: { kind: "lead" }, role: "lead", status: "retrying", attempt: 3,
      activity: "retry_wait", activeTools: [], health: "healthy",
    },
    process: [],
  };

  assert.equal(
    renderWikiAgent(inspection),
    "Wiki run-2  ·  lead\nlead  retrying  ·  retry wait  ·  attempt 3",
  );
  assert.equal(
    projectWikiAgentLines(inspection)[1].find((span) => span.text === "retrying")?.role,
    "warning",
  );
});
