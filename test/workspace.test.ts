import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWikiWorkspaceManagement,
  loadWikiWorkspace,
  sourceIsIgnored,
  wikiWorkspaceManagement,
} from "../extensions/wiki/lib/workspace.js";

const temporaryDirectories = [];

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function repository(parent, name) {
  const root = path.join(parent, name);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "wiki@example.test");
  git(root, "config", "user.name", "Wiki Test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "Initial source");
  return root;
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

test("loads a Git repository without workspace.yaml as an implicit self source", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-implicit-"));
  temporaryDirectories.push(parent);
  const root = await repository(parent, "self");
  const loaded = await loadWikiWorkspace(path.join(root, "src"));

  assert.equal(loaded.root, root);
  assert.equal(loaded.sources.length, 1);
  assert.equal(loaded.sources[0].path, ".");
  assert.equal(loaded.sources[0].realPath, root);
  assert.deepEqual(loaded.wiki, { exclude: [] });
  assert.equal(sourceIsIgnored(loaded.sources[0], ".okf-wiki/runs/a/run.json", true), true);
  assert.equal(sourceIsIgnored(loaded.sources[0], "wiki/overview.md", true), true);
  assert.equal(sourceIsIgnored(loaded.sources[0], "src/index.ts", true), false);
  await assert.rejects(lstat(path.join(root, "workspace.yaml")), { code: "ENOENT" });
});

test("initializes explicit workspace defaults and normalized Wiki excludes", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-init-"));
  temporaryDirectories.push(parent);
  const workspace = await wikiWorkspaceManagement.init({
    cwd: parent,
    workspace: "docs",
    wikiExclude: ["generated/**", " generated/** ", "private/**"],
  });
  assert.equal(workspace.root, path.join(parent, "docs"));
  assert.equal(workspace.language, "zh");
  assert.equal(workspace.defaultSourceIgnores, true);
  assert.deepEqual(workspace.wiki, { exclude: ["generated/**", "private/**"] });
  assert.deepEqual(workspace.sources, []);
  assert.match(await readFile(workspace.configPath, "utf8"), /language: zh/);
  await assert.rejects(wikiWorkspaceManagement.init({ cwd: parent, workspace: "docs" }), /already exists/);
});

test("loads an optional Postgres Catalog and keeps the raw URL", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-database-"));
  temporaryDirectories.push(parent);
  const root = await repository(parent, "configured");
  const previous = process.env.WIKI_TEST_PG;
  process.env.WIKI_TEST_PG = "postgresql://wiki:secret@localhost:5432/app";
  try {
    await writeFile(path.join(root, "workspace.yaml"), [
      "version: 1",
      "language: zh",
      "defaultSourceIgnores: true",
      "wiki:",
      "  exclude: []",
      "database:",
      "  url: ${WIKI_TEST_PG}",
      "  schema: billing",
      "  tables: [user*, payment]",
      "sources: []",
      "",
    ].join("\n"));
    const loaded = await loadWikiWorkspace(root);
    assert.deepEqual(loaded.database, {
      url: "${WIKI_TEST_PG}",
      schema: "billing",
      tables: ["user*", "payment"],
    });
  } finally {
    if (previous === undefined) delete process.env.WIKI_TEST_PG;
    else process.env.WIKI_TEST_PG = previous;
  }

  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1", "language: zh", "defaultSourceIgnores: true", "wiki:",
    "  exclude: []", "database:", "  url: mysql://localhost/app", "sources: []", "",
  ].join("\n"));
  await assert.rejects(loadWikiWorkspace(root), /postgresql:\/\//);
});

test("wiki config only accepts exclude", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-runtime-config-"));
  temporaryDirectories.push(parent);
  const root = await repository(parent, "configured");
  const configPath = path.join(root, "workspace.yaml");
  const validConfig = [
    "version: 1",
    "language: zh",
    "defaultSourceIgnores: true",
    "wiki:",
    "  exclude: [generated/**]",
    "sources: []",
    "",
  ].join("\n");
  await writeFile(configPath, validConfig);
  const loaded = await loadWikiWorkspace(root);
  assert.deepEqual(loaded.wiki, { exclude: ["generated/**"] });

  await writeFile(configPath, validConfig.replace("  exclude: [generated/**]", "  exclude: []\n  maxDelegateBatches: 12"));
  await assert.rejects(loadWikiWorkspace(root), /unknown field/);
  await writeFile(configPath, validConfig.replace("  exclude: [generated/**]", "  unexpected: true"));
  await assert.rejects(loadWikiWorkspace(root), /unknown field/);
});

