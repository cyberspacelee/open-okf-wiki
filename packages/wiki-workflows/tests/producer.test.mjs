import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../dist/git.js";
import { writeText } from "../dist/files.js";
import { createProductionWikiProducer } from "../dist/producer.js";
import { parseAgentMarkdown } from "../dist/agents.js";

async function gitRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-run-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "wiki@test"]);
  await git(root, ["config", "user.name", "Wiki Test"]);
  await writeFile(path.join(root, "main.ts"), "export const ready = true;\n");
  await git(root, ["add", "."]);
  await git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
  return root;
}

test("unknown agent names are reported in parseable agent files", () => {
  const parsed = parseAgentMarkdown("---\nname: survey\ndescription: Map a source\n---\nBody\n", "survey.md");
  assert.equal(parsed.name, "survey");
  assert.match(parsed.prompt, /Body/);
});

test("publish installs a valid Candidate as wiki/", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await writeText(path.join(context.candidateRoot, "overview.md"), "---\ntype: overview\ntitle: Overview\n---\n# Overview\n");
      const published = await context.publish();
      assert.equal(published.ok, true);
    },
  });
  const handle = await producer.start({ cwd: root, focus: "runtime" });
  const result = await handle.result();
  assert.ok(result.pages.includes("overview.md"));
  const installed = await readFile(path.join(root, "wiki", "overview.md"), "utf8");
  assert.match(installed, /type: overview/);
  assert.equal((await handle.view()).status, "succeeded");
});

test("resume does not restore Pi sessions", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead() {},
  });
  const handle = await producer.start({ cwd: root });
  await handle.result().catch(() => {});
  await assert.rejects(
    () => handle.control("resume"),
    /Resume does not restore Pi sessions/,
  );
});

test("publish refuses a Candidate that is not OKF", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await writeText(path.join(context.candidateRoot, "overview.md"), "# Overview\n");
      const published = await context.publish();
      assert.equal(published.ok, false);
      assert.match(published.message, /frontmatter|type/);
    },
  });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(() => handle.result(), /frontmatter|type|failed/);
});
