import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../extensions/wiki/lib/git.js";
import { writeText } from "../extensions/wiki/lib/files.js";
import { createProductionWikiProducer } from "../extensions/wiki/lib/producer.js";

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

test("resume continues the same Candidate and Board", async (t) => {
  const root = await gitRepo(t);
  let leads = 0;
  const producer = createProductionWikiProducer({
    async runLead(context) {
      leads += 1;
      if (leads === 1) {
        await context.board.write({
          goal: "Auth wiki",
          tasks: [
            { id: "survey", content: "Survey the source", status: "completed" },
            { id: "write", content: "Write overview", status: "in_progress" },
          ],
        });
        await writeText(path.join(context.candidateRoot, "overview.md"), "# Overview\n");
        return;
      }
      const board = await context.board.read();
      assert.equal(context.resume, true);
      assert.equal(board.goal, "Auth wiki");
      assert.equal(board.tasks[1]?.status, "in_progress");
      assert.match(await readFile(path.join(context.candidateRoot, "overview.md"), "utf8"), /# Overview/);
      await writeText(path.join(context.candidateRoot, "overview.md"), "---\ntype: overview\ntitle: Overview\n---\n# Overview\n");
      const published = await context.publish();
      assert.equal(published.ok, true);
    },
  });
  const handle = await producer.start({ cwd: root, focus: "auth" });
  await handle.result().catch(() => {});
  assert.equal((await handle.view()).status, "failed");
  await handle.control("resume");
  const result = await handle.result();
  assert.equal(leads, 2);
  assert.ok(result.pages.includes("overview.md"));
  assert.equal((await handle.view()).status, "succeeded");
  assert.equal((await handle.view()).goal, "Auth wiki");
});

test("start refuses a paused Run", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await context.board.write({
        goal: "Keep going",
        tasks: [{ id: "1", content: "Survey", status: "in_progress" }],
      });
      await new Promise<void>((_resolve, reject) => {
        if (context.signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }).catch(() => undefined);
    },
  });
  const handle = await producer.start({ cwd: root });
  await handle.control("pause");
  assert.equal((await handle.view()).status, "paused");
  await assert.rejects(() => producer.start({ cwd: root }), /paused; use \/wiki resume/);
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
