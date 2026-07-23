import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skillDigest } from "./skill-digest.js";
import {
  createSkillFork,
  getSkillInfo,
  listSkillDir,
  normalizeSkillRelative,
  readSkillFile,
  skillForkDir,
  writeSkillFile,
} from "./skill-fork.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function makeSourceSkill(): Promise<string> {
  const root = await tempDir("okf-source-skill-");
  await writeFile(
    path.join(root, "SKILL.md"),
    "---\nname: repository-wiki-producer\ndescription: test skill\n---\n# Skill\n",
  );
  await mkdir(path.join(root, "templates"), { recursive: true });
  await writeFile(path.join(root, "templates", "overview.md"), "# Overview\n");
  return root;
}

test("createSkillFork copies source skill and getSkillInfo reports fork", async () => {
  const workspace = await tempDir("okf-ws-");
  const source = await makeSourceSkill();
  const forkPath = await createSkillFork({
    workspaceRoot: workspace,
    sourceSkillPath: source,
  });
  assert.equal(forkPath, skillForkDir(workspace));
  assert.ok(forkPath.includes(path.join(".agents", "skills")));
  const info = await getSkillInfo({ path: forkPath, kind: "fork" });
  assert.equal(info.kind, "fork");
  assert.equal(info.path, forkPath);
  assert.equal(info.name, "repository-wiki-producer");
  assert.equal(await skillDigest(forkPath), info.digest);
});

test("getSkillInfo reports package kind", async () => {
  const source = await makeSourceSkill();
  const info = await getSkillInfo({ path: source, kind: "package" });
  assert.equal(info.kind, "package");
  assert.equal(info.path, path.resolve(source));
});

test("writeSkillFile and readSkillFile roundtrip under fork", async () => {
  const workspace = await tempDir("okf-ws-write-");
  const source = await makeSourceSkill();
  const forkPath = await createSkillFork({
    workspaceRoot: workspace,
    sourceSkillPath: source,
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
  const source = await makeSourceSkill();
  const forkPath = await createSkillFork({
    workspaceRoot: workspace,
    sourceSkillPath: source,
  });
  await assert.rejects(() => writeSkillFile(forkPath, "../outside.md", "x"), /\.\./);
});
