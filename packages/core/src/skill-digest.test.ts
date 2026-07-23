import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listSkillFiles, skillDigest } from "./skill-digest.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("skillDigest is stable for identical trees", async () => {
  const a = await tempDir("okf-skill-a-");
  const b = await tempDir("okf-skill-b-");
  for (const root of [a, b]) {
    await writeFile(path.join(root, "SKILL.md"), "---\nname: demo\n---\n# Demo\n");
    await mkdir(path.join(root, "references"), { recursive: true });
    await writeFile(path.join(root, "references", "generate.md"), "# gen\n");
  }
  const da = await skillDigest(a);
  const db = await skillDigest(b);
  assert.equal(da, db);
  assert.match(da, /^[a-f0-9]{64}$/);
});

test("skillDigest changes when content changes", async () => {
  const root = await tempDir("okf-skill-chg-");
  await writeFile(path.join(root, "SKILL.md"), "# v1\n");
  const d1 = await skillDigest(root);
  await writeFile(path.join(root, "SKILL.md"), "# v2\n");
  const d2 = await skillDigest(root);
  assert.notEqual(d1, d2);
});

test("skillDigest rejects missing SKILL.md", async () => {
  const root = await tempDir("okf-skill-miss-");
  await assert.rejects(() => skillDigest(root), /missing SKILL.md/);
});

test("listSkillFiles returns sorted relative paths", async () => {
  const root = await tempDir("okf-skill-list-");
  await writeFile(path.join(root, "SKILL.md"), "# x\n");
  await mkdir(path.join(root, "templates"), { recursive: true });
  await writeFile(path.join(root, "templates", "overview.md"), "# o\n");
  const files = await listSkillFiles(root);
  assert.deepEqual(files, ["SKILL.md", "templates/overview.md"]);
});
