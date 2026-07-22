import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generateWikiIndexes } from "./wiki-index.js";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

function concept(
  title: string,
  description: string,
  body = "Body.",
): string {
  return (
    `---\n` +
    `type: concept\n` +
    `title: ${title}\n` +
    `description: ${description}\n` +
    `timestamp: 2026-07-21T12:00:00Z\n` +
    `---\n\n` +
    `# ${title}\n\n${body}\n`
  );
}

test("generateWikiIndexes writes root and nested indexes without frontmatter", async () => {
  const root = await tempDir("okf-idx-");
  await writeMd(root, "overview.md", concept("Overview", "Root narrative"));
  await writeMd(root, "modules/core.md", concept("Core", "Core module"));
  await writeMd(root, "modules/auth.md", concept("Auth", "Auth module"));

  const result = await generateWikiIndexes({
    wikiRoot: root,
    workspaceName: "Demo Workspace",
  });

  assert.ok(result.written.includes("index.md"));
  assert.ok(result.written.includes("modules/index.md"));

  const rootIndex = await readFile(path.join(root, "index.md"), "utf8");
  assert.ok(!rootIndex.startsWith("---"));
  assert.match(rootIndex, /^# Demo Workspace\n/m);
  assert.match(rootIndex, /## Files/);
  assert.match(rootIndex, /## Directories/);
  // overview pinned first among Files
  const filesSection = rootIndex.split("## Files")[1]!.split("## Directories")[0]!;
  assert.ok(filesSection.indexOf("overview.md") >= 0);
  // directories section has modules; files has overview only at root
  assert.match(
    filesSection,
    /- \[Overview\]\(overview\.md\) - Root narrative/,
  );
  assert.match(rootIndex, /- \[modules\]\(modules\/\)/);

  const nested = await readFile(path.join(root, "modules", "index.md"), "utf8");
  assert.match(nested, /^# modules\n/m);
  assert.match(nested, /- \[Auth\]\(auth\.md\) - Auth module/);
  assert.match(nested, /- \[Core\]\(core\.md\) - Core module/);
  // Nested: title sort → Auth before Core
  assert.ok(nested.indexOf("auth.md") < nested.indexOf("core.md"));
  assert.ok(!nested.includes("## Directories"));
});

test("generateWikiIndexes overwrites existing index.md and skips empty leaves", async () => {
  const root = await tempDir("okf-idx-overwrite-");
  await writeMd(root, "overview.md", concept("Overview", "Root"));
  await writeMd(root, "index.md", "# stale agent index\n");
  await mkdir(path.join(root, "empty-leaf"), { recursive: true });
  await writeMd(root, "empty-leaf/index.md", "# should be removed\n");

  await generateWikiIndexes({
    wikiRoot: root,
    workspaceName: "WS",
  });

  const rootIndex = await readFile(path.join(root, "index.md"), "utf8");
  assert.match(rootIndex, /# WS/);
  assert.ok(!rootIndex.includes("stale agent"));

  await assert.rejects(
    () => readFile(path.join(root, "empty-leaf", "index.md"), "utf8"),
    /ENOENT/,
  );
});

test("generateWikiIndexes ignores reserved log.md and non-md files", async () => {
  const root = await tempDir("okf-idx-reserved-");
  await writeMd(root, "overview.md", concept("Overview", "Root"));
  await writeMd(root, "log.md", "# Wiki Update Log\n");
  await writeFile(path.join(root, "notes.txt"), "x\n");

  await generateWikiIndexes({
    wikiRoot: root,
    workspaceName: "WS",
  });

  const rootIndex = await readFile(path.join(root, "index.md"), "utf8");
  assert.ok(!rootIndex.includes("log.md"));
  assert.ok(!rootIndex.includes("notes.txt"));
  assert.match(rootIndex, /overview\.md/);
});
