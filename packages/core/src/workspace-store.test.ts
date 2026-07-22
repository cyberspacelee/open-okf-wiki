import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertAbsolutePath, resolveExistingDir } from "./paths.js";
import {
  addSource,
  createWorkspace,
  listRecentWorkspaces,
  listWorkspaces,
  loadWorkspace,
  registerWorkspaceInAppIndex,
  saveWorkspace,
  updateSource,
  workspaceConfigPath,
} from "./workspace-store.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function initGitRepo(root: string): Promise<void> {
  const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# test\n");
  const add = spawnSync("git", ["add", "README.md"], { cwd: root, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync("git", ["commit", "-m", "init"], { cwd: root, encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
}

test("resolveExistingDir rejects empty paths", async () => {
  await assert.rejects(() => resolveExistingDir(""), /non-empty/);
  await assert.rejects(() => resolveExistingDir("   "), /non-empty/);
});

test("resolveExistingDir rejects missing and non-directory paths", async () => {
  const root = await tempDir("okf-wiki-path-");
  await assert.rejects(
    () => resolveExistingDir(path.join(root, "missing")),
    /does not exist/,
  );

  const filePath = path.join(root, "file.txt");
  await writeFile(filePath, "x\n");
  await assert.rejects(() => resolveExistingDir(filePath), /not a directory/);
});

test("resolveExistingDir returns absolute existing directory", async () => {
  const root = await tempDir("okf-wiki-path-ok-");
  const resolved = await resolveExistingDir(root);
  assert.equal(resolved, path.resolve(root));
});

test("create/load/save workspace roundtrip", async () => {
  const root = await tempDir("okf-wiki-ws-");
  const sourceRoot = await tempDir("okf-wiki-src-");
  await initGitRepo(sourceRoot);

  let config = await createWorkspace({
    name: "Demo Workspace",
    rootPath: root,
    modelId: "openai/corp-model",
  });

  assert.equal(config.name, "Demo Workspace");
  assert.equal(config.rootPath, path.resolve(root));
  assert.equal(config.publicationPath, path.join(path.resolve(root), "wiki"));
  assert.equal(config.version, 1);
  assert.equal(config.model.id, "openai/corp-model");
  assert.equal(config.sources.length, 0);
  assert.ok(config.id.length > 0);
  assert.ok(config.createdAt);

  const added = await addSource(config, { id: "application", path: sourceRoot });
  config = added.config;
  assert.equal(added.probe.isGit, true);
  assert.equal(added.probe.dirty, false);
  assert.equal(config.sources.length, 1);
  assert.equal(config.sources[0]?.id, "application");
  assert.equal(config.sources[0]?.path, path.resolve(sourceRoot));

  await saveWorkspace(config);

  const onDisk = await readFile(workspaceConfigPath(root), "utf8");
  assert.match(onDisk, /"version": 1/);
  assert.doesNotMatch(onDisk, /api[_-]?key/i);

  const loaded = await loadWorkspace(root);
  assert.equal(loaded.id, config.id);
  assert.equal(loaded.name, config.name);
  assert.equal(loaded.rootPath, config.rootPath);
  assert.equal(loaded.publicationPath, config.publicationPath);
  assert.equal(loaded.model.id, "openai/corp-model");
  assert.deepEqual(loaded.sources, config.sources);
  assert.equal(loaded.orchestration.maxDomainFanOut, 4);
  assert.deepEqual(loaded.roleModels.reviewers, []);
});

test("saveWorkspace allows empty sources (draft workspace)", async () => {
  const root = await tempDir("okf-wiki-ws-draft-");
  const config = await createWorkspace({ name: "Empty", rootPath: root });
  await saveWorkspace(config);
  const loaded = await loadWorkspace(root);
  assert.equal(loaded.sources.length, 0);
  assert.equal(loaded.name, "Empty");
});

test("loadWorkspace rejects missing and invalid files", async () => {
  const root = await tempDir("okf-wiki-ws-load-");
  await assert.rejects(() => loadWorkspace(root), /workspace config not found/);

  const okfDir = path.join(root, ".okf-wiki");
  await mkdir(okfDir, { recursive: true });
  await writeFile(path.join(okfDir, "workspace.json"), "{not-json", "utf8");
  await assert.rejects(() => loadWorkspace(root), /invalid workspace JSON/);

  await writeFile(
    path.join(okfDir, "workspace.json"),
    JSON.stringify({ version: 1, name: "nope" }),
    "utf8",
  );
  await assert.rejects(() => loadWorkspace(root), /invalid workspace config/);
});

test("addSource fails for non-git and dirty when requireClean", async () => {
  const root = await tempDir("okf-wiki-ws-src-");
  const plain = await tempDir("okf-wiki-nogit-");
  const dirtyRepo = await tempDir("okf-wiki-dirty-");
  await initGitRepo(dirtyRepo);
  await writeFile(path.join(dirtyRepo, "dirty.txt"), "x\n");

  const config = await createWorkspace({ name: "Src", rootPath: root });

  await assert.rejects(
    () => addSource(config, { id: "application", path: plain }),
    /not a git|working tree/i,
  );

  await assert.rejects(
    () => addSource(config, { id: "application", path: dirtyRepo }),
    /dirty/i,
  );

  const allowed = await addSource(
    config,
    { id: "application", path: dirtyRepo },
    { requireClean: false },
  );
  assert.equal(allowed.probe.dirty, true);
  assert.equal(allowed.config.sources.length, 1);
});

test("addSource rejects duplicate source ids", async () => {
  const root = await tempDir("okf-wiki-ws-dup-");
  const sourceRoot = await tempDir("okf-wiki-src-dup-");
  await initGitRepo(sourceRoot);

  const config = await createWorkspace({ name: "Dup", rootPath: root });
  const first = await addSource(config, { id: "application", path: sourceRoot });
  await assert.rejects(
    () => addSource(first.config, { id: "application", path: sourceRoot }),
    /already exists/,
  );
});

test("registerWorkspaceInAppIndex and listRecentWorkspaces", async () => {
  const home = await tempDir("okf-wiki-app-");
  const appStatePath = path.join(home, "app.json");
  const a = path.join(home, "ws-a");
  const b = path.join(home, "ws-b");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });

  await registerWorkspaceInAppIndex(a, appStatePath);
  await registerWorkspaceInAppIndex(b, appStatePath);
  // Re-register a — should move to front and dedupe
  await registerWorkspaceInAppIndex(a, appStatePath);

  const recent = await listRecentWorkspaces(appStatePath);
  assert.deepEqual(recent, [path.resolve(a), path.resolve(b)]);

  const listed = await listWorkspaces(appStatePath);
  assert.deepEqual(listed, recent);

  const emptyHome = await tempDir("okf-wiki-app-empty-");
  const emptyList = await listRecentWorkspaces(path.join(emptyHome, "missing-app.json"));
  assert.deepEqual(emptyList, []);
});

test("createWorkspace rejects existing workspace.json", async () => {
  const root = await tempDir("okf-wiki-ws-exists-");
  const first = await createWorkspace({ name: "One", rootPath: root });
  await saveWorkspace(first);
  await assert.rejects(
    () => createWorkspace({ name: "Two", rootPath: root }),
    /already exists/,
  );
});

test("createWorkspace honors custom publicationPath", async () => {
  const root = await tempDir("okf-wiki-ws-pub-");
  const publicationPath = path.join(root, "custom-wiki");
  const config = await createWorkspace({
    name: "Pub",
    rootPath: root,
    publicationPath,
  });
  assert.equal(config.publicationPath, path.resolve(publicationPath));
  await resolveExistingDir(publicationPath);
});

test("assertAbsolutePath rejects relative and empty paths", () => {
  assert.throws(() => assertAbsolutePath("", "rootPath"), /non-empty/);
  assert.throws(() => assertAbsolutePath("   ", "rootPath"), /non-empty/);
  assert.throws(() => assertAbsolutePath("relative/path", "rootPath"), /absolute/);
  assert.throws(() => assertAbsolutePath("./here", "rootPath"), /absolute/);
  const abs = path.resolve("/tmp/okf-abs-test");
  assert.equal(assertAbsolutePath(abs, "rootPath"), abs);
  assert.equal(assertAbsolutePath(`  ${abs}  `, "rootPath"), abs);
});

test("createWorkspace rejects relative rootPath", async () => {
  await assert.rejects(
    () => createWorkspace({ name: "Rel", rootPath: "relative/ws" }),
    /absolute/,
  );
  await assert.rejects(
    () => createWorkspace({ name: "Rel", rootPath: "./relative-ws" }),
    /absolute/,
  );
});

test("createWorkspace rejects relative publicationPath", async () => {
  const root = await tempDir("okf-wiki-ws-rel-pub-");
  await assert.rejects(
    () =>
      createWorkspace({
        name: "RelPub",
        rootPath: root,
        publicationPath: "relative/wiki",
      }),
    /absolute/,
  );
});

test("createWorkspace treats only ENOENT as missing config", async () => {
  // Happy path: no workspace.json yet → ENOENT from access → create succeeds.
  const root = await tempDir("okf-wiki-ws-enoent-");
  const config = await createWorkspace({ name: "Enoent", rootPath: root });
  assert.equal(config.name, "Enoent");
  assert.equal(config.rootPath, path.resolve(root));
  // After save, access finds the file and createWorkspace must reject.
  await saveWorkspace(config);
  await assert.rejects(
    () => createWorkspace({ name: "Again", rootPath: root }),
    /already exists/,
  );
});

test("updateSource updates ignore policy", async () => {
  const root = await tempDir("okf-wiki-update-src-");
  const sourceRoot = await tempDir("okf-wiki-src-");
  await initGitRepo(sourceRoot);

  let ws = await createWorkspace({ name: "UpdateSrc", rootPath: root });
  const added = await addSource(
    ws,
    { id: "app", path: sourceRoot },
    { requireClean: false },
  );
  ws = added.config;
  assert.equal(ws.sources[0]!.applyDefaultIgnores, true);
  assert.deepEqual(ws.sources[0]!.ignore, []);

  ws = updateSource(ws, "app", {
    applyDefaultIgnores: false,
    ignore: ["src/test/**", "**/*Test.java"],
  });
  assert.equal(ws.sources[0]!.applyDefaultIgnores, false);
  assert.deepEqual(ws.sources[0]!.ignore, ["src/test/**", "**/*Test.java"]);
});

test("addSource rejects relative path", async () => {
  const root = await tempDir("okf-wiki-ws-rel-src-");
  const config = await createWorkspace({ name: "RelSrc", rootPath: root });
  await assert.rejects(
    () => addSource(config, { id: "application", path: "relative/repo" }),
    /absolute/,
  );
});
