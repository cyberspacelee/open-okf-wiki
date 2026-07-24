import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@okf-wiki/contract";
import {
  FreezeWikiRunError,
  freezeWikiRun,
  setFreezeWikiRunIdFactoryForTests,
} from "./run-boundary.js";
import { loadRun, registerRunRecord } from "./run-store.js";
import { skillDigest } from "./skill-digest.js";

async function makeGitRepo(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
  await writeFile(path.join(dir, "README.md"), "# src\n", "utf8");
  spawnSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

async function makeWorkspace(opts?: {
  dirty?: boolean;
  noSources?: boolean;
}): Promise<{ root: string; workspace: WorkspaceConfig; skillDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-freeze-"));
  const skillDir = path.join(root, "skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: test-skill\n---\n# skill\n", "utf8");

  let sources: WorkspaceConfig["sources"] = [];
  if (!opts?.noSources) {
    const src = await makeGitRepo(root, "src");
    if (opts?.dirty) {
      await writeFile(path.join(src, "dirty.txt"), "x\n", "utf8");
    }
    sources = [
      {
        id: "main",
        path: src,
        applyDefaultIgnores: true,
        ignore: [],
        origin: { type: "path" },
      },
    ];
  }

  const workspace = WorkspaceConfigSchema.parse({
    version: 1,
    id: "ws1",
    name: "Freeze WS",
    rootPath: root,
    sources,
    skillPath: skillDir,
    model: { id: "openai/test" },
    publicationPath: path.join(root, "wiki-out"),
    limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
    planConfirm: false,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });

  return { root, workspace, skillDir };
}

test("freezeWikiRun creates record with skillDigest and clean sources", async () => {
  const { root, workspace } = await makeWorkspace();
  const frozen = await freezeWikiRun({
    workspace,
    sessionId: "sess-1",
    autoApprove: true,
  });

  assert.ok(frozen.runId);
  assert.equal(frozen.skillPath, path.join(root, ".okf-wiki", "runs", frozen.runId, "skill"));
  assert.ok(frozen.skillDigest && frozen.skillDigest.length > 8);
  assert.equal(frozen.sources.length, 1);
  assert.equal(frozen.sources[0]!.id, "main");
  assert.ok(frozen.sources[0]!.revision);
  assert.equal(frozen.sourcePathMap.get("main"), frozen.sources[0]!.path);
  assert.ok(frozen.sourceIgnores.has("main"));

  const record = await loadRun(root, frozen.runId);
  assert.ok(record);
  assert.equal(record!.skillDigest, frozen.skillDigest);
  assert.equal(record!.sessionId, "sess-1");
  assert.equal(record!.autoApprove, true);
  assert.equal(record!.status, "running");
});

test("freezeWikiRun rejects dirty source", async () => {
  const { workspace } = await makeWorkspace({ dirty: true });
  await assert.rejects(
    () => freezeWikiRun({ workspace, sessionId: "session-dirty" }),
    (err: unknown) => {
      assert.ok(err instanceof FreezeWikiRunError);
      assert.equal(err.code, "source_dirty");
      return true;
    },
  );
});

test("freezeWikiRun rejects empty sources", async () => {
  const { workspace } = await makeWorkspace({ noSources: true });
  await assert.rejects(
    () => freezeWikiRun({ workspace, sessionId: "session-empty" }),
    (err: unknown) => {
      assert.ok(err instanceof FreezeWikiRunError);
      assert.equal(err.code, "no_sources");
      return true;
    },
  );
});

test("freezeWikiRun registers a generated runId", async () => {
  const { root, workspace } = await makeWorkspace();
  const frozen = await freezeWikiRun({
    workspace,
    sessionId: "s2",
  });
  assert.ok(frozen.runId);
  const record = await loadRun(root, frozen.runId);
  assert.ok(record);
  assert.equal(record!.sessionId, "s2");
  assert.equal(record!.status, "running");
});

test("freezeWikiRun materialises a fixed revision instead of exposing the live checkout", async () => {
  const { root, workspace } = await makeWorkspace();
  const liveSource = workspace.sources[0]!.path;
  const frozen = await freezeWikiRun({
    workspace,
    sessionId: "snapshot-session",
  });

  const snapshot = frozen.sourcePathMap.get("main");
  assert.ok(snapshot);
  assert.notEqual(snapshot, liveSource);
  assert.equal(snapshot, path.join(root, ".okf-wiki", "runs", frozen.runId, "sources", "main"));
  assert.equal((await lstat(snapshot)).isSymbolicLink(), false);
  assert.equal((await lstat(path.join(snapshot, "README.md"))).isSymbolicLink(), false);

  await writeFile(path.join(liveSource, "README.md"), "# changed after freeze\n", "utf8");
  assert.equal(await readFile(path.join(snapshot, "README.md"), "utf8"), "# src\n");
});

test("freezeWikiRun physically removes Effective Source Ignores from the snapshot", async () => {
  const { workspace } = await makeWorkspace();
  const liveSource = workspace.sources[0]!.path;
  workspace.sources[0]!.ignore = ["private/**"];
  await mkdir(path.join(liveSource, "node_modules"), { recursive: true });
  await mkdir(path.join(liveSource, "private"), { recursive: true });
  await mkdir(path.join(liveSource, "src"), { recursive: true });
  await writeFile(path.join(liveSource, "node_modules", "dep.js"), "ignored default\n");
  await writeFile(path.join(liveSource, "private", "secret.txt"), "ignored configured\n");
  await writeFile(path.join(liveSource, "src", "keep.ts"), "export const keep = true;\n");
  spawnSync("git", ["add", "-f", "."], { cwd: liveSource, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "tracked ignores"], { cwd: liveSource, stdio: "ignore" });

  const frozen = await freezeWikiRun({
    workspace,
    sessionId: "ignore-session",
  });
  const snapshot = frozen.sourcePathMap.get("main")!;

  await assert.rejects(() => readFile(path.join(snapshot, "node_modules", "dep.js")));
  await assert.rejects(() => readFile(path.join(snapshot, "private", "secret.txt")));
  assert.equal(
    await readFile(path.join(snapshot, "src", "keep.ts"), "utf8"),
    "export const keep = true;\n",
  );
  assert.ok(frozen.sources[0]!.effectiveIgnores.includes("private/**"));
});

test("freezeWikiRun turns Git symlink blobs into read-only ordinary text files", async () => {
  const { workspace } = await makeWorkspace();
  const liveSource = workspace.sources[0]!.path;
  await symlink("README.md", path.join(liveSource, "readme-link"));
  spawnSync("git", ["add", "."], { cwd: liveSource, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "add symlink blob"], { cwd: liveSource, stdio: "ignore" });

  const frozen = await freezeWikiRun({
    workspace,
    sessionId: "symlink-session",
  });
  const snapshot = frozen.sourcePathMap.get("main")!;
  const linkInfo = await lstat(path.join(snapshot, "readme-link"));

  assert.equal(linkInfo.isSymbolicLink(), false);
  assert.equal(linkInfo.isFile(), true);
  assert.equal(await readFile(path.join(snapshot, "readme-link"), "utf8"), "README.md");
  assert.equal(linkInfo.mode & 0o222, 0);
  assert.equal((await lstat(snapshot)).mode & 0o222, 0);
});

test("freezeWikiRun copies and reverifies the Producer Skill as a run-owned version", async () => {
  const { root, workspace, skillDir } = await makeWorkspace();
  const frozen = await freezeWikiRun({
    workspace,
    sessionId: "skill-session",
  });

  const expectedPath = path.join(root, ".okf-wiki", "runs", frozen.runId, "skill");
  assert.equal(frozen.skillPath, expectedPath);
  assert.equal((await lstat(frozen.skillPath)).isSymbolicLink(), false);
  assert.equal((await lstat(path.join(frozen.skillPath, "SKILL.md"))).mode & 0o222, 0);
  assert.equal(await skillDigest(frozen.skillPath), frozen.skillDigest);

  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: changed\n---\n# changed\n");
  assert.equal(await skillDigest(frozen.skillPath), frozen.skillDigest);
  const record = await loadRun(root, frozen.runId);
  assert.equal(record?.skillPath, expectedPath);
  assert.equal(record?.skillDigest, frozen.skillDigest);
});

test("freezeWikiRun refuses an existing run directory without touching its contents", async () => {
  const { root, workspace } = await makeWorkspace();
  const first = await freezeWikiRun({
    workspace,
    sessionId: "first-session",
  });
  const collisionId = "collision-run";
  const existing = path.join(root, ".okf-wiki", "runs", collisionId);
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, "sentinel.txt"), "operator data\n");

  setFreezeWikiRunIdFactoryForTests(() => collisionId);
  try {
    await assert.rejects(
      () =>
        freezeWikiRun({
          workspace,
          sessionId: "collision-session",
        }),
      /already exists/i,
    );
  } finally {
    setFreezeWikiRunIdFactoryForTests(undefined);
  }
  assert.equal(await readFile(path.join(existing, "sentinel.txt"), "utf8"), "operator data\n");
  assert.ok(await loadRun(root, first.runId));
  assert.equal(await loadRun(root, collisionId), null);
});

