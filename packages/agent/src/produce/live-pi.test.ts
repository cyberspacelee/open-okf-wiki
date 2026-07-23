import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { produceWithPi, shouldUsePiFixtureMode } from "./live-pi.js";

const temps: string[] = [];

after(async () => {
  for (const t of temps) {
    await rm(t, { recursive: true, force: true });
  }
});

describe("produce/live-pi fixture mode", () => {
  it("shouldUsePiFixtureMode is explicit-only (no auto from missing keys)", () => {
    assert.equal(shouldUsePiFixtureMode({ fixture: true }), true);
    assert.equal(
      shouldUsePiFixtureMode({ fixture: false }, { OKF_WIKI_AGENT_MODE: "fixture" }),
      false,
    );
    assert.equal(shouldUsePiFixtureMode({}, { OKF_WIKI_AGENT_MODE: "fixture" }), true);
    assert.equal(
      shouldUsePiFixtureMode({}, { OKF_WIKI_AGENT_MODE: "live", OPENAI_API_KEY: "x" }),
      false,
    );
    // Default is live even with no credentials (caller must fail clearly).
    assert.equal(shouldUsePiFixtureMode({}, {}), false);
    assert.equal(shouldUsePiFixtureMode({}, { OPENAI_API_KEY: "", OPENAI_BASE_URL: "" }), false);
  });

  it("writes wiki overview + index without LLM", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-live-pi-"));
    temps.push(tmp);
    const src = path.join(tmp, "src");
    const skill = path.join(tmp, "skill");
    await mkdir(src, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(src, "README.md"), "# Src\n", "utf8");
    await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");

    const result = await produceWithPi({
      runWorkDir: path.join(tmp, "run"),
      role: "root_write",
      fixture: true,
      title: "Fixture Wiki",
      materialize: {
        sources: new Map([["main", src]]),
        skillRoot: skill,
        reset: true,
      },
    });

    assert.equal(result.mode, "fixture");
    assert.deepEqual([...result.pages].sort(), ["index.md", "overview.md"]);
    const body = await readFile(path.join(result.layout.wikiDir, "overview.md"), "utf8");
    assert.match(body, /Fixture Wiki/);
    assert.match(body, /Pi fixture mode/);
    assert.match(body, /repo:README\.md/);
  });

  it("root_research fixture does not write pages", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-live-pi-r-"));
    temps.push(tmp);
    const result = await produceWithPi({
      runWorkDir: path.join(tmp, "run"),
      role: "root_research",
      fixture: true,
    });
    assert.equal(result.mode, "fixture");
    assert.deepEqual(result.pages, []);
  });
});
