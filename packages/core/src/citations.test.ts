import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  findCitationsSectionRange,
  parseSourceCitations,
  sourceRootMapFromSources,
  validateCitationFormat,
  validateCitationPlacement,
  validateCitationResolve,
} from "./citations.js";
import { validateWikiTree } from "./validate-wiki.js";

/** realpath: macOS /var → /private/var so assertNoSymlinkComponents accepts temp roots. */
async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

const okfFm = (title: string) =>
  "---\n" +
  "type: concept\n" +
  `title: ${title}\n` +
  `description: ${title} description\n` +
  "timestamp: 2026-07-21T12:00:00Z\n" +
  "---\n\n";

test("parseSourceCitations: single and multi-repo forms with any link label", () => {
  const text = [
    "Fact A [Source](repo:src/main.ts#L10-L20).",
    "Fact B [lib](repo:my-lib/pkg/a.go#L1).",
    "Fact C [readme](repo:README.md).",
  ].join("\n");
  const cites = parseSourceCitations(text);
  assert.equal(cites.length, 3);
  assert.equal(cites[0]!.target, "src/main.ts");
  assert.equal(cites[0]!.lineStart, 10);
  assert.equal(cites[0]!.lineEnd, 20);
  assert.equal(cites[1]!.target, "my-lib/pkg/a.go");
  assert.equal(cites[1]!.lineStart, 1);
  assert.equal(cites[1]!.lineEnd, undefined);
  assert.equal(cites[2]!.target, "README.md");
});

test("validateCitationFormat rejects path escape and bad ranges", () => {
  const bad = parseSourceCitations(
    "x [Source](repo:../etc/passwd#L0-L2) y [Source](repo:a.ts#L5-L2)",
  );
  const errors = validateCitationFormat(bad, "p.md");
  assert.ok(errors.some((e) => e.includes("repository-relative")));
  assert.ok(errors.some((e) => e.includes("line end before start")));
});

test("findCitationsSectionRange locates # Citations until next H1", () => {
  const content = [
    "# Title",
    "",
    "Body.",
    "",
    "# Citations",
    "",
    "- [a](repo:a.ts#L1)",
    "",
    "# Other",
    "",
    "Not citations [b](repo:b.ts).",
  ].join("\n");
  const range = findCitationsSectionRange(content);
  assert.ok(range);
  assert.ok(content.slice(range!.start, range!.end).includes("repo:a.ts"));
  assert.ok(!content.slice(range!.start, range!.end).includes("repo:b.ts"));
});

test("validateCitationPlacement rejects repo: links outside # Citations", () => {
  const content = [
    "Inline [Source](repo:src/a.ts#L1).",
    "",
    "# Citations",
    "",
    "- [ok](repo:src/b.ts#L2)",
  ].join("\n");
  const cites = parseSourceCitations(content);
  const errors = validateCitationPlacement(cites, content, "p.md");
  assert.ok(errors.some((e) => /Citations|placement|inline/i.test(e)));
  assert.ok(errors.some((e) => e.includes("src/a.ts")));
});

test("validateCitationPlacement accepts repo: only under # Citations", () => {
  const content = [
    "Body with no repo links.",
    "",
    "# Citations",
    "",
    "- [ok](repo:src/b.ts#L2)",
  ].join("\n");
  const cites = parseSourceCitations(content);
  assert.deepEqual(validateCitationPlacement(cites, content, "p.md"), []);
});

test("validateCitationResolve still works as optional soft helper", async () => {
  const root = await tempDir("okf-cite-");
  const src = path.join(root, "repo");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "README.md"), "line1\nline2\nline3\n", "utf8");
  const map = sourceRootMapFromSources([{ id: "main", path: src }]);
  const ok = parseSourceCitations("see [Source](repo:README.md#L1-L2)");
  assert.deepEqual(await validateCitationResolve(ok, "p.md", map), []);
  const oob = parseSourceCitations("see [Source](repo:README.md#L1-L99)");
  const err = await validateCitationResolve(oob, "p.md", map);
  assert.ok(err.some((e) => e.includes("out of bounds")));
  const missing = parseSourceCitations("see [Source](repo:nope.ts#L1)");
  const err2 = await validateCitationResolve(missing, "p.md", map);
  assert.ok(err2.some((e) => e.includes("not found")));
});

test("validateWikiTree hard gate uses placement only — not Snapshot resolve", async () => {
  const root = await tempDir("okf-wiki-cite-");
  const src = path.join(root, "src");
  const wiki = path.join(root, "wiki");
  await mkdir(src, { recursive: true });
  await mkdir(wiki, { recursive: true });
  await writeFile(path.join(src, "README.md"), "# hi\n", "utf8");

  // Missing citations is OK under the hard gate.
  await writeFile(
    path.join(wiki, "overview.md"),
    okfFm("Overview") + "# Overview\n\nBody without cite.\n",
    "utf8",
  );
  const noCite = await validateWikiTree(wiki, {
    sources: [{ id: "main", path: src }],
  });
  assert.equal(noCite.ok, true, noCite.errors.join("; "));

  // Unresolvable path under # Citations still passes hard gate (format only).
  await writeFile(
    path.join(wiki, "overview.md"),
    okfFm("Overview") +
      "# Overview\n\nBody.\n\n# Citations\n\n- [missing](repo:nope.ts#L1)\n",
    "utf8",
  );
  const unresolvable = await validateWikiTree(wiki, {
    sources: [{ id: "main", path: src }],
  });
  assert.equal(unresolvable.ok, true, unresolvable.errors.join("; "));
  assert.equal(unresolvable.citationCount, 1);

  // Inline body placement still fails.
  await writeFile(
    path.join(wiki, "overview.md"),
    okfFm("Overview") +
      "# Overview\n\nNote [Source](repo:README.md#L1).\n",
    "utf8",
  );
  const inline = await validateWikiTree(wiki, {
    sources: [{ id: "main", path: src }],
  });
  assert.equal(inline.ok, false);
  assert.ok(inline.errors.some((e) => /Citations|placement|inline/i.test(e)));
});