test("freezeWikiRun removes only its new run directory when later freeze steps fail", async () => {
  const { root, workspace, skillDir } = await makeWorkspace();
  const forcedId = "bad-skill-run";
  // Pre-register a record so freeze fails after materializing the exclusive run dir.
  await registerRunRecord(root, workspace.id, {
    runId: forcedId,
    sessionId: "pre-existing",
    autoApprove: false,
    skillPath: path.join(root, ".okf-wiki", "runs", forcedId, "skill"),
    skillDigest: "a".repeat(64),
    sources: [
      {
        id: "main",
        revision: "b".repeat(40),
        effectiveIgnores: [],
      },
    ],
  });

  setFreezeWikiRunIdFactoryForTests(() => forcedId);
  try {
    await assert.rejects(
      () =>
        freezeWikiRun({
          workspace,
          sessionId: "bad-skill-session",
        }),
      /already exists/i,
    );
  } finally {
    setFreezeWikiRunIdFactoryForTests(undefined);
  }

  const runDir = path.join(root, ".okf-wiki", "runs", forcedId);
  await assert.rejects(() => lstat(runDir), /ENOENT/);
  // Pre-existing record file is untouched; only the new run directory is removed.
  assert.ok(await loadRun(root, forcedId));
  assert.equal(
    await readFile(path.join(skillDir, "SKILL.md"), "utf8"),
    "---\nname: test-skill\n---\n# skill\n",
  );
});
