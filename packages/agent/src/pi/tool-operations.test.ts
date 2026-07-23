import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertAbsolutePathAllowed,
  assertPathAllowed,
  isIgnoredSourceRel,
  isReadOnlyTreeRel,
  isUnder,
  isWriteScopeRel,
  normalizeRelPath,
  parseSourceMountPath,
  WRITE_SCOPE_PREFIXES,
} from "./tool-operations.js";

const runWorkDir = path.resolve("/tmp/okf-wiki-run-workdir");

describe("isUnder", () => {
  it("accepts equal and nested paths", () => {
    assert.equal(isUnder("/a/b", "/a/b"), true);
    assert.equal(isUnder("/a/b", "/a/b/c"), true);
    assert.equal(isUnder("/a/b", "/a/other"), false);
    assert.equal(isUnder("/a/b", "/a/b-extra"), false);
  });
});

describe("normalizeRelPath / write scope", () => {
  it("normalizes ./ and backslashes", () => {
    assert.equal(normalizeRelPath("./wiki/foo.md"), "wiki/foo.md");
    assert.equal(normalizeRelPath("wiki\\bar.md"), "wiki/bar.md");
    assert.equal(normalizeRelPath("."), "");
    assert.equal(normalizeRelPath(""), "");
  });

  it("isWriteScopeRel covers wiki and analysis only", () => {
    assert.equal(isWriteScopeRel("wiki"), true);
    assert.equal(isWriteScopeRel("wiki/index.md"), true);
    assert.equal(isWriteScopeRel("analysis/spec.json"), true);
    assert.equal(isWriteScopeRel("sources/a/x.ts"), false);
    assert.equal(isWriteScopeRel("skill/SKILL.md"), false);
    assert.equal(isWriteScopeRel(""), false);
    assert.ok(WRITE_SCOPE_PREFIXES.includes("wiki/"));
    assert.ok(WRITE_SCOPE_PREFIXES.includes("analysis/"));
  });

  it("isReadOnlyTreeRel covers sources and skill", () => {
    assert.equal(isReadOnlyTreeRel("sources/repo/a.ts"), true);
    assert.equal(isReadOnlyTreeRel("skill/SKILL.md"), true);
    assert.equal(isReadOnlyTreeRel("wiki/x.md"), false);
  });
});

describe("assertPathAllowed read", () => {
  it("allows nested read under runWorkDir", () => {
    const abs = assertPathAllowed(runWorkDir, "sources/repo/src/Main.java", {
      mode: "read",
    });
    assert.equal(abs, path.join(runWorkDir, "sources", "repo", "src", "Main.java"));
  });

  it("allows empty / . as workdir root for read", () => {
    assert.equal(assertPathAllowed(runWorkDir, "", { mode: "read" }), runWorkDir);
    assert.equal(assertPathAllowed(runWorkDir, ".", { mode: "read" }), runWorkDir);
  });

  it("rejects parent traversal and absolute paths", () => {
    assert.throws(
      () => assertPathAllowed(runWorkDir, "../etc/passwd", { mode: "read" }),
      /escape|\.\./i,
    );
    assert.throws(
      () => assertPathAllowed(runWorkDir, "/etc/passwd", { mode: "read" }),
      /absolute/i,
    );
  });

  it("rejects ignored source paths when ignore list provided", () => {
    const ignores = new Map<string, readonly string[]>([
      ["repo", ["node_modules/**", "**/src/test/**"]],
    ]);
    assert.throws(
      () =>
        assertPathAllowed(runWorkDir, "sources/repo/node_modules/x/index.js", {
          mode: "read",
          sourceIgnores: ignores,
        }),
      /ignored/i,
    );
    assert.throws(
      () =>
        assertPathAllowed(runWorkDir, "sources/repo/src/test/FooTest.java", {
          mode: "read",
          sourceIgnores: ignores,
        }),
      /ignored/i,
    );
    // Production path still allowed
    const abs = assertPathAllowed(runWorkDir, "sources/repo/src/main/java/App.java", {
      mode: "read",
      sourceIgnores: ignores,
    });
    assert.ok(abs.endsWith(path.join("sources", "repo", "src", "main", "java", "App.java")));
  });

  it("flat ignore array applies to every source", () => {
    assert.equal(isIgnoredSourceRel("sources/a/dist/out.js", ["dist/**"]), true);
    assert.throws(
      () =>
        assertPathAllowed(runWorkDir, "sources/a/dist/out.js", {
          mode: "read",
          sourceIgnores: ["dist/**"],
        }),
      /ignored/i,
    );
  });
});

describe("assertPathAllowed write", () => {
  it("allows wiki/ and analysis/", () => {
    assert.ok(
      assertPathAllowed(runWorkDir, "wiki/index.md", { mode: "write" }).endsWith(
        path.join("wiki", "index.md"),
      ),
    );
    assert.ok(
      assertPathAllowed(runWorkDir, "analysis/spec.json", {
        mode: "write",
      }).endsWith(path.join("analysis", "spec.json")),
    );
  });

  it("denies sources/, skill/, and other trees", () => {
    assert.throws(
      () => assertPathAllowed(runWorkDir, "sources/repo/x.ts", { mode: "write" }),
      /read-only|denied/i,
    );
    assert.throws(
      () => assertPathAllowed(runWorkDir, "skill/SKILL.md", { mode: "write" }),
      /read-only|denied/i,
    );
    assert.throws(
      () => assertPathAllowed(runWorkDir, "other.md", { mode: "write" }),
      /wiki\/ or analysis/i,
    );
    assert.throws(
      () => assertPathAllowed(runWorkDir, "", { mode: "write" }),
      /wiki\/ or analysis/i,
    );
  });
});

describe("assertAbsolutePathAllowed", () => {
  it("accepts absolute under workdir write scope", () => {
    const abs = path.join(runWorkDir, "wiki", "a.md");
    assert.equal(assertAbsolutePathAllowed(runWorkDir, abs, { mode: "write" }), path.resolve(abs));
  });

  it("rejects absolute outside workdir", () => {
    assert.throws(
      () => assertAbsolutePathAllowed(runWorkDir, "/etc/passwd", { mode: "read" }),
      /escapes/i,
    );
  });
});

describe("parseSourceMountPath", () => {
  it("splits source id and repo path", () => {
    assert.deepEqual(parseSourceMountPath("sources/repo/src/Main.java"), {
      sourceId: "repo",
      repoRel: "src/Main.java",
    });
    assert.deepEqual(parseSourceMountPath("sources/repo"), {
      sourceId: "repo",
      repoRel: "",
    });
    assert.equal(parseSourceMountPath("wiki/x.md"), null);
  });
});
