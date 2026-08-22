import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertAgentPartition, assertReadable, assertReadableEntry, assertWritable, resolveToolPath, writeGuardFromPlan, writePartitionAllows, writePartitionsOverlap } from "../extensions/wiki/lib/path-policy.js";
import { candidateTools } from "../extensions/wiki/lib/pi/tools.js";
import { candidatePartitionRevision } from "../extensions/wiki/lib/revisions.js";
import { isSafeWikiPagePath, wikiPathKind } from "../extensions/wiki/lib/path.js";

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
  const realSourceRoot = path.resolve("/tmp/okf-wiki-linked-source");
  const guard = writeGuardFromPlan({
    ...plan(workspaceRoot),
    sources: [{
      scopeId: "backend",
      logicalPath: "backend",
      absolutePath: sourceRoot,
      realPath: realSourceRoot,
      repositoryRoot: realSourceRoot,
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
    /unpublished Candidate|ledgers|evidence view/,
  );
  assert.throws(
    () => assertWritable(guard, path.join(workspaceRoot, ".okf-wiki", "state.json")),
    /unpublished Candidate|ledgers|evidence view/,
  );

  assert.equal(resolveToolPath(guard, "wiki"), publishedWikiRoot);
  assert.throws(() => assertWritable(guard, "wiki"), /unpublished Candidate|evidence view/);
  assert.throws(() => assertWritable(guard, publishedWikiRoot), /unpublished Candidate|evidence view/);
});

test("read access is limited to pinned Sources, the Candidate, and current handoffs", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-read-policy-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const sourceRoot = path.join(workspaceRoot, "backend");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "run", "candidate");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "main.ts"), "export {};\n");
  await writeFile(path.join(workspaceRoot, ".env"), "SECRET=value\n");
  const guard = writeGuardFromPlan({
    ...plan(workspaceRoot),
    sources: [{
      scopeId: "backend",
      logicalPath: "backend",
      absolutePath: sourceRoot,
      realPath: sourceRoot,
      repositoryRoot: sourceRoot,
      repositoryIdentity: "backend",
      origin: { type: "link" as const, localPath: sourceRoot },
      head: "head",
      dirtyFingerprint: "clean",
    }],
  }, candidateRoot);

  assert.equal(assertReadable(guard, "backend/main.ts"), path.join(sourceRoot, "main.ts"));
  assert.throws(() => assertReadable(guard, ".env"), /outside the current Run evidence view/);
  assert.throws(() => assertReadable(guard, ".okf-wiki/run/run.json"), /outside the current Run evidence view/);

  const outside = path.join(workspaceRoot, "outside.txt");
  await writeFile(outside, "private\n");
  await symlink(outside, path.join(sourceRoot, "escape.txt"));
  await assert.rejects(() => assertReadableEntry(guard, "backend/escape.txt"), /resolves outside/);

  const tools = candidateTools(guard);
  const grep = tools.find((tool) => tool.name === "grep")!;
  const missingRoot = await grep.execute("grep-default", { pattern: "private" }, new AbortController().signal, undefined, undefined);
  assert.equal(missingRoot.isError, true);
  assert.match(missingRoot.content[0].text, /requires an explicit path/);

  const find = tools.find((tool) => tool.name === "find")!;
  const escaped = await find.execute("find-escape", { pattern: "escape.txt", path: "backend" }, new AbortController().signal, undefined, undefined);
  assert.doesNotMatch(escaped.content.map((part) => part.text ?? "").join("\n"), /escape\.txt/);
});

test("implicit Sources never expose runtime state, published pages, or dotenv secrets", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-implicit-read-policy-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "run", "candidate");
  await mkdir(candidateRoot, { recursive: true });
  const guard = writeGuardFromPlan({
    ...plan(workspaceRoot),
    defaultSourceIgnores: false,
    sources: [{
      scopeId: "self",
      logicalPath: ".",
      absolutePath: workspaceRoot,
      realPath: workspaceRoot,
      repositoryRoot: workspaceRoot,
      repositoryIdentity: "self",
      origin: { type: "link" as const, localPath: workspaceRoot },
      head: "head",
      dirtyFingerprint: "clean",
    }],
  }, candidateRoot);

  assert.throws(() => assertReadable(guard, ".env"), /ignore rules/);
  assert.throws(() => assertReadable(guard, "services/api/.env.production"), /ignore rules/);
  assert.throws(() => assertReadable(guard, ".okf-wiki/run/run.json"), /ignore rules/);
  assert.throws(() => assertReadable(guard, "wiki"), /ignore rules/);
  assert.equal(assertReadable(guard, ".env.example"), path.join(workspaceRoot, ".env.example"));
});

