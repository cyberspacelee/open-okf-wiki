import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createSkillFork,
  getSkillInfo,
  listSkillDir,
  normalizeSkillRelative,
  readSkillFile,
  skillForkDir,
  writeSkillFile,
} from "./skill-fork.js";
import { skillDigest } from "./skill-digest.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function makeBundled(): Promise<string> {
  const root = await tempDir("okf-bundled-");
  await writeFile(
    path.join(root, "SKILL.md"),
    "---\nname: repository-wiki-producer\ndescription: test skill\n---\n# Skill\n",
  );
  await mkdir(path.join(root, "templates"), { recursive: true });
  await writeFile(path.join(root, "templates", "overview.md"), "# Overview\n");
  return root;
}

test("createSkillFork copies bundled skill and getSkillInfo reports fork", async () => {
  const workspace = await tempDir("okf-ws-");
  const bundled = await makeBundled();
  const forkPath = await createSkillFork({
    workspaceRoot: workspace,
    bundledSkillPath: bundled,
  });
  assert.equal(forkPath, skillForkDir(workspace));
  const info = await getSkillInfo({
    workspaceRoot: workspace,
    skillPath: forkPath,
    bundledSkillPath: bundled,
  });
  assert.equal(info.kind, "fork");
  assert.equal(info.path, forkPath);
  assert.equal(info.name, "repository-wiki-producer");
  assert.equal(await skillDigest(forkPath), info.digest);
});

test("writeSkillFile and readSkillFile roundtrip under fork", async () => {
  const workspace = await tempDir("okf-ws-write-");
  const bundled = await makeBundled();
  const forkPath = await createSkillFork({
    workspaceRoot: workspace,
    bundledSkillPath: bundled,
  });
  await writeSkillFile(forkPath, "templates/overview.md", "# Custom\n");
  const file = await readSkillFile(forkPath, "templates/overview.md");
  assert.equal(file.content, "# Custom\n");
  const entries = await listSkillDir(forkPath, "templates");
  assert.ok(entries.some((e) => e.path === "templates/overview.md"));
});

test("normalizeSkillRelative rejects escapes", () => {
  assert.equal(normalizeSkillRelative("templates/a.md"), "templates/a.md");
  assert.throws(() => normalizeSkillRelative("../x"), /\.\./);
  assert.throws(() => normalizeSkillRelative("/abs"), /relative/);
});

test("writeSkillFile refuses path escape", async () => {
  const workspace = await tempDir("okf-ws-esc-");
  const bundled = await makeBundled();
  const forkPath = await createSkillFork({
    workspaceRoot: workspace,
    bundledSkillPath: bundled,
  });
  await assert.rejects(
    () => writeSkillFile(forkPath, "../outside.md", "x"),
    /\.\./,
  );
});
