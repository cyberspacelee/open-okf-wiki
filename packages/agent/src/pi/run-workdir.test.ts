import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { runWorkdirLayout, runWorkdirPromptPaths } from "./run-workdir.js";

describe("run-workdir", () => {
  it("projects only run-owned frozen source mounts", () => {
    const runWorkDir = path.resolve("/workspace/.okf-wiki/runs/run-1");
    const layout = runWorkdirLayout(
      runWorkDir,
      new Map([["main", path.join(runWorkDir, "sources", "main")]]),
    );

    assert.equal(layout.runWorkDir, path.resolve(runWorkDir));
    assert.equal(layout.skillDir, path.join(runWorkDir, "skill"));
    const prompt = runWorkdirPromptPaths(layout);
    assert.match(prompt, /sources\/main\//);
    assert.match(prompt, /wiki\//);
    assert.throws(
      () => runWorkdirLayout(runWorkDir, new Map([["main", "/tmp/live-checkout"]])),
      /not mounted in the frozen Run workdir/,
    );
  });
});
