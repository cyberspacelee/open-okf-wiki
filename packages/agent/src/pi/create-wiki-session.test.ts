import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  createWikiSession,
  resolveWikiSessionTools,
} from "./create-wiki-session.js";
import {
  assertSafeWikiToolList,
  toolNamesForRole,
} from "./tool-policy.js";
import { piRunWorkDir, piSessionsDir } from "./session-paths.js";

const temps: string[] = [];

after(async () => {
  for (const t of temps) {
    await rm(t, { recursive: true, force: true });
  }
});

describe("create-wiki-session tool list safety", () => {
  it("resolveWikiSessionTools never includes bash", () => {
    for (const role of [
      "plan",
      "root_research",
      "root_write",
      "domain",
      "leaf",
      "reviewer",
      "operator_chat",
    ] as const) {
      const tools = resolveWikiSessionTools(role);
      assert.deepEqual([...tools], [...toolNamesForRole(role)]);
      assertSafeWikiToolList(tools);
      assert.ok(!tools.includes("bash" as never));
    }
  });

  it("root_write allowlist is read+write Pi tools only", () => {
    const tools = resolveWikiSessionTools("root_write");
    assert.deepEqual([...tools], [
      "read",
      "grep",
      "find",
      "ls",
      "write",
      "edit",
    ]);
  });

  it("createWikiSession offline returns safe tools and dispose works", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-sess-"));
    temps.push(tmp);
    const runWorkDir = path.join(tmp, "run");

    const handle = await createWikiSession({
      role: "root_research",
      runWorkDir,
      systemPrompt: "test offline session",
    });

    try {
      assert.equal(handle.role, "root_research");
      assert.deepEqual([...handle.tools], ["read", "grep", "find", "ls"]);
      assertSafeWikiToolList(handle.tools);
      assert.ok(!handle.tools.includes("bash" as never));
      assert.ok(handle.session);
      assert.equal(handle.runWorkDir, path.resolve(runWorkDir));
      assert.equal(handle.scopedTools, true);
    } finally {
      handle.dispose();
    }
  });

  it("createWikiSession root_write tools include write/edit not bash", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-sess-w-"));
    temps.push(tmp);

    const handle = await createWikiSession({
      role: "root_write",
      runWorkDir: path.join(tmp, "run"),
    });

    try {
      assert.deepEqual([...handle.tools], [
        "read",
        "grep",
        "find",
        "ls",
        "write",
        "edit",
      ]);
      assert.ok(!handle.tools.includes("bash" as never));
    } finally {
      handle.dispose();
    }
  });
});

describe("session-paths", () => {
  it("piSessionsDir and piRunWorkDir under .okf-wiki", () => {
    const root = "/workspace/repo";
    assert.equal(
      piSessionsDir(root),
      path.join(root, ".okf-wiki", "pi-sessions"),
    );
    assert.equal(
      piRunWorkDir(root, "run-1"),
      path.join(root, ".okf-wiki", "runs", "run-1"),
    );
  });
});
