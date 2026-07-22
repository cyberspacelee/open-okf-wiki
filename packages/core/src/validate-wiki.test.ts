import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  hasOkfConceptFrontmatter,
  isReservedWikiBasename,
  isReservedWikiRelPath,
  parseOkfConceptFrontmatter,
  validateWikiTree,
  WIKI_VALIDATE_MAX_FILE_BYTES,
} from "./validate-wiki.js";

/** realpath: macOS /var → /private/var so assertNoSymlinkComponents accepts temp roots. */
async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

/** Minimal OKF concept page (four required frontmatter fields). */
function conceptPage(
  title: string,
  body = "Hello.",
  extras: { type?: string; description?: string; timestamp?: string } = {},
): string {
  const type = extras.type ?? "concept";
  const description = extras.description ?? `${title} description`;
  const timestamp = extras.timestamp ?? "2026-07-21T12:00:00Z";
  return (
    `---\n` +
    `type: ${type}\n` +
    `title: ${title}\n` +
    `description: ${description}\n` +
    `timestamp: ${timestamp}\n` +
    `---\n\n` +
    `# ${title}\n\n${body}\n`
  );
}

// --- reserved helpers ---

test("isReservedWikiBasename recognizes index.md and log.md only", () => {
  assert.equal(isReservedWikiBasename("index.md"), true);
  assert.equal(isReservedWikiBasename("log.md"), true);
  assert.equal(isReservedWikiBasename("INDEX.md"), true);
  assert.equal(isReservedWikiBasename("overview.md"), false);
  assert.equal(isReservedWikiBasename("index.mdx"), false);
});

test("isReservedWikiRelPath uses basename only", () => {
  assert.equal(isReservedWikiRelPath("index.md"), true);
  assert.equal(isReservedWikiRelPath("modules/index.md"), true);
  assert.equal(isReservedWikiRelPath("modules/core.md"), false);
});

// --- frontmatter parser ---

test("parseOkfConceptFrontmatter accepts four required fields with quotes", () => {
  const raw =
    "---\n" +
    "type: module\n" +
    'title: "Core Module"\n' +
    "description: 'Does things'\n" +
    "timestamp: 2026-07-21T12:00:00Z\n" +
    "---\n\n# Body\n";
  const result = parseOkfConceptFrontmatter(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fields.type, "module");
  assert.equal(result.fields.title, "Core Module");
  assert.equal(result.fields.description, "Does things");
  assert.equal(result.fields.timestamp, "2026-07-21T12:00:00Z");
});

test("parseOkfConceptFrontmatter allows unknown simple scalar keys", () => {
  const raw =
    "---\n" +
    "type: concept\n" +
    "title: T\n" +
    "description: D\n" +
    "timestamp: 2026-07-21T12:00:00Z\n" +
    "custom_key: kept\n" +
    "---\n\nx\n";
  const result = parseOkfConceptFrontmatter(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fields.extras.custom_key, "kept");
});

test("parseOkfConceptFrontmatter accepts simple tags flow list", () => {
  const raw =
    "---\n" +
    "type: concept\n" +
    "title: T\n" +
    "description: D\n" +
    "timestamp: 2026-07-21T12:00:00Z\n" +
    "tags: [auth, core]\n" +
    "---\n\nx\n";
  const result = parseOkfConceptFrontmatter(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fields.extras.tags, "[auth, core]");
});

test("parseOkfConceptFrontmatter rejects missing required fields", () => {
  assert.equal(
    parseOkfConceptFrontmatter("---\ntitle: Only Title\n---\n\nx\n").ok,
    false,
  );
  assert.equal(
    parseOkfConceptFrontmatter(
      "---\ntype: c\ntitle: T\ndescription: D\n---\n\nx\n",
    ).ok,
    false,
  );
});

test("parseOkfConceptFrontmatter rejects empty required values", () => {
  const raw =
    "---\n" +
    "type: \n" +
    "title: T\n" +
    "description: D\n" +
    "timestamp: 2026-07-21T12:00:00Z\n" +
    "---\n\nx\n";
  assert.equal(parseOkfConceptFrontmatter(raw).ok, false);
});

test("parseOkfConceptFrontmatter rejects date-only timestamp", () => {
  const raw =
    "---\n" +
    "type: concept\n" +
    "title: T\n" +
    "description: D\n" +
    "timestamp: 2026-07-21\n" +
    "---\n\nx\n";
  const result = parseOkfConceptFrontmatter(raw);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => /timestamp|ISO/i.test(e)));
});

test("parseOkfConceptFrontmatter rejects multi-line / nested optional shapes", () => {
  const nested =
    "---\n" +
    "type: concept\n" +
    "title: T\n" +
    "description: D\n" +
    "timestamp: 2026-07-21T12:00:00Z\n" +
    "resource:\n" +
    "  nested: yes\n" +
    "---\n\nx\n";
  assert.equal(parseOkfConceptFrontmatter(nested).ok, false);

  const block =
    "---\n" +
    "type: concept\n" +
    "title: T\n" +
    "description: D\n" +
    "timestamp: 2026-07-21T12:00:00Z\n" +
    "notes: |\n" +
    "  multi\n" +
    "---\n\nx\n";
  assert.equal(parseOkfConceptFrontmatter(block).ok, false);
});

test("hasOkfConceptFrontmatter mirrors parse success", () => {
  assert.equal(hasOkfConceptFrontmatter(conceptPage("Ok")), true);
  assert.equal(hasOkfConceptFrontmatter("# No fm\n"), false);
  assert.equal(
    hasOkfConceptFrontmatter("---\ntitle: Only\n---\n\nx\n"),
    false,
  );
});

// --- tree validation ---

