import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertAgentPartition, assertReadable, assertReadableEntry, assertReadableNativeEntry, assertWritable, guardForWorker, resolveToolPath, writeGuardFromPlan, writeTargetAllows, writeTargetsOverlap } from "../extensions/wiki/lib/path-policy.js";
import { candidateTools } from "../extensions/wiki/lib/pi/tools.js";
import { candidateTargetRevision } from "../extensions/wiki/lib/revisions.js";
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
  assert.equal(outside(publishedWikiRoot, candidateOverview), true);

  assert.throws(
    () => assertWritable(guard, ".okf-wiki/runs/abcd/run.json"),
    /unpublished Candidate|ledgers|evidence view/,
  );
  assert.throws(
    () => assertWritable(guard, path.join(workspaceRoot, ".okf-wiki", "state.json")),
    /Workspace-relative path/,
  );

  assert.equal(resolveToolPath(guard, "wiki"), candidateRoot);
  assert.throws(() => assertWritable(guard, "wiki"), /unpublished Candidate|evidence view/);
  assert.throws(() => assertWritable(guard, publishedWikiRoot), /Workspace-relative path/);
});

test("model-facing paths are canonical Workspace-relative paths", () => {
  const workspaceRoot = path.resolve("/tmp/okf-wiki-path-policy");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "run", "candidate");
  const guard = writeGuardFromPlan(plan(workspaceRoot), candidateRoot);

  assert.equal(resolveToolPath(guard, "wiki"), candidateRoot);
  assert.throws(() => assertReadable(guard, "/backend/main.ts"), /Workspace-relative path/);
  assert.throws(() => assertReadable(guard, path.join(workspaceRoot, "backend", "main.ts")), /Workspace-relative path/);
  assert.throws(() => assertReadable(guard, String.raw`C:\workspace\backend\main.ts`), /Workspace-relative path/);
  assert.throws(() => assertReadable(guard, String.raw`\\server\share\backend\main.ts`), /Workspace-relative path/);
  assert.throws(() => assertReadable(guard, "backend\\main.ts"), /Workspace-relative path/);
  assert.throws(() => assertReadable(guard, "backend/../main.ts"), /Workspace-relative path/);
  assert.throws(() => assertReadable(guard, ".okf-wiki/run/candidate/overview.md"), /wiki\/\.\.\. path/);
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
  await assert.rejects(
    () => assertReadableNativeEntry(guard, path.join(workspaceRoot, "missing-outside-view.txt")),
    /outside the current Run evidence view/,
  );

  const outside = path.join(workspaceRoot, "outside.txt");
  await writeFile(outside, "private\n");
  await symlink(outside, path.join(sourceRoot, "escape.txt"));
  await assert.rejects(() => assertReadableEntry(guard, "backend/escape.txt"), /resolves outside/);

  const tools = candidateTools(guard);
  const read = tools.find((tool) => tool.name === "read")!;
  const readParams = { path: "backend/main.ts" };
  const readResult = await read.execute("read-relative", readParams, new AbortController().signal, undefined, undefined);
  assert.equal(readResult.isError, undefined);
  assert.deepEqual(readParams, { path: "backend/main.ts" });

  const grep = tools.find((tool) => tool.name === "grep")!;
  const missingRoot = await grep.execute("grep-default", { pattern: "private" }, new AbortController().signal, undefined, undefined);
  assert.equal(missingRoot.isError, true);
  assert.match(missingRoot.content[0].text, /requires an explicit path/);

  const find = tools.find((tool) => tool.name === "find")!;
  const escaped = await find.execute("find-escape", { pattern: "escape.txt", path: "backend" }, new AbortController().signal, undefined, undefined);
  assert.doesNotMatch(escaped.content.map((part) => part.text ?? "").join("\n"), /escape\.txt/);
});

