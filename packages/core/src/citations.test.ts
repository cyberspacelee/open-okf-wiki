import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  parseSourceCitations,
  sourceRootMapFromSources,
  validateCitationFormat,
  validateCitationResolve,
} from "./citations.js";
import { validateWikiTree } from "./validate-wiki.js";

test("parseSourceCitations: single and multi-repo forms", () => {
  const text = [
    "Fact A [Source](repo:src/main.ts#L10-L20).",
    "Fact B [Source](repo:my-lib/pkg/a.go#L1).",
    "Fact C [Source](repo:README.md).",
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

test("validateCitationResolve: file + line bounds against snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-cite-"));
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

test("validateWikiTree with sources requires resolvable citations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-cite-"));
  const src = path.join(root, "src");
  const wiki = path.join(root, "wiki");
  await mkdir(src, { recursive: true });
  await mkdir(wiki, { recursive: true });
  await writeFile(path.join(src, "README.md"), "# hi\n", "utf8");
  await writeFile(
    path.join(wiki, "overview.md"),
    "---\ntitle: Overview\n---\n\n# Overview\n\nBody without cite.\n",
    "utf8",
  );
  const fail = await validateWikiTree(wiki, {
    sources: [{ id: "main", path: src }],
  });
  assert.equal(fail.ok, false);
  assert.ok(fail.errors.some((e) => e.includes("missing Source Citation")));

  await writeFile(
    path.join(wiki, "overview.md"),
    "---\ntitle: Overview\n---\n\n# Overview\n\nNote [Source](repo:README.md#L1).\n",
    "utf8",
  );
  const pass = await validateWikiTree(wiki, {
    sources: [{ id: "main", path: src }],
  });
  assert.equal(pass.ok, true, pass.errors.join("; "));
  assert.equal(pass.citationCount, 1);
});