test("validateWikiTree accepts a minimal OKF concept tree", async () => {
  const root = await tempDir("okf-val-ok-");
  await writeMd(root, "overview.md", conceptPage("Overview", "Root narrative."));
  await writeMd(root, "modules/core.md", conceptPage("Core", "Module body."));
  const result = await validateWikiTree(root);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.errors, []);
  assert.equal(result.pageCount, 2);
  assert.equal(result.conceptCount, 2);
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

test("validateWikiTree rejects tree with no concept pages", async () => {
  const root = await tempDir("okf-val-empty-");
  await writeFile(path.join(root, "notes.txt"), "x\n");
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /no (markdown|concept)/i);
});

test("validateWikiTree rejects title-only frontmatter", async () => {
  const root = await tempDir("okf-val-fm-");
  await writeMd(
    root,
    "bad.md",
    "---\ntitle: Only Title\n---\n\n# Only Title\n\nBody.\n",
  );
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /frontmatter|type|description|timestamp/i.test(e)),
  );
});

test("validateWikiTree skips OKF FM on reserved index.md", async () => {
  const root = await tempDir("okf-val-index-");
  await writeMd(root, "overview.md", conceptPage("Overview"));
  await writeMd(
    root,
    "index.md",
    "# Workspace\n\n## Files\n\n- [Overview](overview.md) - Overview description\n",
  );
  await writeMd(
    root,
    "modules/index.md",
    "# modules\n\n## Files\n\n- [Core](core.md) - Core description\n",
  );
  await writeMd(root, "modules/core.md", conceptPage("Core"));
  const result = await validateWikiTree(root);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.conceptCount, 2);
});

test("validateWikiTree allows root log.md without concept FM", async () => {
  const root = await tempDir("okf-val-root-log-");
  await writeMd(root, "overview.md", conceptPage("Overview"));
  await writeMd(
    root,
    "log.md",
    "# Wiki Update Log\n\n## 2026-07-21\n\n- Publish\n",
  );
  const result = await validateWikiTree(root);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.conceptCount, 1);
});

test("validateWikiTree rejects subdirectory log.md", async () => {
  const root = await tempDir("okf-val-sub-log-");
  await writeMd(root, "overview.md", conceptPage("Overview"));
  await writeMd(root, "modules/log.md", "# nested log\n");
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /log\.md/i.test(e) && /subdir|nested|root/i.test(e)));
});

test("validateWikiTree rejects broken internal concept links", async () => {
  const root = await tempDir("okf-val-link-");
  await writeMd(
    root,
    "overview.md",
    conceptPage("Overview", "See [Missing](./nope.md)."),
  );
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /link|resolve|nope/i.test(e)));
});

test("validateWikiTree accepts relative concept links that resolve", async () => {
  const root = await tempDir("okf-val-link-ok-");
  await writeMd(
    root,
    "overview.md",
    conceptPage("Overview", "See [Core](modules/core.md)."),
  );
  await writeMd(
    root,
    "modules/core.md",
    conceptPage("Core", "Back to [Overview](../overview.md)."),
  );
  const result = await validateWikiTree(root);
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("validateWikiTree accepts wiki-root-relative concept links from nested pages", async () => {
  // Agents often emit Concept-ID form `modules/core.md` from a page already
  // under modules/; pure page-relative would wrongly require modules/modules/.
  const root = await tempDir("okf-val-link-rootrel-");
  await writeMd(
    root,
    "modules/sc.md",
    conceptPage("SC", "Depends on [Core](modules/core.md) and sibling [BD](basedata.md)."),
  );
  await writeMd(
    root,
    "modules/core.md",
    conceptPage("Core", "See [SC](modules/sc.md)."),
  );
  await writeMd(root, "modules/basedata.md", conceptPage("Base", "ok"));
  const result = await validateWikiTree(root);
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("validateWikiTree still rejects concept links to missing pages", async () => {
  const root = await tempDir("okf-val-link-missing-");
  await writeMd(
    root,
    "overview.md",
    conceptPage("Overview", "See [Deploy](deployment.md)."),
  );
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /deployment\.md/i.test(e)));
});

test("validateWikiTree rejects inline repo: citations outside # Citations", async () => {
  const root = await tempDir("okf-val-inline-cite-");
  await writeMd(
    root,
    "overview.md",
    conceptPage(
      "Overview",
      "Fact [Source](repo:src/main.ts#L1-L2) inline.",
    ),
  );
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Citations|placement|inline/i.test(e)));
});

test("validateWikiTree accepts repo: links only under # Citations", async () => {
  const root = await tempDir("okf-val-cite-ok-");
  await writeMd(
    root,
    "overview.md",
    conceptPage(
      "Overview",
      "Body claim.\n\n# Citations\n\n- [main](repo:src/main.ts#L1-L2)\n",
    ),
  );
  const result = await validateWikiTree(root);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.citationCount, 1);
});

test("validateWikiTree does not require citations or Snapshot resolve", async () => {
  const root = await tempDir("okf-val-no-cite-");
  const src = path.join(root, "src");
  const wiki = path.join(root, "wiki");
  await mkdir(src, { recursive: true });
  await mkdir(wiki, { recursive: true });
  await writeFile(path.join(src, "README.md"), "# hi\n", "utf8");
  await writeMd(wiki, "overview.md", conceptPage("Overview", "No citations."));
  const result = await validateWikiTree(wiki, {
    sources: [{ id: "main", path: src }],
  });
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.citationCount, 0);
});

test("validateWikiTree rejects symlink entries inside tree", async () => {
  const root = await tempDir("okf-val-sym-");
  await writeMd(root, "ok.md", conceptPage("Ok"));
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
  await writeMd(root, "huge.md", conceptPage("Huge", big));
  const result = await validateWikiTree(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /max file size/i);
});
