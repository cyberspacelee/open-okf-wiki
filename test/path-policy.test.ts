import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertReadable, assertWritable, resolveToolPath, writeGuardFromPlan, writePartitionAllows, writePartitionsOverlap } from "../extensions/wiki/lib/path-policy.js";

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

test("default ignores reject Java tests and keep production sources readable", () => {
  const workspaceRoot = path.resolve("/tmp/okf-wiki-path-policy");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate");
  const sourceRoot = path.join(workspaceRoot, "backend");
  const guard = writeGuardFromPlan({
    ...plan(workspaceRoot),
    sources: [{
      scopeId: "backend",
      logicalPath: "backend",
      absolutePath: sourceRoot,
      realPath: sourceRoot,
      repositoryRoot: sourceRoot,
      repositoryIdentity: "id",
      origin: { type: "link", localPath: sourceRoot },
      head: "abc",
      dirtyFingerprint: "dirty",
    }],
  }, candidateRoot);

  assert.throws(
    () => assertReadable(guard, "backend/src/test/java/com/acme/OrderServiceTest.java"),
    /ignore rules/,
  );
  assert.throws(
    () => assertReadable(guard, "backend/module-a/src/test/java/FooTest.java"),
    /ignore rules/,
  );
  assert.equal(
    assertReadable(guard, "backend/src/main/java/com/acme/OrderService.java"),
    path.join(sourceRoot, "src/main/java/com/acme/OrderService.java"),
  );
  assert.equal(assertWritable(guard, "wiki/overview.md"), path.join(candidateRoot, "overview.md"));
});

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

test("write partitions lock Candidate prefixes", () => {
  assert.equal(writePartitionAllows("wiki-root", "overview.md"), true);
  assert.equal(writePartitionAllows("wiki-root", "billing/domain.md"), false);
  assert.equal(writePartitionAllows("billing", "billing/domain.md"), true);
  assert.equal(writePartitionAllows("billing", "checkout/domain.md"), false);
  assert.equal(writePartitionAllows("repos/api", "repos/api/architecture.md"), true);
  assert.equal(writePartitionsOverlap("billing", "billing/invoice"), true);
  assert.equal(writePartitionsOverlap("billing", "checkout"), false);
  assert.equal(writePartitionsOverlap("wiki-root", "billing"), false);

  const workspaceRoot = path.resolve("/tmp/okf-wiki-path-policy");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate");
  const guard = { ...writeGuardFromPlan(plan(workspaceRoot), candidateRoot), writePartition: "billing" };
  assert.equal(assertWritable(guard, "wiki/billing/domain.md"), path.join(candidateRoot, "billing", "domain.md"));
  assert.throws(() => assertWritable(guard, "wiki/overview.md"), /partition billing/);
});
