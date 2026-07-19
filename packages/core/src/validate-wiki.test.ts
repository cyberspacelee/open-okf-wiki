import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  hasNonEmptyTitleFrontmatter,
  validateWikiTree,
  WIKI_VALIDATE_MAX_FILE_BYTES,
} from "./validate-wiki.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

const goodPage = (title: string, body = "Hello.") =>
  `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;

test("hasNonEmptyTitleFrontmatter accepts quoted and plain titles", () => {
  assert.equal(hasNonEmptyTitleFrontmatter("---\ntitle: Hello\n---\n\n# H\n"), true);
  assert.equal(
    hasNonEmptyTitleFrontmatter('---\ntitle: "Quoted Title"\n---\n\nx\n'),
    true,
  );
  assert.equal(
    hasNonEmptyTitleFrontmatter("---\ntitle: 'Also Fine'\n---\n\nx\n"),
    true,
  );
});

test("hasNonEmptyTitleFrontmatter rejects missing or empty title", () => {
  assert.equal(hasNonEmptyTitleFrontmatter("# No frontmatter\n"), false);
  assert.equal(hasNonEmptyTitleFrontmatter("---\nfoo: bar\n---\n\nx\n"), false);
  assert.equal(hasNonEmptyTitleFrontmatter("---\ntitle:\n---\n\nx\n"), false);
  assert.equal(hasNonEmptyTitleFrontmatter("---\ntitle:   \n---\n\nx\n"), false);
  assert.equal(hasNonEmptyTitleFrontmatter('---\ntitle: ""\n---\n\nx\n'), false);
});

test("validateWikiTree accepts a minimal valid tree", async () => {
  const root = await tempDir("okf-val-ok-");
  await writeMd(root, "overview.md", goodPage("Overview"));
  await writeMd(root, "modules/core.md", goodPage("Core"));
  const result = await validateWikiTree(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.pageCount, 2);
});

test("validateWikiTree rejects relative path", async () => {
  const result = await validateWikiTree("relative/wiki");
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /absolute/);
});

test("validateWikiTree rejects missing directory", async () => {
  const root = await tempDir("okf-val-missing-");
  const result = await validateWikiTree(path.join(root, "nope"));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /does not exist/);
});

test("validateWikiTree rejects tree with no markdown", async () => {
  const root = await tempDir("okf-val-empty-");
  await writeFile(path.join(root, "notes.txt"), "x\n");
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /no markdown/);
});

test("validateWikiTree rejects md without frontmatter title", async () => {
  const root = await tempDir("okf-val-fm-");
  await writeMd(root, "bad.md", "# Just a heading\n\nNo frontmatter.\n");
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /frontmatter|title/i);
});

test("validateWikiTree rejects symlink entries inside tree", async () => {
  const root = await tempDir("okf-val-sym-");
  await writeMd(root, "ok.md", goodPage("Ok"));
  const target = path.join(root, "ok.md");
  const link = path.join(root, "link.md");
  try {
    await symlink(target, link);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      return;
    }
    throw error;
  }
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /symlink/i);
});

test("validateWikiTree rejects oversized file", async () => {
  const root = await tempDir("okf-val-size-");
  const big = "x".repeat(WIKI_VALIDATE_MAX_FILE_BYTES + 10);
  await writeMd(
    root,
    "huge.md",
    `---\ntitle: Huge\n---\n\n${big}\n`,
  );
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /max file size/i);
});
