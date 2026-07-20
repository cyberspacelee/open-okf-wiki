import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertContainedPathSafe,
  isPathInside,
  resolveContainedPath,
  toPosixRelative,
} from "./paths.js";

test("isPathInside accepts equal and nested", () => {
  assert.equal(isPathInside("/a/b", "/a/b"), true);
  assert.equal(isPathInside("/a/b", "/a/b/c"), true);
  assert.equal(isPathInside("/a/b", "/a/other"), false);
});

test("resolveContainedPath allows nested relative paths", () => {
  const root = "/tmp/okf-wiki-path-root";
  const resolved = resolveContainedPath(root, "docs/readme.md");
  assert.equal(resolved, path.resolve(root, "docs/readme.md"));
});

test("resolveContainedPath rejects parent traversal", () => {
  const root = "/tmp/okf-wiki-path-root";
  assert.throws(() => resolveContainedPath(root, "../etc/passwd"), /escapes root|\.\./);
  assert.throws(() => resolveContainedPath(root, "foo/../../etc/passwd"), /escapes root|\.\./);
});

test("resolveContainedPath rejects absolute paths", () => {
  const root = "/tmp/okf-wiki-path-root";
  assert.throws(() => resolveContainedPath(root, "/etc/passwd"), /absolute/);
});

test("toPosixRelative normalizes separators", () => {
  const root = "/tmp/okf-wiki-path-root";
  assert.equal(toPosixRelative(root, path.join(root, "a", "b.md")), "a/b.md");
});

test("assertContainedPathSafe rejects intermediate symlink", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "okf-path-"));
  try {
    const target = path.join(dir, "outside");
    await mkdir(target);
    await writeFile(path.join(target, "secret.txt"), "x");
    const root = path.join(dir, "root");
    await mkdir(root);
    await symlink(target, path.join(root, "link"));
    await assert.rejects(
      () => assertContainedPathSafe(root, path.join(root, "link", "secret.txt")),
      /symlink/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
