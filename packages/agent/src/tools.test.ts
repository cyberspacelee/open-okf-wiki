/**
 * Host-enforced Effective Source Ignores on list_source / read_source.
 * These tools are the only source access path during live wiki generation.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildSourceIgnoreMap } from "@okf-wiki/core";
import { createWikiRunTools } from "./tools.js";

async function makeJavaishTree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-src-ignore-"));
  await mkdir(path.join(root, "src/main/java/com/example"), { recursive: true });
  await mkdir(path.join(root, "src/test/java/com/example"), { recursive: true });
  await mkdir(path.join(root, "node_modules/leftpad"), { recursive: true });
  await writeFile(
    path.join(root, "src/main/java/com/example/App.java"),
    "class App {}\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "src/main/java/com/example/AppTest.java"),
    "class AppTest {}\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "src/test/java/com/example/FooTest.java"),
    "class FooTest {}\n",
    "utf8",
  );
  await writeFile(path.join(root, "node_modules/leftpad/index.js"), "module.exports=1\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# app\n", "utf8");
  return root;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function invokeTool(tool: { execute?: (...args: any[]) => any }, input: unknown): Promise<any> {
  assert.ok(tool.execute, "tool must have execute");
  return tool.execute(input, {
    agent: undefined,
    mastra: undefined,
    runtimeContext: {},
  });
}

test("list_source hides default noise and java-test patterns during generation", async () => {
  const sourceRoot = await makeJavaishTree();
  const wikiRoot = await mkdtemp(path.join(tmpdir(), "okf-wiki-stg-"));
  const skillRoot = await mkdtemp(path.join(tmpdir(), "okf-skill-"));

  const sources = new Map([["app", sourceRoot]]);
  const sourceIgnores = buildSourceIgnoreMap([
    {
      id: "app",
      path: sourceRoot,
      applyDefaultIgnores: true,
      ignore: [
        "src/test/**",
        "**/src/test/**",
        "**/*Test.java",
        "**/*Tests.java",
        "**/*IT.java",
        "**/*ITCase.java",
      ],
    },
  ]);

  const tools = createWikiRunTools({
    sources,
    sourceIgnores,
    skillRoot,
    wikiRoot,
  });

  const rootList = await invokeTool(tools.list_source, { path: "" });
  const rootNames = rootList.entries.map((e: { name: string }) => e.name).sort();
  assert.deepEqual(rootNames, ["README.md", "src"]);
  assert.ok(!rootNames.includes("node_modules"), "default ignore hides node_modules");

  const srcList = await invokeTool(tools.list_source, { path: "src" });
  const srcNames = srcList.entries.map((e: { name: string }) => e.name).sort();
  assert.deepEqual(srcNames, ["main"]);
  assert.ok(!srcNames.includes("test"), "java-tests preset hides src/test");

  const mainList = await invokeTool(tools.list_source, {
    path: "src/main/java/com/example",
  });
  const mainNames = mainList.entries.map((e: { name: string }) => e.name).sort();
  assert.deepEqual(mainNames, ["App.java"]);
  assert.ok(!mainNames.includes("AppTest.java"), "*Test.java files are hidden");
});

test("read_source rejects ignored paths and allows production sources", async () => {
  const sourceRoot = await makeJavaishTree();
  const wikiRoot = await mkdtemp(path.join(tmpdir(), "okf-wiki-stg-"));
  const skillRoot = await mkdtemp(path.join(tmpdir(), "okf-skill-"));

  const tools = createWikiRunTools({
    sources: new Map([["app", sourceRoot]]),
    sourceIgnores: buildSourceIgnoreMap([
      {
        id: "app",
        path: sourceRoot,
        applyDefaultIgnores: true,
        ignore: ["**/src/test/**", "**/*Test.java"],
      },
    ]),
    skillRoot,
    wikiRoot,
  });

  const ok = await invokeTool(tools.read_source, {
    path: "src/main/java/com/example/App.java",
  });
  assert.match(ok.content, /class App/);

  await assert.rejects(
    () =>
      invokeTool(tools.read_source, {
        path: "src/test/java/com/example/FooTest.java",
      }),
    /Effective Source Ignores|excluded by/i,
  );

  await assert.rejects(
    () =>
      invokeTool(tools.read_source, {
        path: "src/main/java/com/example/AppTest.java",
      }),
    /Effective Source Ignores|excluded by/i,
  );

  await assert.rejects(
    () =>
      invokeTool(tools.read_source, {
        path: "node_modules/leftpad/index.js",
      }),
    /Effective Source Ignores|excluded by/i,
  );
});

test("list_source under ignored directory returns empty", async () => {
  const sourceRoot = await makeJavaishTree();
  const wikiRoot = await mkdtemp(path.join(tmpdir(), "okf-wiki-stg-"));
  const skillRoot = await mkdtemp(path.join(tmpdir(), "okf-skill-"));

  const tools = createWikiRunTools({
    sources: new Map([["app", sourceRoot]]),
    sourceIgnores: buildSourceIgnoreMap([
      {
        id: "app",
        path: sourceRoot,
        applyDefaultIgnores: false,
        ignore: ["src/test/**"],
      },
    ]),
    skillRoot,
    wikiRoot,
  });

  const listed = await invokeTool(tools.list_source, { path: "src/test/java" });
  assert.equal(listed.ignored, true);
  assert.deepEqual(listed.entries, []);
});
