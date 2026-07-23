/**
 * Trajectory store: append / load / fold last-by-unitId (ADR 0031 Wave 2).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProductSseEvent, ProductWorkUnitEvent } from "@okf-wiki/contract";
import {
  appendTrajectory,
  capProductEventForTrajectory,
  foldWorkUnits,
  lastGateFromTrajectory,
  lastLinkedRunId,
  lastPlanFromTrajectory,
  lastRunPhase,
  loadTrajectory,
  operatorTrajectoryPath,
} from "./trajectory-store.ts";

async function withTempRoot(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-traj-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function workUnit(
  overrides: Partial<ProductWorkUnitEvent> &
    Pick<ProductWorkUnitEvent, "unitId" | "status">,
): ProductWorkUnitEvent {
  return {
    source: "product",
    kind: "work_unit",
    sessionId: "sess-1",
    runId: "run-1",
    role: "leaf",
    updatedAt: 1,
    ...overrides,
  };
}

test("operatorTrajectoryPath under pi-sessions/<id>/", () => {
  const p = operatorTrajectoryPath("/ws", "abc-123");
  assert.match(p, /pi-sessions[/\\]abc-123[/\\]operator-trajectory\.jsonl$/);
});

test("appendTrajectory + loadTrajectory round-trip", async () => {
  await withTempRoot(async (root) => {
    const sessionId = "s1";
    const events: ProductSseEvent[] = [
      {
        source: "product",
        kind: "run_phase",
        sessionId,
        runId: "r1",
        phase: "planning",
      },
      workUnit({ unitId: "planner", role: "planner", status: "running" }),
      workUnit({
        unitId: "planner",
        role: "planner",
        status: "settled",
        summary: "done",
      }),
    ];
    for (const e of events) {
      await appendTrajectory(root, sessionId, e);
    }
    const loaded = await loadTrajectory(root, sessionId);
    assert.equal(loaded.length, 3);
    assert.equal(loaded[0]?.kind, "run_phase");
    assert.equal(loaded[2]?.kind, "work_unit");
    if (loaded[2]?.kind === "work_unit") {
      assert.equal(loaded[2].status, "settled");
      assert.equal(loaded[2].summary, "done");
    }

    const raw = await readFile(
      operatorTrajectoryPath(root, sessionId),
      "utf8",
    );
    assert.equal(raw.trim().split("\n").length, 3);
  });
});

test("loadTrajectory missing file returns empty", async () => {
  await withTempRoot(async (root) => {
    const loaded = await loadTrajectory(root, "no-such-session");
    assert.deepEqual(loaded, []);
  });
});

test("foldWorkUnits keeps last snapshot per unitId", () => {
  const events: ProductSseEvent[] = [
    workUnit({ unitId: "a", status: "running", task: "first" }),
    workUnit({ unitId: "b", status: "running", role: "domain" }),
    workUnit({ unitId: "a", status: "settled", summary: "a-done" }),
    {
      source: "product",
      kind: "run_phase",
      sessionId: "sess-1",
      phase: "writing",
    },
  ];
  const folded = foldWorkUnits(events);
  assert.equal(folded.size, 2);
  assert.equal(folded.get("a")?.status, "settled");
  assert.equal(folded.get("a")?.summary, "a-done");
  assert.equal(folded.get("b")?.status, "running");
  assert.equal(folded.get("b")?.role, "domain");
});

test("lastRunPhase returns most recent run_phase", () => {
  const events: ProductSseEvent[] = [
    {
      source: "product",
      kind: "run_phase",
      sessionId: "s",
      phase: "planning",
    },
    workUnit({ unitId: "x", status: "running" }),
    {
      source: "product",
      kind: "run_phase",
      sessionId: "s",
      phase: "writing",
    },
  ];
  assert.equal(lastRunPhase(events), "writing");
  assert.equal(lastRunPhase([]), undefined);
});

test("lastLinkedRunId / lastPlanFromTrajectory for cold re-entry", () => {
  const plan = {
    version: 1 as const,
    summary: "wiki for cold restore",
    audience: "devs",
    domains: [],
    pages: [
      {
        path: "overview.md",
        purpose: "overview",
        domainIds: [],
        questions: [],
        template: "overview" as const,
        critical: true,
      },
    ],
    openQuestions: [],
    acceptance: {
      reviewRequired: false,
      maxRepairRounds: 0,
      blockingSeverities: ["blocking" as const],
    },
    changelog: [],
  };
  const events: ProductSseEvent[] = [
    {
      source: "product",
      kind: "run_link",
      sessionId: "s",
      runId: "run-old",
      status: "running",
    },
    workUnit({ unitId: "planner", status: "settled", runId: "run-new" }),
    {
      source: "product",
      kind: "gate",
      sessionId: "s",
      runId: "run-new",
      gate: "publication",
      question: "publish?",
      plan,
      pages: ["overview.md"],
    },
  ];
  assert.equal(lastLinkedRunId(events), "run-new");
  assert.equal(lastPlanFromTrajectory(events)?.summary, plan.summary);
  assert.equal(lastGateFromTrajectory(events)?.gate, "publication");
  assert.equal(lastLinkedRunId([]), undefined);
  assert.equal(lastPlanFromTrajectory([]), undefined);
});

test("capProductEventForTrajectory truncates message fields at 64k", () => {
  const big = "x".repeat(70_000);
  const event = workUnit({
    unitId: "u",
    status: "running",
    message: { thinking: big, text: big },
  });
  const capped = capProductEventForTrajectory(event);
  assert.equal(capped.kind, "work_unit");
  if (capped.kind === "work_unit") {
    assert.equal(capped.message?.thinking?.length, 64_000);
    assert.equal(capped.message?.text?.length, 64_000);
  }
});

test("appendTrajectory rejects non-whitelist kinds", async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () =>
        appendTrajectory(root, "s", {
          source: "product",
          kind: "not_on_whitelist",
        } as unknown as ProductSseEvent),
      /whitelist/,
    );
  });
});