test("grep, find, and ls return paths relative to the Workspace root", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-tool-paths-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const sourceRoot = path.join(workspaceRoot, "backend");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "run", "candidate");
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "[bracket].ts"), "export {};\n");
  await writeFile(path.join(sourceRoot, "src", "main.ts"), "export const workspacePathMarker = true;\n");
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
  const tools = candidateTools(guard);
  const signal = new AbortController().signal;

  for (const tool of tools) {
    assert.match(tool.description, /POSIX Workspace-relative/);
    assert.doesNotMatch(tool.description, /relative to the search directory|relative or absolute/);
  }

  const grep = tools.find((tool) => tool.name === "grep")!;
  const grepResult = await grep.execute("grep", { pattern: "workspacePathMarker", path: "backend" }, signal, undefined, undefined);
  assert.match(grepResult.content[0].text, /^backend\/src\/main\.ts:1:/m);

  const find = tools.find((tool) => tool.name === "find")!;
  const findResult = await find.execute("find", { pattern: "main.ts", path: "backend" }, signal, undefined, undefined);
  assert.match(findResult.content[0].text, /^backend\/src\/main\.ts$/m);

  const ls = tools.find((tool) => tool.name === "ls")!;
  const lsResult = await ls.execute("ls", { path: "backend/src" }, signal, undefined, undefined);
  assert.match(lsResult.content[0].text, /^backend\/src\/\[bracket\]\.ts$/m);
  assert.match(lsResult.content[0].text, /^backend\/src\/main\.ts$/m);
  const lsRootResult = await ls.execute("ls-root", { path: "backend" }, signal, undefined, undefined);
  assert.match(lsRootResult.content[0].text, /^backend\/src$/m);

  const read = tools.find((tool) => tool.name === "read")!;
  const missing = await read.execute("read-missing", { path: "backend/missing.ts" }, signal, undefined, undefined);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /read failed for backend\/missing\.ts/);
  assert.doesNotMatch(missing.content[0].text, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const writerGuard = { ...guard, writeTarget: { path: "wiki-root", mode: "directory" as const } };
  const write = candidateTools(writerGuard).find((tool) => tool.name === "write")!;
  const written = await write.execute("write", { path: "wiki/overview.md", content: "# Overview\n" }, signal, undefined, undefined);
  assert.equal(written.isError, undefined);
  assert.match(written.content[0].text, /wiki\/overview\.md/);
  assert.doesNotMatch(written.content[0].text, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a linked Source is read through its Workspace-relative junction path", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-linked-workspace-"));
  const realSourceRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-linked-source-"));
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(realSourceRoot, { recursive: true, force: true });
  });
  const logicalSourceRoot = path.join(workspaceRoot, "backend");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "run", "candidate");
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(path.join(realSourceRoot, "main.ts"), "export const linked = true;\n");
  await symlink(realSourceRoot, logicalSourceRoot, process.platform === "win32" ? "junction" : "dir");
  const guard = writeGuardFromPlan({
    ...plan(workspaceRoot),
    sources: [{
      scopeId: "backend",
      logicalPath: "backend",
      absolutePath: logicalSourceRoot,
      realPath: realSourceRoot,
      repositoryRoot: realSourceRoot,
      repositoryIdentity: "backend",
      origin: { type: "link" as const, localPath: realSourceRoot },
      head: "head",
      dirtyFingerprint: "clean",
    }],
  }, candidateRoot);

  assert.equal(await assertReadableEntry(guard, "backend/main.ts"), path.join(logicalSourceRoot, "main.ts"));
  const read = candidateTools(guard).find((tool) => tool.name === "read")!;
  const result = await read.execute("read-linked", { path: "backend/main.ts" }, new AbortController().signal, undefined, undefined);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /linked = true/);
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
  assert.equal(assertReadable(guard, "wiki"), candidateRoot);
  assert.equal(assertReadable(guard, ".env.example"), path.join(workspaceRoot, ".env.example"));
});

test("write targets separate Domain subtrees from aggregation directories", () => {
  assert.equal(writeTargetAllows({ path: "wiki-root", mode: "directory" }, "overview.md"), true);
  assert.equal(writeTargetAllows({ path: "wiki-root", mode: "directory" }, "billing/domain.md"), false);
  assert.equal(writeTargetAllows({ path: "billing", mode: "subtree" }, "billing/domain.md"), true);
  assert.equal(writeTargetAllows({ path: "billing", mode: "subtree" }, "checkout/domain.md"), false);
  assert.equal(writeTargetAllows({ path: "api", mode: "directory" }, "api/architecture.md"), true);
  assert.equal(writeTargetAllows({ path: "api", mode: "directory" }, "api/billing/invoice/concept.md"), false);
  assert.equal(writeTargetsOverlap({ path: "api", mode: "directory" }, { path: "api/billing", mode: "subtree" }), false);
  assert.equal(writeTargetsOverlap({ path: "billing", mode: "subtree" }, { path: "billing/invoice", mode: "subtree" }), true);
  assert.equal(writeTargetsOverlap({ path: "billing", mode: "subtree" }, { path: "checkout", mode: "subtree" }), false);
  assert.equal(writeTargetsOverlap({ path: "wiki-root", mode: "directory" }, { path: "billing", mode: "subtree" }), false);

  const workspaceRoot = path.resolve("/tmp/okf-wiki-path-policy");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate");
  const guard = { ...writeGuardFromPlan(plan(workspaceRoot), candidateRoot), writeTarget: { path: "billing", mode: "subtree" } };
  assert.equal(assertWritable(guard, "wiki/billing/domain.md"), path.join(candidateRoot, "billing", "domain.md"));
  assert.throws(() => assertWritable(guard, "wiki/overview.md"), /target subtree:billing/);
});

