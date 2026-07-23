import assert from "node:assert/strict";
import { mkdir, mkdtemp, readlink, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { materializeRunWorkdir, runWorkdirPromptPaths } from "./run-workdir.js";

describe("run-workdir", () => {
  it("materialises sources, skill, wiki, analysis", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-rwd-"));
    const srcA = path.join(tmp, "repo-a");
    const skill = path.join(tmp, "skill-root");
    await mkdir(srcA, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(srcA, "README.md"), "# A\n", "utf8");
    await writeFile(path.join(skill, "SKILL.md"), "# skill\n", "utf8");

    const runWorkDir = path.join(tmp, "run");
    const layout = await materializeRunWorkdir({
      runWorkDir,
      sources: new Map([["main", srcA]]),
      skillRoot: skill,
      reset: true,
    });

    assert.equal(layout.runWorkDir, path.resolve(runWorkDir));
    const linked = await realpath(layout.sourceMounts.get("main")!);
    assert.equal(linked, await realpath(srcA));
    // skill is a junction/symlink
    await readlink(layout.skillDir).catch(() => null);
    const prompt = runWorkdirPromptPaths(layout);
    assert.match(prompt, /sources\/main\//);
    assert.match(prompt, /wiki\//);
  });
});
