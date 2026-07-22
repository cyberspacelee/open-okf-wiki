import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  appendRootLog,
  diffConceptSnapshots,
  formatPublishLogEntry,
  listConceptContentHashes,
  parseWikiLogOrNull,
} from "./wiki-log.js";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function writeMd(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
}

function concept(title: string, body: string): string {
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

test("formatPublishLogEntry matches ADR schema", () => {
  const text = formatPublishLogEntry({
    runId: "run-1",
    skill: "skill@abc",
    at: new Date("2026-07-22T15:30:00.000Z"),
    added: ["overview.md", "modules/core.md"],
    updated: ["flow.md"],
    removed: [],
  });
  assert.match(
    text,
    /\* \*\*Publish\*\* `runId=run-1` skill=`skill@abc` at `2026-07-22T15:30:00\.000Z`/,
  );
  assert.match(text, /\* Added: `overview\.md`, `modules\/core\.md`/);
  assert.match(text, /\* Updated: `flow\.md`/);
  assert.match(text, /\* Removed: \(none\)/);
});

test("diffConceptSnapshots classifies added updated removed", () => {
  const prev = new Map([
    ["a.md", "hash-a"],
    ["b.md", "hash-b"],
    ["c.md", "hash-c"],
  ]);
  const next = new Map([
    ["a.md", "hash-a"], // unchanged
    ["b.md", "hash-b2"], // updated
    ["d.md", "hash-d"], // added
  ]);
  const diff = diffConceptSnapshots(prev, next);
  assert.deepEqual(diff.added, ["d.md"]);
  assert.deepEqual(diff.updated, ["b.md"]);
  assert.deepEqual(diff.removed, ["c.md"]);
});

test("listConceptContentHashes skips reserved docs", async () => {
  const root = await tempDir("okf-log-list-");
  await writeMd(root, "overview.md", concept("Overview", "A"));
  await writeMd(root, "index.md", "# WS\n");
  await writeMd(root, "log.md", "# Wiki Update Log\n");
  await writeMd(root, "modules/core.md", concept("Core", "B"));

  const map = await listConceptContentHashes(root);
  assert.equal(map.size, 2);
  assert.ok(map.has("overview.md"));
  assert.ok(map.has("modules/core.md"));
  assert.ok(!map.has("index.md"));
  assert.ok(!map.has("log.md"));
});

test("appendRootLog creates skeleton on first publish", async () => {
  const root = await tempDir("okf-log-first-");
  await writeMd(root, "overview.md", concept("Overview", "A"));

  await appendRootLog(root, {
    runId: "run-1",
    skill: "bundled",
    at: new Date("2026-07-22T12:00:00.000Z"),
    added: ["overview.md"],
    updated: [],
    removed: [],
  });

  const log = await readFile(path.join(root, "log.md"), "utf8");
  assert.match(log, /^# Wiki Update Log\n/);
  assert.match(log, /## 2026-07-22\n/);
  assert.match(log, /runId=run-1/);
  assert.match(log, /Added: `overview\.md`/);
});

test("appendRootLog inserts newest-first under same UTC day", async () => {
  const root = await tempDir("okf-log-same-day-");
  await appendRootLog(root, {
    runId: "run-1",
    skill: "s",
    at: new Date("2026-07-22T10:00:00.000Z"),
    added: ["a.md"],
    updated: [],
    removed: [],
  });
  await appendRootLog(root, {
    runId: "run-2",
    skill: "s",
    at: new Date("2026-07-22T18:00:00.000Z"),
    added: [],
    updated: ["a.md"],
    removed: [],
  });

  const log = await readFile(path.join(root, "log.md"), "utf8");
  const first = log.indexOf("run-2");
  const second = log.indexOf("run-1");
  assert.ok(first >= 0 && second >= 0);
  assert.ok(first < second, "newer publish entry should be above older same-day entry");
});

test("appendRootLog places newer date sections first", async () => {
  const root = await tempDir("okf-log-dates-");
  await appendRootLog(root, {
    runId: "run-old",
    skill: "s",
    at: new Date("2026-07-20T12:00:00.000Z"),
    added: ["a.md"],
    updated: [],
    removed: [],
  });
  await appendRootLog(root, {
    runId: "run-new",
    skill: "s",
    at: new Date("2026-07-22T12:00:00.000Z"),
    added: [],
    updated: ["a.md"],
    removed: [],
  });

  const log = await readFile(path.join(root, "log.md"), "utf8");
  assert.ok(log.indexOf("## 2026-07-22") < log.indexOf("## 2026-07-20"));
});

test("appendRootLog replaces corrupt log with skeleton + entry", async () => {
  const root = await tempDir("okf-log-corrupt-");
  await writeFile(path.join(root, "log.md"), "not a valid log at all\n", "utf8");

  await appendRootLog(root, {
    runId: "run-x",
    skill: "s",
    at: new Date("2026-07-22T12:00:00.000Z"),
    added: ["overview.md"],
    updated: [],
    removed: [],
  });

  const log = await readFile(path.join(root, "log.md"), "utf8");
  assert.match(log, /^# Wiki Update Log\n/);
  assert.match(log, /runId=run-x/);
  assert.ok(!log.includes("not a valid log"));
  assert.equal(parseWikiLogOrNull(log) !== null, true);
});
