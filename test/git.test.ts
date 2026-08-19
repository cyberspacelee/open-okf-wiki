import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../extensions/wiki/lib/git.js";

test("git returns complete normal output, including UTF-8", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-git-"));
  const result = await git(root, ["-c", "alias.emit=!printf '你好'", "emit"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "你好");
  assert.equal(result.stderr, "");
});

test("git rejects and terminates when stdout exceeds its byte budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-git-"));
  await assert.rejects(
    () => git(root, ["-c", "alias.noisy=!f() { head -c 1100000 /dev/zero; }; f", "noisy"]),
    /stdout output limit/,
  );
});

test("git rejects and terminates when stderr exceeds its byte budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-git-"));
  await assert.rejects(
    () => git(root, ["-c", "alias.noisy=!f() { head -c 1100000 /dev/zero >&2; }; f", "noisy"]),
    /stderr output limit/,
  );
});