test("version errors identify the exact workspace config and require numeric version 1", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-version-"));
  temporaryDirectories.push(parent);
  const root = await repository(parent, "configured");
  const configPath = path.join(root, "workspace.yaml");
  const config = (version) => [
    `version: ${version}`,
    "language: zh",
    "defaultSourceIgnores: true",
    "wiki:",
    "  exclude: []",
    "sources: []",
    "",
  ].join("\n");

  await writeFile(configPath, config("2"));
  await assert.rejects(
    loadWikiWorkspace(path.join(root, "src")),
    new RegExp(`Invalid workspace\\.yaml at ${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: expected numeric version 1, received 2 \\(number\\)`),
  );

  await writeFile(configPath, config("'1'"));
  await assert.rejects(loadWikiWorkspace(root), /expected numeric version 1, received "1" \(string\)/);
});

test("rejects leftover generation and role-model wiki fields", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-generation-profile-"));
  temporaryDirectories.push(parent);
  const root = await repository(parent, "configured");
  const configPath = path.join(root, "workspace.yaml");
  await writeFile(configPath, [
    "version: 1", "language: en", "defaultSourceIgnores: true", "wiki:",
    "  exclude: []", "  generation:", "    purpose: leftover", "sources: []", "",
  ].join("\n"));
  await assert.rejects(loadWikiWorkspace(root), /unknown field/);
});

test("concurrent init never deletes the winning workspace", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-init-race-"));
  temporaryDirectories.push(parent);
  const results = await Promise.allSettled([
    wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace", language: "zh" }),
    wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace", language: "en" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const loaded = await loadWikiWorkspace(path.join(parent, "workspace"));
  assert.ok(loaded.language === "zh" || loaded.language === "en");
  assert.equal((await lstat(loaded.configPath)).isFile(), true);
});

test("adds a POSIX directory link with canonical origin and rejects Git subdirectories", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-link-"));
  temporaryDirectories.push(parent);
  const source = await repository(parent, "source-repo");
  await wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace", language: "en", defaultSourceIgnores: false });
  const workspace = await wikiWorkspaceManagement.addLink({ cwd: parent, workspace: "workspace", localPath: source });
  assert.equal(workspace.language, "en");
  assert.equal(workspace.defaultSourceIgnores, false);
  assert.equal(workspace.sources[0].path, "source-repo");
  assert.deepEqual(workspace.sources[0].origin, { type: "link", localPath: await import("node:fs/promises").then(({ realpath }) => realpath(source)) });
  assert.equal(await readlink(path.join(workspace.root, "source-repo")), source);
  await assert.rejects(
    wikiWorkspaceManagement.addLink({ cwd: parent, workspace: "workspace", localPath: path.join(source, "src"), name: "nested" }),
    /repository root/,
  );
  await assert.rejects(
    wikiWorkspaceManagement.addLink({ cwd: parent, workspace: "workspace", localPath: source }),
    /already exists/,
  );
});

test("uses a junction on Windows through the filesystem seam", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-junction-"));
  temporaryDirectories.push(parent);
  const source = await repository(parent, "source");
  const links = [];
  const management = createWikiWorkspaceManagement({
    platform: "win32",
    async createDirectoryLink(target, location, type) {
      links.push({ target, location, type });
      await symlink(target, location, "dir");
    },
  });
  await management.init({ cwd: parent, workspace: "workspace" });
  await management.addLink({ cwd: parent, workspace: "workspace", localPath: source, name: "windows-source" });
  assert.equal(links[0].type, "junction");
});

test("clones a source at an optional ref and persists clone origin", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-clone-"));
  temporaryDirectories.push(parent);
  const remote = await repository(parent, "remote.git");
  git(remote, "checkout", "-q", "-b", "docs-ref");
  await writeFile(path.join(remote, "src", "ref.ts"), "export const ref = true;\n");
  git(remote, "add", ".");
  git(remote, "commit", "--quiet", "-m", "Ref commit");
  const expected = git(remote, "rev-parse", "HEAD");
  await wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace" });
  const workspace = await wikiWorkspaceManagement.addClone({
    cwd: parent,
    workspace: "workspace",
    remoteUrl: remote,
    ref: "docs-ref",
    name: "cloned",
  });
  assert.deepEqual(workspace.sources[0].origin, { type: "clone", remoteUrl: remote, ref: "docs-ref" });
  assert.equal(git(path.join(workspace.root, "cloned"), "rev-parse", "HEAD"), expected);
});

test("rejects unsafe and conflicting source names without leaving workspace entries", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-invalid-"));
  temporaryDirectories.push(parent);
  const source = await repository(parent, "source");
  await wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace" });
  await mkdir(path.join(parent, "workspace", "occupied"));
  for (const name of ["wiki", "../escape", "bad/name"]) {
    await assert.rejects(
      wikiWorkspaceManagement.addLink({ cwd: parent, workspace: "workspace", localPath: source, name }),
      /reserved|Invalid/,
    );
  }
  await assert.rejects(
    wikiWorkspaceManagement.addLink({ cwd: parent, workspace: "workspace", localPath: source, name: "occupied" }),
    /path already exists/,
  );
  assert.deepEqual((await loadWikiWorkspace(path.join(parent, "workspace"))).sources, []);
});

