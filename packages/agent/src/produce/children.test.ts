import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  produceRoleForChild,
  runChildSession,
  runChildrenParallel,
} from "./children.js";
import type { ProduceChildPiEvent } from "./events.js";

describe("produce/children", () => {
  it("maps child roles to operator-visible produce roles", () => {
    assert.equal(produceRoleForChild("plan"), "planner");
    assert.equal(produceRoleForChild("leaf"), "leaf");
    assert.equal(produceRoleForChild("domain"), "domain");
    assert.equal(produceRoleForChild("reviewer"), "reviewer");
    assert.equal(produceRoleForChild("root_research"), "root");
  });

  it("fixture child returns summary without LLM", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-child-"));
    const forwarded: ProduceChildPiEvent[] = [];
    const r = await runChildSession({
      role: "domain",
      runWorkDir: dir,
      task: "Investigate auth module",
      fixture: true,
      agentId: "domain-auth",
      onPiEvent: (e) => forwarded.push(e),
    });
    assert.equal(r.mode, "fixture");
    assert.match(r.summary, /domain/);
    assert.match(r.summary, /auth/);
    // Fixture path has no live Pi session — no stream frames.
    assert.equal(forwarded.length, 0);
  });

  it("parallel fan-out respects order", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-childs-"));
    const out = await runChildrenParallel(
      [
        { role: "leaf", runWorkDir: dir, task: "A", fixture: true },
        { role: "leaf", runWorkDir: dir, task: "B", fixture: true },
        { role: "reviewer", runWorkDir: dir, task: "C", fixture: true },
      ],
      { concurrency: 2 },
    );
    assert.equal(out.length, 3);
    assert.match(out[0]!.summary, /A/);
    assert.match(out[1]!.summary, /B/);
    assert.match(out[2]!.summary, /C/);
  });
});
