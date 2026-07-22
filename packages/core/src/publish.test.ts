import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
  readdir,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertNoSymlinkComponents } from "./paths.js";
import { countMarkdownFiles, publishStagingToPublication } from "./publish.js";

/** realpath: macOS /var → /private/var so assertNoSymlinkComponents accepts temp roots. */
async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

/** Valid OKF concept page (four-field frontmatter). */
function page(title: string, body = "Hello."): string {
  return (
    `---\n` +
    `type: concept\n` +
    `title: ${title}\n` +
    `description: ${title} description\n` +
    `timestamp: 2026-07-21T12:00:00Z\n` +
    `---\n\n` +
    `# ${title}\n\n${body}\n`
  );
}

const basePublish = {
  workspaceName: "Test Workspace",
  skill: "test-skill",
};

test("countMarkdownFiles counts nested .md files and ignores non-md", async () => {
  const root = await tempDir("okf-pub-count-");
  await writeMd(root, "overview.md", "# O\n");
  await writeMd(root, "nested/arch.md", "# A\n");
  await writeFile(path.join(root, "notes.txt"), "x\n");
  assert.equal(await countMarkdownFiles(root), 2);
});

test("publishStagingToPublication success: indexes + root log + concept pages", async () => {
  const root = await tempDir("okf-pub-ok-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview"));
  await writeMd(staging, "modules/core.md", page("Core"));

  const result = await publishStagingToPublication({
    stagingDir: staging,
    publicationPath: publication,
    runId: "run-1",
    ...basePublish,
  });

  assert.equal(result.publicationPath, path.resolve(publication));
  assert.equal(result.pageCount, 2);

  const body = await readFile(path.join(publication, "overview.md"), "utf8");
  assert.match(body, /Overview/);
  const nested = await readFile(path.join(publication, "modules", "core.md"), "utf8");
  assert.match(nested, /Core/);

  const rootIndex = await readFile(path.join(publication, "index.md"), "utf8");
  assert.match(rootIndex, /# Test Workspace/);
  assert.match(rootIndex, /overview\.md/);
  assert.match(rootIndex, /modules\//);

  const nestedIndex = await readFile(
    path.join(publication, "modules", "index.md"),
    "utf8",
  );
  assert.match(nestedIndex, /# modules/);
  assert.match(nestedIndex, /core\.md/);

  const log = await readFile(path.join(publication, "log.md"), "utf8");
  assert.match(log, /# Wiki Update Log/);
  assert.match(log, /runId=run-1/);
  assert.match(log, /skill=`test-skill`/);
  assert.match(log, /Added:.*overview\.md/);
  assert.match(log, /modules\/core\.md/);
  // Index churn must not appear as concept Added
  assert.ok(!/Added:.*index\.md/.test(log));
});

test("publishStagingToPublication second publish: Updated/Removed + prior intact on fail", async () => {
  const root = await tempDir("okf-pub-loop-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview", "v1"));
  await writeMd(staging, "keep.md", page("Keep", "same"));
  await writeMd(staging, "gone.md", page("Gone", "bye"));

  await publishStagingToPublication({
    stagingDir: staging,
    publicationPath: publication,
    runId: "run-1",
    ...basePublish,
  });

  // Second staging: update overview, remove gone, add new
  await writeMd(staging, "overview.md", page("Overview", "v2"));
  await writeMd(staging, "keep.md", page("Keep", "same"));
  await writeMd(staging, "new.md", page("New", "fresh"));
  // remove gone.md from staging
  const { rm } = await import("node:fs/promises");
  await rm(path.join(staging, "gone.md"));

  await publishStagingToPublication({
    stagingDir: staging,
    publicationPath: publication,
    runId: "run-2",
    ...basePublish,
  });

  const log = await readFile(path.join(publication, "log.md"), "utf8");
  // Newest entry first
  assert.ok(log.indexOf("run-2") < log.indexOf("run-1"));
  assert.match(log, /runId=run-2/);
  assert.match(log, /Added: `new\.md`/);
  assert.match(log, /Updated: `overview\.md`/);
  assert.match(log, /Removed: `gone\.md`/);
  // keep.md content unchanged → not Updated
  const run2Block = log.slice(0, log.indexOf("run-1"));
  assert.ok(!run2Block.includes("`keep.md`"));
});

test("publishStagingToPublication hard-fail leaves prior Published unchanged", async () => {
  const root = await tempDir("okf-pub-fail-preserve-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "overview.md", page("Overview", "good"));

  await publishStagingToPublication({
    stagingDir: staging,
    publicationPath: publication,
    runId: "run-ok",
    ...basePublish,
  });

  const beforeLog = await readFile(path.join(publication, "log.md"), "utf8");
  const beforeOverview = await readFile(
    path.join(publication, "overview.md"),
    "utf8",
  );

  // Bad staging: title-only (invalid OKF FM)
  await writeMd(
    staging,
    "overview.md",
    "---\ntitle: Broken\n---\n\n# Broken\n",
  );

  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: publication,
        runId: "run-bad",
        ...basePublish,
      }),
    /validation|frontmatter/i,
  );

  const afterLog = await readFile(path.join(publication, "log.md"), "utf8");
  const afterOverview = await readFile(
    path.join(publication, "overview.md"),
    "utf8",
  );
  assert.equal(afterLog, beforeLog);
  assert.equal(afterOverview, beforeOverview);
  assert.ok(!afterLog.includes("run-bad"));
  assert.match(afterOverview, /good/);
});