test("rolls back a created link and clone when config replacement fails", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-rollback-"));
  temporaryDirectories.push(parent);
  const source = await repository(parent, "source");
  await wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace" });
  let linkCreated = false;
  const failedConfig = createWikiWorkspaceManagement({
    async createDirectoryLink(target, location, type) {
      linkCreated = true;
      await symlink(target, location, type);
    },
    async writeConfig() { throw new Error("config commit failed"); },
  });
  await assert.rejects(
    failedConfig.addLink({ cwd: parent, workspace: "workspace", localPath: source, name: "linked" }),
    /config commit failed/,
  );
  assert.equal(linkCreated, true);
  await assert.rejects(lstat(path.join(parent, "workspace", "linked")), { code: "ENOENT" });

  const management = createWikiWorkspaceManagement({
    async runGit(cwd, args) {
      if (args[0] === "clone") return { code: 1, stdout: "", stderr: "clone failed" };
      throw new Error(`unexpected git call in ${cwd}`);
    },
  });
  await assert.rejects(
    management.addClone({ cwd: parent, workspace: "workspace", remoteUrl: source, name: "cloned" }),
    /clone failed/,
  );
  assert.equal((await lstat(path.join(parent, "workspace"))).isDirectory(), true);
  await assert.rejects(lstat(path.join(parent, "workspace", "cloned")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(parent, "workspace", ".okf-wiki-workspace.lock")), { code: "ENOENT" });
});

test("serializes concurrent source commits without losing config or leaving orphan directories", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-concurrent-"));
  temporaryDirectories.push(parent);
  const first = await repository(parent, "first");
  const second = await repository(parent, "second");
  await wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace" });
  await Promise.all([
    wikiWorkspaceManagement.addLink({ cwd: parent, workspace: "workspace", localPath: first }),
    wikiWorkspaceManagement.addLink({ cwd: parent, workspace: "workspace", localPath: second }),
  ]);
  const workspace = await loadWikiWorkspace(path.join(parent, "workspace"));
  assert.deepEqual(workspace.sources.map((source) => source.path).sort(), ["first", "second"]);
  assert.equal((await lstat(path.join(workspace.root, "first"))).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(workspace.root, "second"))).isSymbolicLink(), true);
  await assert.rejects(lstat(path.join(workspace.root, ".okf-wiki-workspace.lock")), { code: "ENOENT" });
});

test("rejects linking a repository that contains the workspace", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-ancestor-"));
  temporaryDirectories.push(parent);
  const repositoryRoot = await repository(parent, "monorepo");
  const workspacePath = path.join(repositoryRoot, "docs");
  await wikiWorkspaceManagement.init({ cwd: repositoryRoot, workspace: "docs" });
  await assert.rejects(
    wikiWorkspaceManagement.addLink({ cwd: workspacePath, localPath: repositoryRoot, name: "root" }),
    /itself or its ancestor/,
  );
  assert.deepEqual((await loadWikiWorkspace(workspacePath)).sources, []);
  await assert.rejects(lstat(path.join(workspacePath, "root")), { code: "ENOENT" });
});

test("Windows source names reserve Wiki directories case-insensitively", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-reserved-"));
  temporaryDirectories.push(parent);
  const source = await repository(parent, "source");
  const management = createWikiWorkspaceManagement({ platform: "win32" });
  await management.init({ cwd: parent, workspace: "workspace" });
  for (const name of ["Wiki", "WIKI", ".OKF-WIKI", "CON", "prn.txt", "AUX", "NUL", "COM1", "com9.log", "LPT1", "lpt9.txt", "trailing.", "trailing "]) {
    await assert.rejects(
      management.addLink({ cwd: parent, workspace: "workspace", localPath: source, name }),
      /reserved/,
    );
  }
});

test("rejects adding the same physical Git repository under another name", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-duplicate-"));
  temporaryDirectories.push(parent);
  const source = await repository(parent, "source");
  await wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace" });
  await wikiWorkspaceManagement.addLink({ cwd: parent, workspace: "workspace", localPath: source, name: "first" });
  await assert.rejects(
    wikiWorkspaceManagement.addLink({ cwd: parent, workspace: "workspace", localPath: source, name: "second" }),
    /already added/,
  );
  assert.deepEqual((await loadWikiWorkspace(path.join(parent, "workspace"))).sources.map((value) => value.path), ["first"]);
  await assert.rejects(lstat(path.join(parent, "workspace", "second")), { code: "ENOENT" });
});
