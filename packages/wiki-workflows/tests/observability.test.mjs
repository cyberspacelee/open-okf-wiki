import assert from "node:assert/strict";
import test from "node:test";
import {
  activitySemantics,
  agentStatusSemantics,
  batchStatusSemantics,
  projectWikiAgentLines,
  projectWikiRunEvent,
  projectWikiRunObservability,
  runStatusSemantics,
  wikiContextPressureTone,
} from "../dist/ui/observability.js";

function batchTask(id, role, status, extra = {}) {
  const { activeTool, attempts, batch = 2, activity, activeTools, health, attempt, ...rest } = extra;
  const terminal = ["complete", "incomplete", "failed", "cancelled"].includes(status);
  return {
    target: { kind: "task", batch, taskId: id },
    role,
    status,
    attempt: attempt ?? attempts ?? 1,
    activity: activity ?? (status === "queued" ? "starting" : status === "running" && activeTool ? "using_tool" : terminal ? "settled" : "waiting_model"),
    activeTools: activeTools ?? (activeTool ? [activeTool] : []),
    health: health ?? "healthy",
    ...rest,
  };
}

const now = Date.parse("2026-08-15T00:02:00.000Z");

function run(overrides = {}) {
  return {
    id: "run-1", cwd: "/repo", status: "running",
    createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:02:00.000Z",
    ...overrides,
  };
}

function lead(overrides = {}) {
  return {
    target: { kind: "lead" }, role: "lead", status: "running", attempt: 1,
    activity: "delegating", activeTools: [], health: "healthy",
    lastActivityAt: "2026-08-15T00:01:57.000Z",
    lastHeartbeatAt: "2026-08-15T00:01:59.000Z",
    usage: { turns: 8, contextTokens: 800, contextWindow: 1000, contextPercent: 80 },
    ...overrides,
  };
}

test("status, agent, batch, and activity share one marker and tone matrix", () => {
  assert.deepEqual(runStatusSemantics("succeeded"), { marker: "✓", tone: "success", terminal: true });
  assert.deepEqual(runStatusSemantics("paused"), { marker: "⏸", tone: "warning", terminal: false });
  assert.deepEqual(agentStatusSemantics("retrying"), { marker: "◐", tone: "warning", terminal: false });
  assert.deepEqual(agentStatusSemantics("cancelled"), { marker: "○", tone: "muted", terminal: true });
  assert.deepEqual(batchStatusSemantics("partial"), { marker: "◐", tone: "warning", terminal: true });
  assert.deepEqual(activitySemantics({ severity: "error", completed: true }), { marker: "✗", tone: "error", terminal: true });
  assert.deepEqual(activitySemantics({ severity: "info", completed: false }), { marker: "◆", tone: "accent", terminal: false });
  assert.deepEqual(activitySemantics({ severity: "info", completed: true }), { marker: "✓", tone: "success", terminal: true });
});

test("strict run events have one semantic projection without a compatibility data bag", () => {
  const base = { version: 1, runId: "run-1", at: "2026-08-15T00:00:00.000Z" };
  assert.deepEqual(projectWikiRunEvent({
    ...base, type: "stage", stage: "validate", message: "Validating candidate",
  }), { text: "[validate] Validating candidate", tone: "accent", visible: false });
  assert.deepEqual(projectWikiRunEvent({
    ...base, type: "delegate", phase: "settled", batch: 2, completed: 3, total: 4,
    taskId: "review-auth", message: "Reviewing",
  }), { text: "[batch 2 3/4] Reviewing review-auth", tone: "accent", visible: true });
  assert.deepEqual(projectWikiRunEvent({
    ...base, type: "warning", code: "cleanup_failed", detail: "temp directory remains", message: "Cleanup failed",
  }), { text: "Cleanup failed: temp directory remains", tone: "warning", visible: true });
});

test("run projection includes batch, task lines, tool outcomes, context pressure, and tone", () => {
  const projected = projectWikiRunObservability(run({
    progress: {
      stage: "lead", language: "zh", lead: lead(),
      currentBatch: { batch: 2, status: "running", completed: 1, total: 3, tasks: [
        batchTask("a", "write", "running", { activeTool: { name: "read", startedAt: "2026-08-15T00:01:50.000Z", summary: "src/a.ts" } }),
        batchTask("b", "review", "queued"),
      ] },
    },
  }), now);
  assert.equal(projected.status.label, "运行中");
  assert.equal(projected.marker, "◆");
  assert.equal(projected.tone, "accent");
  assert.deepEqual(projected.stage, { key: "lead", label: "生成" });
  assert.equal(projected.health, "healthy");
  assert.equal(projected.liveness, "quiet");
  assert.equal(projected.activityLabel, "batch 2 · 1/3");
  assert.equal(projected.leadLabel, "主导");
  assert.equal(projected.leadDetail, "委派中");
  assert.equal(projected.batch?.batch, 2);
  assert.equal(projected.batch?.label, "批次");
  assert.equal(projected.batch?.countLabel, "1/3");
  assert.equal(projected.batch?.running, 1);
  assert.equal(projected.batch?.marker, "◆");
  assert.equal(projected.batch?.tone, "accent");
  assert.equal(projected.batch?.tasks.length, 2);
  assert.equal(projected.batch?.tasks[0].marker, "◆");
  assert.equal(projected.batch?.tasks[0].tone, "accent");
  assert.equal(projected.batch?.tasks[0].detail, "read  src/a.ts");
  assert.equal(projected.batch?.tasks[0].activity, "read…");
  assert.equal(projected.batch?.tasks[1].marker, "·");
  assert.equal(projected.contextPressure?.percent, 80);
  assert.equal(projected.contextPressure?.label, "ctx 80%");
  assert.equal(projected.contextPressure?.tone, "warning");
  assert.deepEqual(projected.recentToolOutcomes, []);
});

