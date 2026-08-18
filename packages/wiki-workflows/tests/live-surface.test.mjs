import assert from "node:assert/strict";
import test from "node:test";
import {
  themeWikiLiveText,
  wikiFooterStatus,
  wikiWidgetLines,
  wikiWidgetLinesFingerprint,
} from "../dist/ui/live-surface.js";
import { formatLocalDateTime } from "../dist/ui/time-format.js";

const now = Date.parse("2026-08-12T00:01:00.000Z");
function view(overrides = {}) {
  return { id: "run-1", cwd: "/repo", status: "running", createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:01:00.000Z", ...overrides };
}
function lead(overrides = {}) {
  return { target: { kind: "lead" }, role: "lead", status: "running", attempt: 1, activity: "synthesizing", activeTools: [], health: "healthy", lastActivityAt: "2026-08-12T00:00:57.000Z", lastHeartbeatAt: "2026-08-12T00:00:59.000Z", usage: { turns: 8, contextPercent: 24 }, ...overrides };
}

function batchTask(id, role, status, extra = {}) {
  const { activeTool, attempts, batch = 1, activity, activeTools, health, attempt, ...rest } = extra;
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

test("footer accepts terminal, quota, and quiet running states", () => {
  assert.equal(wikiFooterStatus(view({ progress: { stage: "lead", lead: lead() } }), now), "wiki ◆ lead · synthesizing · activity 3s · ctx 24%");
  assert.equal(wikiFooterStatus(view({ progress: { stage: "lead" } }), now), "wiki ◆ generate");
  assert.equal(wikiFooterStatus(view({ status: "succeeded" })), "wiki ✓ published");
  assert.equal(wikiFooterStatus(view({ status: "failed", progress: { language: "zh" } })), "wiki ✗ 失败");
  assert.equal(wikiFooterStatus(view({ status: "cancelled", progress: { language: "zh" } })), "wiki ○ 已取消");
  assert.equal(wikiFooterStatus(view({ status: "paused", pause: { reason: "quota", summary: "limited", retryAt: "2026-08-12T14:20:00.000Z" } })), `wiki ⏸ quota · retry ${formatLocalDateTime("2026-08-12T14:20:00.000Z")}`);
});

test("widget accepts a compact batch card without start verbs", () => {
  assert.deepEqual(wikiWidgetLines(view()), ["◆ lead"]);
  const tasks = [
    batchTask("bad", "review", "failed", { batch: 2, summary: "validation" }),
    batchTask("active", "write", "running", { batch: 2, health: "degraded", activeTool: { name: "read", startedAt: "2026-08-12T00:00:50Z", summary: "src/a.ts" } }),
    batchTask("queued", "research", "queued", { batch: 2 }),
    batchTask("done", "write", "complete", { batch: 2 }),
    batchTask("done-2", "review", "complete", { batch: 2 }),
  ];
  const lines = wikiWidgetLines(view({ progress: { stage: "lead", lead: lead(), currentBatch: { batch: 2, status: "running", completed: 2, total: 5, tasks } } }));
  assert.deepEqual(lines, [
    "◆ lead  synthesizing",
    "batch 2  2/5",
    "  ✗ review  bad  validation",
    "  ! write  active  read  src/a.ts  observability degraded",
    "  · research  queued",
    "  +2 more",
  ]);
  assert.doesNotMatch(lines.join("\n"), /started|starting|succeeded|completed|LEAD|BATCH/);
});

test("widget accepts tool success and failure above the editor", () => {
  const lines = wikiWidgetLines(view({
    progress: {
      stage: "lead",
      lead: lead({ activity: "using_tool", activeTools: [{ name: "read", startedAt: "2026-08-12T00:00:50Z", summary: "src/a.ts" }] }),
      recentActivity: [
        { sequence: 1, at: "2026-08-12T00:00:48Z", kind: "tool", severity: "info", message: "read started", toolName: "read", completed: false },
        { sequence: 2, at: "2026-08-12T00:00:49Z", kind: "tool", severity: "info", message: "", toolName: "grep", summary: "TODO  src", completed: true },
        { sequence: 3, at: "2026-08-12T00:00:50Z", kind: "tool", severity: "error", message: "Path is not assigned", toolName: "write", completed: true },
      ],
    },
  }));
  assert.deepEqual(lines, [
    "◆ lead  read  src/a.ts",
    "  ✓ grep  TODO  src",
    "  ✗ write  Path is not assigned",
  ]);
});

test("widget accepts Chinese labels for the live card", () => {
  const lines = wikiWidgetLines(view({
    progress: {
      stage: "lead",
      language: "zh",
      lead: lead({ activity: "delegating" }),
      currentBatch: { batch: 1, status: "running", completed: 0, total: 2, tasks: [
        batchTask("auth", "write", "running"),
        batchTask("old", "review", "complete"),
      ] },
    },
  }));
  assert.deepEqual(lines, [
    "◆ 主导  委派中",
    "批次 1  0/2",
    "  ◆ write  auth",
    "  ✓ review  old",
  ]);
});

test("widget shows a cluster label when the task id is a cluster or wiki path", () => {
  const lines = wikiWidgetLines(view({
    progress: {
      stage: "lead",
      lead: lead(),
      currentBatch: { batch: 1, status: "running", completed: 0, total: 3, tasks: [
        batchTask("wiki/core/runtime/concept.md", "write", "running"),
        batchTask("wiki/core/runtime/flows.md", "review", "queued"),
        batchTask("core/runtime", "research", "queued"),
      ] },
    },
  }));
  assert.deepEqual(lines, [
    "◆ lead  synthesizing",
    "batch 1  0/3",
    "  ◆ write  wiki/core/runtime/concept.md",
    "  · review  wiki/core/runtime/flows.md",
    "  · research  core/runtime",
  ]);
  const withoutPaths = wikiWidgetLines(view({
    progress: {
      stage: "lead",
      lead: lead(),
      currentBatch: { batch: 1, status: "running", completed: 0, total: 1, tasks: [
        batchTask("write-auth", "write", "running"),
      ] },
    },
  }));
  assert.deepEqual(withoutPaths.slice(2), ["  ◆ write  write-auth"]);
});

test("live text paints success, failure, warning, and running marks", () => {
  const calls = [];
  const theme = { fg(color, text) { calls.push([color, text]); return `[${color}]${text}`; } };
  assert.equal(themeWikiLiveText(theme, "✓ grep  TODO"), "[success]✓ grep  TODO");
  assert.equal(themeWikiLiveText(theme, "✗ write  Path is not assigned"), "[error]✗ write  Path is not assigned");
  assert.equal(themeWikiLiveText(theme, "! lead  observability degraded"), "[warning]! lead  observability degraded");
  assert.equal(themeWikiLiveText(theme, "◆ lead  read  src/a.ts"), "[accent]◆ lead  read  src/a.ts");
  assert.equal(themeWikiLiveText(theme, "wiki ⏸ quota"), "[warning]wiki ⏸ quota");
  assert.equal(themeWikiLiveText(undefined, "◆ lead"), "◆ lead");
  assert.deepEqual(calls.map(([color]) => color), ["success", "error", "warning", "accent", "warning"]);
});

test("long wait distinguishes Pi silence from session liveness", () => {
  const footer = wikiFooterStatus(view({ progress: { stage: "lead", lead: lead({ warning: "long_wait", lastActivityAt: "2026-08-11T23:58:00Z" }) } }), now);
  assert.equal(footer, "wiki ! lead · no Pi activity 3m · session alive 1s");
});

test("widget fingerprint is stable for the same lines and changes when they differ", () => {
  assert.equal(wikiWidgetLinesFingerprint(["◆ lead", "batch 1  0/2"]), "◆ lead\nbatch 1  0/2");
  assert.equal(wikiWidgetLinesFingerprint(wikiWidgetLines(view())), wikiWidgetLinesFingerprint(["◆ lead"]));
  assert.notEqual(wikiWidgetLinesFingerprint(["◆ lead"]), wikiWidgetLinesFingerprint(["! lead  synthesizing"]));
  assert.equal(wikiWidgetLinesFingerprint(undefined), "");
});

test("observability health comes from the agent snapshot, independent of the activity tail", () => {
  const warnings = Array.from({ length: 25 }, (_, index) => ({ sequence: index + 1, at: "2026-08-12T00:00:58Z", kind: "warning", severity: "warning", target: { kind: "lead" }, message: `ordinary warning ${index}` }));
  const failed = view({ progress: { stage: "lead", lead: lead({ health: "degraded" }), recentActivity: warnings } });
  assert.equal(wikiFooterStatus(failed, now), "wiki ! lead · observability degraded");
  assert.equal(wikiWidgetLines(failed)[0], "! lead  synthesizing  observability degraded");
  const recovered = view({ progress: { stage: "lead", lead: lead({ health: "healthy" }), recentActivity: warnings } });
  assert.equal(wikiFooterStatus(recovered, now), "wiki ◆ lead · synthesizing · activity 3s · ctx 24%");
  assert.equal(wikiWidgetLines(recovered)[0], "◆ lead  synthesizing");
});