test("writeTargetAllows matches candidateTargetRevision targets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-partition-rev-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "billing"), { recursive: true });
  await writeFile(path.join(root, "overview.md"), "root\n");
  await writeFile(path.join(root, "billing", "domain.md"), "billing\n");
  const cases = [
    [{ path: "wiki-root", mode: "directory" }, ["overview.md"]],
    [{ path: "billing", mode: "subtree" }, ["billing/domain.md"]],
  ];
  for (const [target, expected] of cases) {
    for (const relative of ["overview.md", "billing/domain.md"]) {
      const allowed = writeTargetAllows(target, relative);
      assert.equal(allowed, expected.includes(relative), `${target.mode}:${target.path} ${relative}`);
    }
    const revision = await candidateTargetRevision(root, target);
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
  assertAgentPartition("write", "api", pinned, "directory");
  assertAgentPartition("write", "api/billing", pinned, "subtree");
  assertAgentPartition("write", "wiki-root", pinned, "directory");
  assert.throws(() => assertAgentPartition("write", "api", pinned, "subtree"), /Repository directory or Domain subtree/);
});

test("worker guards share one cwd but expose only stage evidence", () => {
  const workspaceRoot = path.resolve("/tmp/okf-wiki-worker-guards");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "run", "candidate");
  const pinned = {
    ...plan(workspaceRoot),
    sources: ["api", "web"].map((scopeId) => ({
      scopeId,
      logicalPath: scopeId,
      absolutePath: path.join(workspaceRoot, scopeId),
      realPath: path.join(workspaceRoot, scopeId),
      repositoryRoot: path.join(workspaceRoot, scopeId),
      repositoryIdentity: scopeId,
      origin: { type: "link" as const, localPath: path.join(workspaceRoot, scopeId) },
      head: "head",
      dirtyFingerprint: "clean",
    })),
  };
  const base = writeGuardFromPlan(pinned, candidateRoot);
  const handoff = ".okf-wiki/run/handoffs/survey-api.md";

  const survey = guardForWorker(base, "survey", "api", []);
  assert.equal(assertReadable(survey, "api/main.ts"), path.join(workspaceRoot, "api", "main.ts"));
  assert.throws(() => assertReadable(survey, "web/main.ts"), /evidence view/);
  assert.throws(() => assertReadable(survey, "wiki/overview.md"), /evidence view/);
  assert.throws(() => assertReadable(survey, handoff), /evidence view/);

  const synthesize = guardForWorker(base, "synthesize", "workspace-analysis", [handoff]);
  assert.equal(assertReadable(synthesize, "api/main.ts"), path.join(workspaceRoot, "api", "main.ts"));
  assert.equal(assertReadable(synthesize, "web/main.ts"), path.join(workspaceRoot, "web", "main.ts"));
  assert.equal(assertReadable(synthesize, handoff), path.join(workspaceRoot, ...handoff.split("/")));
  assert.throws(() => assertReadable(synthesize, ".okf-wiki/run/handoffs/unlisted.md"), /evidence view/);
  assert.throws(() => assertReadable(synthesize, "wiki/overview.md"), /evidence view/);

  const writer = guardForWorker(base, "write", "api/billing", [handoff]);
  assert.equal(assertReadable(writer, "api/main.ts"), path.join(workspaceRoot, "api", "main.ts"));
  assert.equal(assertReadable(writer, "wiki/overview.md"), path.join(candidateRoot, "overview.md"));
  assert.throws(() => assertReadable(writer, "web/main.ts"), /evidence view/);

  const review = guardForWorker(base, "review", "candidate", [handoff]);
  assert.equal(assertReadable(review, "api/main.ts"), path.join(workspaceRoot, "api", "main.ts"));
  assert.equal(assertReadable(review, "web/main.ts"), path.join(workspaceRoot, "web", "main.ts"));
  assert.equal(assertReadable(review, "wiki/overview.md"), path.join(candidateRoot, "overview.md"));
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