test("run projection maps recent tool outcomes without inventing start verbs", () => {
  const projected = projectWikiRunObservability(run({
    progress: {
      stage: "lead",
      lead: lead({ activity: "using_tool", activeTools: [{ name: "read", startedAt: "2026-08-15T00:01:50.000Z", summary: "src/a.ts" }] }),
      recentActivity: [
        { sequence: 1, at: "2026-08-15T00:01:48.000Z", kind: "tool", severity: "info", message: "read started", toolName: "read", completed: false },
        { sequence: 2, at: "2026-08-15T00:01:49.000Z", kind: "tool", severity: "info", message: "", toolName: "grep", summary: "TODO  src", completed: true },
        { sequence: 3, at: "2026-08-15T00:01:50.000Z", kind: "tool", severity: "error", message: "Path is not assigned", toolName: "write", completed: true },
      ],
    },
  }), now);
  assert.equal(projected.liveness, "active");
  assert.equal(projected.activityLabel, "read");
  assert.equal(projected.leadDetail, "read  src/a.ts");
  assert.deepEqual(projected.recentToolOutcomes, [
    { marker: "✓", tone: "success", name: "grep", detail: "TODO  src" },
    { marker: "✗", tone: "error", name: "write", detail: "Path is not assigned" },
  ]);
});

test("process tab projection includes incomplete tool entries", () => {
  const inspection = {
    runId: "run-1",
    agent: {
      target: { kind: "lead" }, role: "lead", status: "running", attempt: 1,
      activity: "using_tool",
      activeTools: [{ name: "read", startedAt: "2026-08-12T00:00:01.000Z", summary: "src/a.ts" }],
      health: "healthy",
    },
    process: [
      { sequence: 1, at: "2026-08-12T00:00:01.000Z", kind: "tool", severity: "info", message: "", toolCallId: "c1", toolName: "read", summary: "src/a.ts", completed: false },
      { sequence: 2, at: "2026-08-12T00:00:02.000Z", kind: "tool", severity: "info", message: "", toolCallId: "c2", toolName: "grep", summary: "TODO  src", durationMs: 400, completed: true },
    ],
    messages: [
      { at: "2026-08-12T00:00:01.500Z", text: "I will inspect the source first." },
    ],
  };
  const lines = projectWikiAgentLines(inspection, "process");
  const rendered = lines.map((line) => line.map((span) => span.text).join("")).join("\n");
  assert.equal(rendered, [
    "Wiki run-1  ·  lead  ·  process",
    "◆ read  src/a.ts",
    "✓ grep · 0s  TODO  src",
  ].join("\n"));
  assert.doesNotMatch(rendered, /I will inspect the source first|◆ model/);
  assert.equal(lines[1].find((span) => span.text === "◆ ")?.role, "accent");
  assert.equal(lines[2].find((span) => span.text === "✓ ")?.role, "success");
});

test("context pressure tone thresholds are shared by every adapter", () => {
  assert.equal(wikiContextPressureTone(undefined), undefined);
  assert.equal(wikiContextPressureTone(70), undefined);
  assert.equal(wikiContextPressureTone(71), "warning");
  assert.equal(wikiContextPressureTone(91), "error");
});

test("degraded, silent-live, and terminal states are distinct", () => {
  const degraded = projectWikiRunObservability(run({ progress: { stage: "lead", lead: lead({ health: "degraded" }) } }), now);
  assert.equal(degraded.liveness, "degraded");
  assert.equal(degraded.healthNotice, "observability degraded");
  assert.equal(degraded.leadMarker, "!");
  const silent = projectWikiRunObservability(run({ progress: { stage: "lead", lead: lead({ lastActivityAt: "2026-08-14T23:58:00.000Z" }) } }), now);
  assert.equal(silent.liveness, "alive_without_activity");
  assert.equal(silent.activityAge, "4m");
  assert.equal(silent.silenceNotice, "no Pi activity 4m · session alive 1s");
  const terminal = projectWikiRunObservability(run({ status: "failed", progress: { stage: "publish", lead: lead({ health: "degraded" }) } }), now);
  assert.equal(terminal.liveness, "terminal");
  assert.equal(terminal.status.tone, "error");
  assert.equal(terminal.tone, "error");
  assert.equal(terminal.marker, "✗");
});