test("publishStagingToPublication renames existing publication aside then replaces", async () => {
  const root = await tempDir("okf-pub-replace-");
  const staging = path.join(root, "staging");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await mkdir(publication, { recursive: true });
  await writeFile(path.join(publication, "old.md"), "# Old\n", "utf8");
  await writeMd(staging, "new.md", page("New"));

  const result = await publishStagingToPublication({
    stagingDir: staging,
    publicationPath: publication,
    ...basePublish,
  });

  assert.equal(result.pageCount, 1);
  const published = await readFile(path.join(publication, "new.md"), "utf8");
  assert.match(published, /New/);

  // Aside directory should exist with previous content.
  const siblings = await readdir(root);
  const aside = siblings.find((name) => name.startsWith("wiki.prev."));
  assert.ok(aside, "expected aside directory wiki.prev.*");
  const old = await readFile(path.join(root, aside!, "old.md"), "utf8");
  assert.match(old, /Old/);
});

test("publishStagingToPublication rejects relative stagingDir", async () => {
  const root = await tempDir("okf-pub-rel-");
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: "relative/staging",
        publicationPath: path.join(root, "wiki"),
        ...basePublish,
      }),
    /absolute/,
  );
});

test("publishStagingToPublication rejects relative publicationPath", async () => {
  const root = await tempDir("okf-pub-rel2-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "a.md", page("A"));
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: "relative/wiki",
        ...basePublish,
      }),
    /absolute/,
  );
});

test("publishStagingToPublication rejects missing staging", async () => {
  const root = await tempDir("okf-pub-missing-");
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: path.join(root, "no-such"),
        publicationPath: path.join(root, "wiki"),
        ...basePublish,
      }),
    /does not exist/,
  );
});

test("publishStagingToPublication rejects staging with no concept pages", async () => {
  const root = await tempDir("okf-pub-empty-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, "notes.txt"), "x\n");
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: path.join(root, "wiki"),
        ...basePublish,
      }),
    /no concept pages|no markdown/,
  );
});

test("publishStagingToPublication rejects symlink publicationPath", async () => {
  const root = await tempDir("okf-pub-symlink-");
  const staging = path.join(root, "staging");
  const realTarget = path.join(root, "real-wiki");
  const publication = path.join(root, "wiki");
  await mkdir(staging, { recursive: true });
  await mkdir(realTarget, { recursive: true });
  await writeMd(staging, "a.md", page("A"));
  try {
    await symlink(realTarget, publication, "dir");
  } catch (error) {
    // Some environments disallow directory symlinks; skip in that case.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      return;
    }
    throw error;
  }
  const info = await lstat(publication);
  assert.equal(info.isSymbolicLink(), true);

  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: publication,
        ...basePublish,
      }),
    /symlink/,
  );
});

test("assertNoSymlinkComponents accepts real directories", async () => {
  const root = await tempDir("okf-pub-nonsym-");
  await assertNoSymlinkComponents(root, "root");
});

test("publishStagingToPublication rejects invalid OKF frontmatter", async () => {
  const root = await tempDir("okf-pub-fm-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "bad.md", "# No frontmatter\n");
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: path.join(root, "wiki"),
        ...basePublish,
      }),
    /validation|frontmatter/i,
  );
});

test("publishStagingToPublication requires workspaceName", async () => {
  const root = await tempDir("okf-pub-wsname-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "a.md", page("A"));
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: path.join(root, "wiki"),
        workspaceName: "   ",
      } as Parameters<typeof publishStagingToPublication>[0]),
    /workspaceName/,
  );
});