test("write partitions lock Candidate prefixes", () => {
  assert.equal(writePartitionAllows("wiki-root", "overview.md"), true);
  assert.equal(writePartitionAllows("wiki-root", "billing/domain.md"), false);
  assert.equal(writePartitionAllows("billing", "billing/domain.md"), true);
  assert.equal(writePartitionAllows("billing", "checkout/domain.md"), false);
  assert.equal(writePartitionAllows("api", "api/architecture.md"), true);
  assert.equal(writePartitionAllows("api", "api/billing/invoice/concept.md"), true);
  assert.equal(writePartitionsOverlap("billing", "billing/invoice"), true);
  assert.equal(writePartitionsOverlap("billing", "checkout"), false);
  assert.equal(writePartitionsOverlap("wiki-root", "billing"), false);

  const workspaceRoot = path.resolve("/tmp/okf-wiki-path-policy");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate");
  const guard = { ...writeGuardFromPlan(plan(workspaceRoot), candidateRoot), writePartition: "billing" };
  assert.equal(assertWritable(guard, "wiki/billing/domain.md"), path.join(candidateRoot, "billing", "domain.md"));
  assert.throws(() => assertWritable(guard, "wiki/overview.md"), /partition billing/);
});

test("writePartitionAllows matches candidatePartitionRevision prefixes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-partition-rev-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "billing"), { recursive: true });
  await writeFile(path.join(root, "overview.md"), "root\n");
  await writeFile(path.join(root, "billing", "domain.md"), "billing\n");
  const cases = [
    ["wiki-root", ["overview.md"]],
    ["billing", ["billing/domain.md"]],
    ["candidate", ["billing/domain.md", "overview.md"]],
  ];
  for (const [partition, expected] of cases) {
    for (const relative of ["overview.md", "billing/domain.md"]) {
      const allowed = writePartitionAllows(partition, relative);
      assert.equal(allowed, expected.includes(relative), `${partition} ${relative}`);
    }
    const revision = await candidatePartitionRevision(root, partition);
    assert.deepEqual(revision.files, expected);
  }
});

test("assertWritable rejects reserved and illegal Wiki page paths", () => {
  const workspaceRoot = path.resolve("/tmp/okf-wiki-path-policy");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate");
  const guard = writeGuardFromPlan(plan(workspaceRoot), candidateRoot);
  assert.throws(() => assertWritable(guard, "wiki/index.md"), /Illegal Wiki page path/);
  assert.throws(() => assertWritable(guard, "wiki/Foo.md"), /Illegal Wiki page path/);
});

test("assertAgentPartition binds survey to pinned Sources", () => {
  const pinned = {
    ...plan("/tmp/okf-wiki-path-policy"),
    sources: [{
      scopeId: "api",
      logicalPath: "api",
      absolutePath: "/tmp/api",
      realPath: "/tmp/api",
      repositoryRoot: "/tmp/api",
      repositoryIdentity: "id",
      origin: { type: "link", localPath: "/tmp/api" },
      head: "abc",
      dirtyFingerprint: "dirty",
    }],
  };
  assertAgentPartition("survey", "api", pinned);
  assert.throws(() => assertAgentPartition("survey", "web", pinned), /pinned Source id/);
  assert.throws(() => assertAgentPartition("synthesize", "api", pinned), /workspace-analysis/);
  assertAgentPartition("write", "api", pinned);
  assertAgentPartition("write", "wiki-root", pinned);
  assert.throws(() => assertAgentPartition("write", "billing", pinned), /Repository Section/);
});

test("explicit repository paths use the Source id directly", () => {
  const repositories = new Set(["my.repo_ui"]);
  assert.equal(isSafeWikiPagePath("my.repo_ui/architecture.md"), true);
  assert.equal(isSafeWikiPagePath("my.repo_ui/billing/invoice/concept.md"), true);
  assert.equal(wikiPathKind("my.repo_ui/architecture.md", repositories), "repo");
  assert.equal(wikiPathKind("my.repo_ui/billing/domain.md", repositories), "domain");
  assert.equal(wikiPathKind("my.repo_ui/billing/invoice/concept.md", repositories), "concept");
  assert.equal(isSafeWikiPagePath("repos/api/architecture.md"), false);
  assert.equal(wikiPathKind("repos/api/architecture.md", new Set(["api"])), undefined);
});
