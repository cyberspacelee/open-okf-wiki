import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cloneIntoWorkspace, probeLocalGit } from "./git.js";

test("probeLocalGit reports missing path", async () => {
  const result = await probeLocalGit(path.join(tmpdir(), "okf-wiki-missing-" + Date.now()));
  assert.equal(result.isGit, false);
  assert.match(result.error ?? "", /does not exist/);
});

test("probeLocalGit reads a real local repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-git-"));
  const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# test\n");
  const add = spawnSync("git", ["add", "README.md"], { cwd: root, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync("git", ["commit", "-m", "init"], { cwd: root, encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);

  const clean = await probeLocalGit(root);
  assert.equal(clean.isGit, true);
  assert.equal(clean.dirty, false);
  assert.ok(clean.head && clean.head.length >= 7);

  await writeFile(path.join(root, "dirty.txt"), "x\n");
  const dirty = await probeLocalGit(root);
  assert.equal(dirty.dirty, true);
});

test("cloneIntoWorkspace clones a local remote into sources/<id>", async () => {
  const remote = await mkdtemp(path.join(tmpdir(), "okf-wiki-remote-"));
  spawnSync("git", ["init"], { cwd: remote, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: remote });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: remote });
  await writeFile(path.join(remote, "README.md"), "# remote\n");
  spawnSync("git", ["add", "README.md"], { cwd: remote });
  spawnSync("git", ["commit", "-m", "init"], { cwd: remote });

  const workspace = await mkdtemp(path.join(tmpdir(), "okf-wiki-ws-clone-"));
  const cloned = await cloneIntoWorkspace({
    workspaceRoot: workspace,
    remoteUrl: remote,
    sourceId: "liba",
  });
  assert.ok(cloned.path.includes(`${path.sep}sources${path.sep}liba`));
  assert.equal(cloned.probe.isGit, true);
  assert.equal(cloned.probe.dirty, false);
});

test("cloneIntoWorkspace rejects path escape", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "okf-wiki-ws-esc-"));
  await assert.rejects(
    () =>
      cloneIntoWorkspace({
        workspaceRoot: workspace,
        remoteUrl: "https://example.com/repo.git",
        sourceId: "x",
        relativeDir: "../outside",
      }),
    /inside the workspace/,
  );
});

test("probeLocalGit rejects a non-git directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-nogit-"));
  await mkdir(path.join(root, "sub"), { recursive: true });
  const result = await probeLocalGit(root);
  assert.equal(result.isGit, false);
});
