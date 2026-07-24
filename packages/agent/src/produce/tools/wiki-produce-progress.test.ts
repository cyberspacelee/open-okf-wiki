/**
 * ProduceToolDetails mapper + createProduceProgressBridge (WP3).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProduceProgress } from "../events.js";
import {
  aggregateProduceDetails,
  createProduceProgressBridge,
  OKF_PRODUCE_PROGRESS_CUSTOM_TYPE,
  progressToDetails,
} from "./wiki-produce-progress.js";

describe("progressToDetails", () => {
  it("maps ProduceProgress fields into stable ProduceToolDetails", () => {
    const p: ProduceProgress = {
      role: "leaf",
      status: "running",
      unitId: "leaf-1",
      task: "research auth",
      parentId: "domain-auth",
      tools: [
        {
          toolCallId: "t1",
          toolName: "read",
          state: "output-available",
          output: "ok",
        },
      ],
      message: { text: "reading sources", thinking: "hmm" },
      summary: undefined,
    };
    const d = progressToDetails(p);
    assert.equal(d.role, "leaf");
    assert.equal(d.status, "running");
    assert.equal(d.unitId, "leaf-1");
    assert.equal(d.task, "research auth");
    assert.equal(d.parentId, "domain-auth");
    assert.equal(d.tools?.[0]?.toolName, "read");
    assert.equal(d.message?.text, "reading sources");
    assert.equal(d.children, undefined);
    assert.equal("summary" in d, false);
  });

  it("includes terminal fields on settle/fail", () => {
    const settled = progressToDetails({
      role: "planner",
      status: "settled",
      unitId: "planner",
      summary: "planned 3 pages",
      receiptPath: "analysis/receipts/planner.json",
    });
    assert.equal(settled.summary, "planned 3 pages");
    assert.equal(settled.receiptPath, "analysis/receipts/planner.json");

    const failed = progressToDetails({
      role: "domain",
      status: "failed",
      unitId: "domain-x",
      error: "boom",
    });
    assert.equal(failed.error, "boom");
    assert.equal(failed.status, "failed");
  });
});

describe("aggregateProduceDetails", () => {
  it("nests leaves under domain under synthetic root", () => {
    const units = new Map([
      [
        "domain-auth",
        {
          details: progressToDetails({
            role: "domain",
            status: "running",
            unitId: "domain-auth",
            task: "Auth",
            parentId: "root",
          }),
          parentId: "root",
        },
      ],
      [
        "leaf-auth-1",
        {
          details: progressToDetails({
            role: "leaf",
            status: "settled",
            unitId: "leaf-auth-1",
            task: "How does login work?",
            parentId: "domain-auth",
            summary: "done",
          }),
          parentId: "domain-auth",
        },
      ],
      [
        "planner",
        {
          details: progressToDetails({
            role: "planner",
            status: "settled",
            unitId: "planner",
            parentId: "root",
            summary: "plan ready",
          }),
          parentId: "root",
        },
      ],
    ]);

    const tree = aggregateProduceDetails(units);
    assert.equal(tree.unitId, "root");
    assert.equal(tree.role, "root");
    assert.equal(tree.status, "running");
    assert.ok(tree.children);
    assert.equal(tree.children!.length, 2);

    const domain = tree.children!.find((c) => c.unitId === "domain-auth");
    assert.ok(domain);
    assert.equal(domain!.parentId, undefined, "nested nodes drop parentId");
    assert.ok(domain!.children);
    assert.equal(domain!.children![0]!.unitId, "leaf-auth-1");
    assert.equal(domain!.children![0]!.summary, "done");

    const planner = tree.children!.find((c) => c.unitId === "planner");
    assert.ok(planner);
    assert.equal(planner!.status, "settled");
  });

  it("marks root settled when all children settled", () => {
    const units = new Map([
      [
        "planner",
        {
          details: progressToDetails({
            role: "planner",
            status: "settled",
            unitId: "planner",
            parentId: "root",
          }),
          parentId: "root",
        },
      ],
    ]);
    const tree = aggregateProduceDetails(units);
    assert.equal(tree.status, "settled");
  });
});

describe("createProduceProgressBridge", () => {
  it("onProgress folds units and fires onDetails with unit patches", () => {
    const patches: ReturnType<typeof progressToDetails>[] = [];
    const bridge = createProduceProgressBridge({
      onDetails: (d) => patches.push(d),
    });

    bridge.onProgress({
      role: "planner",
      status: "running",
      unitId: "planner",
      parentId: "root",
      task: "plan",
    });
    bridge.onProgress({
      role: "leaf",
      status: "running",
      unitId: "leaf-1",
      parentId: "domain-1",
      message: { text: "hi" },
    });
    bridge.onProgress({
      role: "domain",
      status: "running",
      unitId: "domain-1",
      parentId: "root",
    });

    assert.equal(patches.length, 3);
    assert.equal(patches[0]!.unitId, "planner");
    assert.equal(patches[1]!.message?.text, "hi");

    const tree = bridge.getDetails();
    assert.equal(tree.unitId, "root");
    const domain = tree.children?.find((c) => c.unitId === "domain-1");
    assert.ok(domain?.children?.some((c) => c.unitId === "leaf-1"));

    assert.equal(bridge.getUnitDetails("planner")?.task, "plan");
  });

  it("appends okf.produce_progress custom entries for mid-run throttle + settle/fail", () => {
    const custom: Array<{ type: string; data: unknown }> = [];
    const bridge = createProduceProgressBridge({
      customEntryThrottleMs: 0, // allow running write immediately
      sessionManager: {
        appendCustomEntry(customType, data) {
          custom.push({ type: customType, data });
          return `e-${custom.length}`;
        },
      },
    });

    bridge.onProgress({
      role: "leaf",
      status: "running",
      unitId: "leaf-1",
      parentId: "domain-1",
    });
    // Throttled tree snapshot for mid-run cold load (not work_unit).
    assert.ok(custom.length >= 1);
    assert.equal(custom[0]!.type, OKF_PRODUCE_PROGRESS_CUSTOM_TYPE);

    bridge.onProgress({
      role: "leaf",
      status: "settled",
      unitId: "leaf-1",
      parentId: "domain-1",
      summary: "done",
      receiptPath: "analysis/receipts/leaf-1.json",
    });
    assert.ok(custom.length >= 2);
    const settled = custom.find(
      (c) =>
        (c.data as { unitId?: string; status?: string }).unitId === "leaf-1" &&
        (c.data as { status?: string }).status === "settled",
    );
    assert.ok(settled);
    assert.equal(settled!.type, OKF_PRODUCE_PROGRESS_CUSTOM_TYPE);
    assert.notEqual(settled!.type, "work_unit");
    assert.equal((settled!.data as { summary?: string }).summary, "done");

    bridge.onProgress({
      role: "domain",
      status: "failed",
      unitId: "domain-1",
      error: "nope",
    });
    const failed = custom.find(
      (c) => (c.data as { unitId?: string; error?: string }).error === "nope",
    );
    assert.ok(failed);
    assert.equal(failed!.type, OKF_PRODUCE_PROGRESS_CUSTOM_TYPE);
  });

  it("never uses work_unit custom type name", () => {
    assert.equal(OKF_PRODUCE_PROGRESS_CUSTOM_TYPE, "okf.produce_progress");
    assert.notEqual(OKF_PRODUCE_PROGRESS_CUSTOM_TYPE, "work_unit");
    assert.notEqual(OKF_PRODUCE_PROGRESS_CUSTOM_TYPE, "okf.work_unit");
  });

  it("swallows onDetails and sessionManager errors", () => {
    const bridge = createProduceProgressBridge({
      onDetails: () => {
        throw new Error("subscriber boom");
      },
      sessionManager: {
        appendCustomEntry() {
          throw new Error("session boom");
        },
      },
    });
    assert.doesNotThrow(() => {
      bridge.onProgress({
        role: "planner",
        status: "settled",
        unitId: "planner",
        summary: "ok",
      });
    });
  });

  it("last-write wins for same unitId", () => {
    const bridge = createProduceProgressBridge();
    bridge.onProgress({
      role: "leaf",
      status: "running",
      unitId: "leaf-1",
      message: { text: "a" },
    });
    bridge.onProgress({
      role: "leaf",
      status: "running",
      unitId: "leaf-1",
      message: { text: "b" },
    });
    assert.equal(bridge.getUnitDetails("leaf-1")?.message?.text, "b");
  });
});
