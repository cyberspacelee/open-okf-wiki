import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { exists } from "../extensions/wiki/lib/files.js";
import { installWikiPublication, recoverWikiPublication } from "../extensions/wiki/lib/publication.js";

async function workspace(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-publication-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, ".okf-wiki", "run", "candidate");
  await mkdir(candidate, { recursive: true });
  return { root, candidate };
}

test("full publication removes pages that exist only in the previous Wiki", async (t) => {
  const { root, candidate } = await workspace(t);
  await mkdir(path.join(root, "wiki"));
  await writeFile(path.join(root, "wiki", "old.md"), "old\n");
  await writeFile(path.join(candidate, "new.md"), "new\n");

  await installWikiPublication(root, candidate);

  assert.equal(await readFile(path.join(root, "wiki", "new.md"), "utf8"), "new\n");
  assert.equal(await exists(path.join(root, "wiki", "old.md")), false);
  assert.equal(await exists(path.join(root, ".okf-wiki", "publication")), false);
});

test("recovery completes an install interrupted after moving the previous Wiki", async (t) => {
  const { root, candidate } = await workspace(t);
  await mkdir(path.join(root, "wiki"));
  await writeFile(path.join(root, "wiki", "old.md"), "old\n");
  await writeFile(path.join(candidate, "new.md"), "new\n");
  await assert.rejects(() => installWikiPublication(root, candidate, {
    fault(phase) { if (phase === "previous_moved") throw new Error("crash"); },
  }), /crash/);

  await recoverWikiPublication(root);

  assert.equal(await readFile(path.join(root, "wiki", "new.md"), "utf8"), "new\n");
  assert.equal(await exists(path.join(root, ".okf-wiki", "publication")), false);
});

test("recovery accepts an installed Candidate interrupted before commit cleanup", async (t) => {
  const { root, candidate } = await workspace(t);
  await mkdir(path.join(root, "wiki"));
  await writeFile(path.join(root, "wiki", "old.md"), "old\n");
  await writeFile(path.join(candidate, "new.md"), "new\n");
  await assert.rejects(() => installWikiPublication(root, candidate, {
    fault(phase) { if (phase === "candidate_installed") throw new Error("crash"); },
  }), /crash/);

  await recoverWikiPublication(root);

  assert.equal(await readFile(path.join(root, "wiki", "new.md"), "utf8"), "new\n");
  assert.equal(await exists(path.join(root, ".okf-wiki", "publication")), false);
});
