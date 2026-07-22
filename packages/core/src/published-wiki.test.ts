import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  extractTitleFromFrontmatter,
  listPublishedWikiPages,
  PublishedWikiError,
  readPublishedWikiPage,
  resolvePublishedWikiPath,
} from "./published-wiki.js";

/** realpath: macOS /var → /private/var so assertNoSymlinkComponents accepts temp roots. */
async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

const page = (title: string, body = "Hello.") =>
  `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;

test("extractTitleFromFrontmatter reads plain and quoted titles", () => {
  assert.equal(extractTitleFromFrontmatter("---\ntitle: Hello\n---\n\n# H\n"), "Hello");
  assert.equal(
    extractTitleFromFrontmatter('---\ntitle: "Quoted Title"\n---\n\nx\n'),
    "Quoted Title",
  );
  assert.equal(extractTitleFromFrontmatter("# No frontmatter\n"), undefined);
});

test("listPublishedWikiPages returns sorted posix relative paths", async () => {
  const root = await tempDir("okf-pubwiki-list-");
  await writeMd(root, "overview.md", page("Overview"));
  await writeMd(root, "modules/core.md", page("Core"));
  await writeFile(path.join(root, "notes.txt"), "x\n");

  const pages = await listPublishedWikiPages(root);
  assert.deepEqual(pages, ["modules/core.md", "overview.md"]);
});

test("listPublishedWikiPages throws empty when no markdown", async () => {
  const root = await tempDir("okf-pubwiki-empty-");
  await writeFile(path.join(root, "notes.txt"), "x\n");
  await assert.rejects(
    () => listPublishedWikiPages(root),
    (err: unknown) => err instanceof PublishedWikiError && err.code === "empty",
  );
});

test("listPublishedWikiPages throws not_found when missing", async () => {
  const root = await tempDir("okf-pubwiki-miss-");
  await assert.rejects(
    () => listPublishedWikiPages(path.join(root, "nope")),
    (err: unknown) => err instanceof PublishedWikiError && err.code === "not_found",
  );
});

test("listPublishedWikiPages skips symlinked files", async () => {
  const root = await tempDir("okf-pubwiki-sym-");
  await writeMd(root, "overview.md", page("Overview"));
  const outside = await tempDir("okf-pubwiki-out-");
  await writeMd(outside, "secret.md", page("Secret"));
  try {
    await symlink(path.join(outside, "secret.md"), path.join(root, "link.md"));
  } catch {
    // Symlinks may be unavailable on some hosts; skip.
    return;
  }
  const pages = await listPublishedWikiPages(root);
  assert.deepEqual(pages, ["overview.md"]);
});

test("readPublishedWikiPage returns content and title", async () => {
  const root = await tempDir("okf-pubwiki-read-");
  await writeMd(root, "overview.md", page("Overview", "Body text."));
  const result = await readPublishedWikiPage(root, "overview.md");
  assert.equal(result.path, "overview.md");
  assert.equal(result.title, "Overview");
  assert.match(result.content, /Body text/);
});

test("readPublishedWikiPage reads nested path", async () => {
  const root = await tempDir("okf-pubwiki-nested-");
  await writeMd(root, "modules/core.md", page("Core"));
  const result = await readPublishedWikiPage(root, "modules/core.md");
  assert.equal(result.path, "modules/core.md");
  assert.equal(result.title, "Core");
});

test("readPublishedWikiPage rejects path escape", async () => {
  const root = await tempDir("okf-pubwiki-esc-");
  await writeMd(root, "overview.md", page("Overview"));
  await assert.rejects(
    () => readPublishedWikiPage(root, "../outside.md"),
    (err: unknown) => err instanceof PublishedWikiError && err.code === "invalid_path",
  );
  await assert.rejects(
    () => readPublishedWikiPage(root, "/etc/passwd"),
    (err: unknown) => err instanceof PublishedWikiError && err.code === "invalid_path",
  );
});

test("readPublishedWikiPage rejects missing page", async () => {
  const root = await tempDir("okf-pubwiki-nopage-");
  await writeMd(root, "overview.md", page("Overview"));
  await assert.rejects(
    () => readPublishedWikiPage(root, "missing.md"),
    (err: unknown) => err instanceof PublishedWikiError && err.code === "not_found",
  );
});

test("resolvePublishedWikiPath rejects .. and absolute", () => {
  const root = "/tmp/wiki-root";
  assert.throws(
    () => resolvePublishedWikiPath(root, "../x.md"),
    (err: unknown) => err instanceof PublishedWikiError && err.code === "invalid_path",
  );
  assert.throws(
    () => resolvePublishedWikiPath(root, "/abs.md"),
    (err: unknown) => err instanceof PublishedWikiError && err.code === "invalid_path",
  );
  const resolved = resolvePublishedWikiPath(root, "a/b.md");
  assert.equal(resolved, path.resolve(root, "a/b.md"));
});
