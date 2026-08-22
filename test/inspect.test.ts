import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { git } from "../extensions/wiki/lib/git.js";
import { inspectWiki, sourceIsIgnored, verifyPinnedSourcePlan } from "../extensions/wiki/lib/inspect.js";
import { wikiWorkspaceManagement } from "../extensions/wiki/lib/workspace.js";

async function gitRepo(t, name = "repo") {
  const parent = await mkdtemp(path.join(os.tmpdir(), `okf-wiki-inspect-${name}-`));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "main.ts"), "export const ready = true;\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "wiki@test"]);
  await git(root, ["config", "user.name", "Wiki Test"]);
  await git(root, ["add", "."]);
  await git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
  return root;
}

test("sourceIsIgnored covers implicit layout, Java tests, and default noise", () => {
  const source = { path: "." };
  assert.equal(sourceIsIgnored(source, ".okf-wiki/runs/a/run.json", true), true);
  assert.equal(sourceIsIgnored(source, ".env", false), true);
  assert.equal(sourceIsIgnored(source, "services/api/.env.production", false), true);
  assert.equal(sourceIsIgnored(source, ".env.example", false), false);
  assert.equal(sourceIsIgnored(source, "wiki/overview.md", true), true);
  assert.equal(sourceIsIgnored(source, "src/index.ts", true), false);
  assert.equal(sourceIsIgnored(source, "src/test/java/com/acme/OrderServiceTest.java", true), true);
  assert.equal(sourceIsIgnored(source, "module-a/src/test/java/FooTest.java", true), true);
  assert.equal(sourceIsIgnored(source, "src/main/java/com/acme/OrderService.java", true), false);
  assert.equal(sourceIsIgnored(source, "src/test/java/com/acme/OrderServiceTest.java", false), false);
});

test("ignored dirty files do not change the pin fingerprint", async (t) => {
  const root = await gitRepo(t);
  const first = await inspectWiki(root);
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  const second = await inspectWiki(root);
  assert.equal(second.fingerprint, first.fingerprint);
});

test("exclude list changes the pin fingerprint on a clean tree", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-inspect-exclude-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const workspace = await wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace" });
  const source = await gitRepo(t, "api");
  await wikiWorkspaceManagement.addLink({ cwd: workspace.root, localPath: source, name: "api" });
  const first = await inspectWiki(workspace.root);
  const configPath = path.join(workspace.root, "workspace.yaml");
  const document = YAML.parse(await readFile(configPath, "utf8"));
  document.wiki.exclude = ["generated/**"];
  await writeFile(configPath, YAML.stringify(document));
  const second = await inspectWiki(workspace.root);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.deepEqual(second.excludes, ["generated/**"]);
});

test("verifyPinnedSourcePlan uses the pinned ignore set", async (t) => {
  const root = await gitRepo(t);
  const plan = await inspectWiki(root);
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "noise.js"), "noise\n");
  await verifyPinnedSourcePlan(plan);
});
