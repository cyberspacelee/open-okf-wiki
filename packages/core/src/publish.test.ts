import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
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

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

/** Valid wiki page with required YAML frontmatter title. */
function page(title: string, body = "Hello."): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
}

test("countMarkdownFiles counts nested .md files and ignores non-md", async () => {
  const root = await tempDir("okf-pub-count-");
  await writeMd(root, "overview.md", "# O\n");
  await writeMd(root, "nested/arch.md", "# A\n");
  await writeFile(path.join(root, "notes.txt"), "x\n");
  assert.equal(await countMarkdownFiles(root), 2);
});

test("publishStagingToPublication copies staging into empty publication path", async () => {
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
  });

  assert.equal(result.publicationPath, path.resolve(publication));
  assert.equal(result.pageCount, 2);
  const body = await readFile(path.join(publication, "overview.md"), "utf8");
  assert.match(body, /Overview/);
  const nested = await readFile(path.join(publication, "modules", "core.md"), "utf8");
  assert.match(nested, /Core/);
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
      }),
    /does not exist/,
  );
});

test("publishStagingToPublication rejects staging with no markdown", async () => {
  const root = await tempDir("okf-pub-empty-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, "notes.txt"), "x\n");
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: path.join(root, "wiki"),
      }),
    /no markdown/,
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
      }),
    /symlink/,
  );
});

test("assertNoSymlinkComponents accepts real directories", async () => {
  const root = await tempDir("okf-pub-nonsym-");
  await assertNoSymlinkComponents(root, "root");
});

test("publishStagingToPublication rejects md without title frontmatter", async () => {
  const root = await tempDir("okf-pub-fm-");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  await writeMd(staging, "bad.md", "# No frontmatter\n");
  await assert.rejects(
    () =>
      publishStagingToPublication({
        stagingDir: staging,
        publicationPath: path.join(root, "wiki"),
      }),
    /validation|frontmatter|title/i,
  );
});
