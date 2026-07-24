import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertAbsolutePathAllowed,
  assertPathAllowed,
  buildWikiScopedToolDefinitions,
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

describe("Pi file tool definitions", () => {
  it("enforce relative contained paths, Source Ignores, symlinks, and write scope", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-tools-"));
    const workdir = path.join(tmp, "run");
    const outside = path.join(tmp, "outside");

    try {
      await mkdir(path.join(workdir, "sources", "repo", "ignored"), { recursive: true });
      await mkdir(path.join(workdir, "wiki"), { recursive: true });
      await mkdir(path.join(workdir, "analysis"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(
        path.join(workdir, "sources", "repo", "visible.ts"),
        "export const ok = true;\n",
      );
      await writeFile(path.join(workdir, "sources", "repo", "ignored", "secret.ts"), "secret\n");
      await writeFile(path.join(outside, "secret.ts"), "outside\n");
      await symlink(outside, path.join(workdir, "sources", "repo", "escape"), "dir");
      await symlink(outside, path.join(workdir, "wiki", "escape"), "dir");

      const definitions = buildWikiScopedToolDefinitions({
        runWorkDir: workdir,
        mayWrite: true,
        sourceIgnores: new Map([["repo", ["ignored/**"]]]),
      });
      const tools = new Map(definitions.map((definition) => [definition.name, definition]));
      const execute = async (name: string, input: Record<string, unknown>) => {
        const definition = tools.get(name);
        assert.ok(definition, `missing ${name} definition`);
        const run = definition.execute as unknown as (
          toolCallId: string,
          args: Record<string, unknown>,
        ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
        return run("test-call", input);
      };

      await assert.doesNotReject(() => execute("read", { path: "sources/repo/visible.ts" }));
      await assert.rejects(
        () => execute("read", { path: path.join(workdir, "sources", "repo", "visible.ts") }),
        /relative|absolute/i,
      );
      await assert.rejects(() => execute("read", { path: "../outside/secret.ts" }), /escape|\.\./i);
      await assert.rejects(
        () => execute("read", { path: "sources/repo/escape/secret.ts" }),
        /symlink|escape|workdir/i,
      );
      await assert.rejects(
        () => execute("read", { path: "sources/repo/ignored/secret.ts" }),
        /ignored/i,
      );

      await assert.rejects(
        () => execute("ls", { path: "sources/repo/escape" }),
        /symlink|escape|not found|workdir/i,
      );
      await assert.rejects(
        () => execute("grep", { pattern: "outside", path: "sources/repo/escape" }),
        /symlink|escape|not found|workdir/i,
      );
      const lsResult = await execute("ls", { path: "sources/repo" });
      const lsText = lsResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.doesNotMatch(lsText, /ignored/);
      const grepResult = await execute("grep", { pattern: "secret", path: "sources/repo" });
      const grepText = grepResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.doesNotMatch(grepText, /ignored|secret\.ts/);
      await assert.rejects(
        () => execute("find", { pattern: "*.ts", path: "sources/repo/escape" }),
        /symlink|escape|not found|workdir/i,
      );
      const findResult = await execute("find", { pattern: "**/*.ts", path: "sources/repo" });
      const findText = findResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.match(findText, /visible\.ts/);
      assert.doesNotMatch(findText, /ignored|secret\.ts|escape/);

      await assert.rejects(
        () => execute("write", { path: path.join(workdir, "wiki", "absolute.md"), content: "no" }),
        /relative|absolute/i,
      );
      await assert.rejects(
        () => execute("write", { path: "../outside/new.md", content: "no" }),
        /escape|\.\./i,
      );
      await assert.rejects(
        () => execute("write", { path: "wiki/escape/new.md", content: "no" }),
        /symlink|escape|workdir/i,
      );
      await assert.rejects(
        () =>
          execute("edit", {
            path: "wiki/escape/secret.ts",
            edits: [{ oldText: "outside", newText: "changed" }],
          }),
        /symlink|escape|workdir|could not edit/i,
      );
      await assert.rejects(
        () => execute("write", { path: "sources/repo/no.md", content: "no" }),
        /read-only|wiki\/ or analysis/i,
      );
      await assert.doesNotReject(() => execute("write", { path: "wiki/ok.md", content: "ok\n" }));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
