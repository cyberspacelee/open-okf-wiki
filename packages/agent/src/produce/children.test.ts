import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runChildrenParallel, runChildSession } from "./children.js";

describe("produce/children", () => {
  it("fixture child returns summary without LLM", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "okf-child-"));
    const spans: Array<{ id: string; status: string }> = [];
    const r = await runChildSession({
      role: "domain",
      spanId: "domain-auth",
      runWorkDir: dir,
      task: "Investigate auth module",
      fixture: true,
      onProgress: (span) => spans.push({ id: span.id, status: span.status }),
    });
    assert.equal(r.mode, "fixture");
    assert.match(r.summary, /domain/);
    assert.match(r.summary, /auth/);
    assert.ok(spans.some((s) => s.id === "domain-auth" && s.status === "done"));
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
