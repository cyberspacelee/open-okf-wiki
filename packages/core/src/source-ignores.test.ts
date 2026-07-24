import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SOURCE_IGNORES,
  effectiveSourceIgnores,
  entryMatchesIgnore,
  pathMatchesIgnore,
  resolveIgnorePreset,
} from "./source-ignores.js";

test("effectiveSourceIgnores unions defaults with user ignore", () => {
  const patterns = effectiveSourceIgnores({
    applyDefaultIgnores: true,
    ignore: ["src/test/**", "node_modules/**"],
  });
  assert.ok(patterns.includes("node_modules/**"));
  assert.ok(patterns.includes("src/test/**"));
  assert.equal(patterns.filter((p) => p === "node_modules/**").length, 1);
});

test("effectiveSourceIgnores can disable defaults", () => {
  const patterns = effectiveSourceIgnores({
    applyDefaultIgnores: false,
    ignore: ["src/test/**"],
  });
  assert.deepEqual(patterns, ["src/test/**"]);
  assert.ok(!patterns.includes("node_modules/**"));
});

test("pathMatchesIgnore matches ** and directory forms", () => {
  assert.equal(pathMatchesIgnore("node_modules/pkg/index.js", ["node_modules/**"]), true);
  assert.equal(pathMatchesIgnore("src/main/java/App.java", ["node_modules/**"]), false);
  assert.equal(pathMatchesIgnore("src/test/java/FooTest.java", ["**/src/test/**"]), true);
  assert.equal(pathMatchesIgnore("FooTest.java", ["**/*Test.java"]), true);
  assert.equal(pathMatchesIgnore("src/Foo.java", ["**/*Test.java"]), false);
});

test("pathMatchesIgnore hides files under **/src/test/**", () => {
  const patterns = ["**/src/test/**", "**/*Test.java"];
  assert.equal(pathMatchesIgnore("src/test", patterns), true);
  assert.equal(pathMatchesIgnore("src/test/java/Foo.java", patterns), true);
  assert.equal(pathMatchesIgnore("module/src/test/java/Bar.java", patterns), true);
  assert.equal(pathMatchesIgnore("src/main/java/App.java", patterns), false);
  assert.equal(pathMatchesIgnore("src/main/java/AppTest.java", patterns), true);
});

test("pathMatchesIgnore treats bare directory names as whole trees", () => {
  // Product semantics: bare name is stronger than native matchesGlob alone.
  assert.equal(pathMatchesIgnore("node_modules", ["node_modules"]), true);
  assert.equal(pathMatchesIgnore("node_modules/pkg/index.js", ["node_modules"]), true);
  assert.equal(pathMatchesIgnore("not_node_modules/x", ["node_modules"]), false);
  assert.equal(pathMatchesIgnore("node_modules_bak/x", ["node_modules"]), false);
});

test("pathMatchesIgnore trailing /** matches the directory itself", () => {
  assert.equal(pathMatchesIgnore("node_modules", ["node_modules/**"]), true);
  assert.equal(pathMatchesIgnore("dist", ["dist/**"]), true);
  assert.equal(pathMatchesIgnore(".git", [".git/**"]), true);
  assert.equal(pathMatchesIgnore("src/test", ["**/src/test/**"]), true);
});

test("pathMatchesIgnore normalizes path separators and prefixes", () => {
  assert.equal(pathMatchesIgnore("node_modules\\pkg\\a.js", ["node_modules/**"]), true);
  assert.equal(pathMatchesIgnore("./dist/out.js", ["dist/**"]), true);
  assert.equal(pathMatchesIgnore("/coverage/lcov.info", ["coverage/**"]), true);
  assert.equal(pathMatchesIgnore("dist/", ["dist/**"]), true);
});

test("pathMatchesIgnore trust boundary: defaults hide dependency noise only", () => {
  assert.equal(pathMatchesIgnore("node_modules/x", DEFAULT_SOURCE_IGNORES), true);
  assert.equal(pathMatchesIgnore("src/main/App.java", DEFAULT_SOURCE_IGNORES), false);
  // Tests are not excluded by default — operators must opt in via ignore/presets.
  assert.equal(pathMatchesIgnore("src/test/java/FooTest.java", DEFAULT_SOURCE_IGNORES), false);
  assert.equal(pathMatchesIgnore("src/main/java/AppTest.java", DEFAULT_SOURCE_IGNORES), false);
});

test("entryMatchesIgnore hides nested noise directories", () => {
  assert.equal(entryMatchesIgnore("", "node_modules", true, DEFAULT_SOURCE_IGNORES), true);
  assert.equal(entryMatchesIgnore("", "src", true, DEFAULT_SOURCE_IGNORES), false);
  assert.equal(entryMatchesIgnore("src/main", "App.java", false, DEFAULT_SOURCE_IGNORES), false);
});

test("entryMatchesIgnore hides src/test directory for java preset", () => {
  const patterns = resolveIgnorePreset("java-tests")!;
  assert.equal(entryMatchesIgnore("src", "test", true, patterns), true);
  assert.equal(entryMatchesIgnore("src/main/java", "App.java", false, patterns), false);
  assert.equal(entryMatchesIgnore("src/main/java", "AppTest.java", false, patterns), true);
});

test("java-tests preset resolves", () => {
  const list = resolveIgnorePreset("java-tests");
  assert.ok(list);
  assert.ok(list!.some((p) => p.includes("Test.java")));
});
