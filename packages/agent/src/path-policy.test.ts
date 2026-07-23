import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertContainedPathSafe, resolveContainedPath, toPosixRelative } from "@okf-wiki/core";
import { listDirContained, readFileContained, writeFileContained } from "./fs-ops.js";
import { redactErrorMessage } from "./run-redact.js";

const root = path.resolve("/tmp/okf-wiki-path-policy-root");

test("resolveContainedPath allows nested relative paths", () => {
  const resolved = resolveContainedPath(root, "docs/readme.md");
  assert.equal(resolved, path.join(root, "docs", "readme.md"));
});

test("resolveContainedPath allows empty path as root", () => {
  assert.equal(resolveContainedPath(root, ""), root);
  assert.equal(resolveContainedPath(root, "."), root);
});

test("resolveContainedPath rejects parent traversal", () => {
  assert.throws(() => resolveContainedPath(root, "../etc/passwd"), /escapes root|\.\./);
  assert.throws(() => resolveContainedPath(root, "foo/../../etc/passwd"), /escapes root|\.\./);
  assert.throws(() => resolveContainedPath(root, ".."), /escapes root|\.\./);
});

test("resolveContainedPath rejects absolute paths", () => {
  assert.throws(() => resolveContainedPath(root, "/etc/passwd"), /absolute/);
});

test("toPosixRelative returns POSIX segments", () => {
  const abs = path.join(root, "a", "b.md");
  assert.equal(toPosixRelative(root, abs), "a/b.md");
});

test("assertContainedPathSafe / fs-ops reject symlink escape; normal file works", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "okf-wiki-symlink-"));
  try {
    await writeFile(path.join(tempRoot, "safe.md"), "hello\n", "utf8");

    // Symlink pointing outside the root (e.g. toward /tmp or sibling).
    const outside = await mkdtemp(path.join(tmpdir(), "okf-wiki-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
      await symlink(outside, path.join(tempRoot, "escape-link"));

      await assert.rejects(() => readFileContained(tempRoot, "escape-link/secret.txt"), /symlink/i);
      await assert.rejects(
        () => writeFileContained(tempRoot, "escape-link/pwned.md", "# no\n"),
        /symlink/i,
      );
      await assert.rejects(() => listDirContained(tempRoot, "escape-link"), /symlink/i);
      await assert.rejects(
        () => assertContainedPathSafe(tempRoot, path.join(tempRoot, "escape-link", "secret.txt")),
        /symlink/i,
      );

      // Normal file still works.
      const read = await readFileContained(tempRoot, "safe.md");
      assert.equal(read.content, "hello\n");
      await writeFileContained(tempRoot, "nested/ok.md", "# ok\n");
      const nested = await readFileContained(tempRoot, "nested/ok.md");
      assert.match(nested.content, /^# ok/);
      const listing = await listDirContained(tempRoot, "");
      assert.ok(listing.some((e) => e.name === "safe.md"));
      // Symlink entry itself must not be exposed as a browsable path.
      assert.ok(!listing.some((e) => e.name === "escape-link"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("assertContainedPathSafe rejects intermediate symlink components", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "okf-wiki-midlink-"));
  try {
    const realDir = path.join(tempRoot, "real");
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, "file.md"), "x\n", "utf8");
    await symlink(realDir, path.join(tempRoot, "via-link"));

    await assert.rejects(() => readFileContained(tempRoot, "via-link/file.md"), /symlink/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("redactErrorMessage redacts sk- keys including hyphens", () => {
  const msg = redactErrorMessage(
    new Error("auth failed sk-proj-abc-def-ghi-jkl and Bearer secret-token-xyz"),
  );
  assert.equal(msg.includes("sk-proj"), false);
  assert.match(msg, /\[redacted-key\]/);
  assert.match(msg, /Bearer \[redacted\]/);
});

test("redactErrorMessage never returns [object Object]", () => {
  assert.doesNotMatch(redactErrorMessage({ message: "timeout" }), /\[object Object\]/);
  assert.match(redactErrorMessage({ message: "timeout" }), /timeout/);
  assert.doesNotMatch(redactErrorMessage({ nested: true }), /\[object Object\]/);
});
