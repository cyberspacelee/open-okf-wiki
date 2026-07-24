import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { runWorkdirLayout } from "../pi/run-workdir.js";
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

  it("ignores fixture env in production; honors it in test/dev", () => {
    assert.equal(
      shouldUsePiFixtureMode({}, { OKF_WIKI_AGENT_MODE: "fixture", NODE_ENV: "production" }),
      false,
    );
    assert.equal(
      shouldUsePiFixtureMode({}, { OKF_WIKI_AGENT_MODE: "fixture", NODE_ENV: "test" }),
      true,
    );
    assert.equal(
      shouldUsePiFixtureMode({}, { OKF_WIKI_AGENT_MODE: "fixture", NODE_ENV: "development" }),
      true,
    );
    // Explicit injection still works even under production NODE_ENV.
    assert.equal(
      shouldUsePiFixtureMode({ fixture: true }, { NODE_ENV: "production" }),
      true,
    );
  });

  it("writes wiki overview + index without LLM", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-live-pi-"));
    temps.push(tmp);
    const runWorkDir = path.join(tmp, "run");
    const src = path.join(runWorkDir, "sources", "main");
    const skill = path.join(runWorkDir, "skill");
    await mkdir(src, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(src, "README.md"), "# Src\n", "utf8");
    await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");

    const result = await produceWithPi({
      layout: runWorkdirLayout(runWorkDir, new Map([["main", src]])),
      spec: defaultWikiRunSpec("Fixture Wiki"),
      workspaceName: "Fixture Wiki",
      fixture: true,
    });

    assert.equal(result.mode, "fixture");
    assert.deepEqual([...result.pages].sort(), ["index.md", "overview.md"]);
    const body = await readFile(path.join(result.layout.wikiDir, "overview.md"), "utf8");
    assert.match(body, /Fixture Wiki/);
    assert.match(body, /Pi fixture mode/);
    assert.match(body, /repo:README\.md/);
  });
});
