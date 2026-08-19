import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertWritable, resolveToolPath, writeGuardFromPlan } from "../dist/path-policy.js";

function plan(workspaceRoot) {
  return {
    workspaceRoot,
    workspaceRealPath: workspaceRoot,
    configPath: path.join(workspaceRoot, "workspace.yaml"),
    defaultSourceIgnores: true,
    excludes: [],
    sources: [],
    fingerprint: "test",
  };
}

function outside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative || relative.startsWith("..") || path.isAbsolute(relative);
}

test("wiki/overview.md remaps into the Candidate; .okf-wiki and published wiki writes are rejected", () => {
  const workspaceRoot = path.resolve("/tmp/okf-wiki-path-policy");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate");
  const guard = writeGuardFromPlan(plan(workspaceRoot), candidateRoot);
  const publishedWikiRoot = path.join(workspaceRoot, "wiki");
  const candidateOverview = path.join(candidateRoot, "overview.md");

  assert.ok(outside(publishedWikiRoot, candidateRoot), "published wiki is not the Candidate");

  assert.equal(resolveToolPath(guard, "wiki/overview.md"), candidateOverview);
  assert.equal(assertWritable(guard, "wiki/overview.md"), candidateOverview);
  assert.equal(assertWritable(guard, path.join(publishedWikiRoot, "overview.md")), candidateOverview);
  assert.equal(outside(publishedWikiRoot, candidateOverview), true);

  assert.throws(
    () => assertWritable(guard, ".okf-wiki/runs/abcd/run.json"),
    /unpublished Candidate|ledgers/,
  );
  assert.throws(
    () => assertWritable(guard, path.join(workspaceRoot, ".okf-wiki", "state.json")),
    /unpublished Candidate|ledgers/,
  );

  assert.equal(resolveToolPath(guard, "wiki"), publishedWikiRoot);
  assert.throws(() => assertWritable(guard, "wiki"), /unpublished Candidate/);
  assert.throws(() => assertWritable(guard, publishedWikiRoot), /unpublished Candidate/);
});
