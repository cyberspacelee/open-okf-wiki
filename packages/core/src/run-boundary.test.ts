import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@okf-wiki/contract";
import { FreezeWikiRunError, freezeWikiRun } from "./run-boundary.js";
import { loadRun } from "./run-store.js";

async function makeGitRepo(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
  await writeFile(path.join(dir, "README.md"), "# src\n", "utf8");
  spawnSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

async function makeWorkspace(opts?: {
  dirty?: boolean;
  noSources?: boolean;
}): Promise<{ root: string; workspace: WorkspaceConfig; skillDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-freeze-"));
  const skillDir = path.join(root, "skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: test-skill\n---\n# skill\n", "utf8");

  let sources: WorkspaceConfig["sources"] = [];
  if (!opts?.noSources) {
    const src = await makeGitRepo(root, "src");
    if (opts?.dirty) {
      await writeFile(path.join(src, "dirty.txt"), "x\n", "utf8");
    }
    sources = [
      {
        id: "main",
        path: src,
        applyDefaultIgnores: true,
        ignore: [],
      },
    ];
  }

  const workspace = WorkspaceConfigSchema.parse({
    version: 1,
    id: "ws1",
    name: "Freeze WS",
    rootPath: root,
    sources,
    skillPath: skillDir,
    model: { id: "openai/test" },
    publicationPath: path.join(root, "wiki-out"),
    limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
    planConfirm: false,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });

  return { root, workspace, skillDir };
}

test("freezeWikiRun creates record with skillDigest and clean sources", async () => {
  const { root, workspace } = await makeWorkspace();
  const frozen = await freezeWikiRun({
    workspace,
    sessionId: "sess-1",
    autoApprove: true,
  });

  assert.ok(frozen.runId);
  assert.equal(frozen.skillPath, path.resolve(workspace.skillPath!));
  assert.ok(frozen.skillDigest && frozen.skillDigest.length > 8);
  assert.equal(frozen.sources.length, 1);
  assert.equal(frozen.sources[0]!.id, "main");
  assert.ok(frozen.sources[0]!.head);
  assert.equal(frozen.sourcePathMap.get("main"), frozen.sources[0]!.path);
  assert.ok(frozen.sourceIgnores.has("main"));

  const record = await loadRun(root, frozen.runId);
  assert.ok(record);
  assert.equal(record!.skillDigest, frozen.skillDigest);
  assert.equal(record!.sessionId, "sess-1");
  assert.equal(record!.autoApprove, true);
  assert.equal(record!.status, "running");
});

test("freezeWikiRun rejects dirty source", async () => {
  const { workspace } = await makeWorkspace({ dirty: true });
  await assert.rejects(
    () => freezeWikiRun({ workspace }),
    (err: unknown) => {
      assert.ok(err instanceof FreezeWikiRunError);
      assert.equal(err.code, "source_dirty");
      return true;
    },
  );
});

test("freezeWikiRun rejects empty sources", async () => {
  const { workspace } = await makeWorkspace({ noSources: true });
  await assert.rejects(
    () => freezeWikiRun({ workspace }),
    (err: unknown) => {
      assert.ok(err instanceof FreezeWikiRunError);
      assert.equal(err.code, "no_sources");
      return true;
    },
  );
});

test("freezeWikiRun registerRunRecord with explicit runId", async () => {
  const { root, workspace } = await makeWorkspace();
  const frozen = await freezeWikiRun({
    workspace,
    runId: "agent-run-1",
    sessionId: "s2",
  });
  assert.equal(frozen.runId, "agent-run-1");
  const record = await loadRun(root, "agent-run-1");
  assert.ok(record);
  assert.equal(record!.sessionId, "s2");
});
