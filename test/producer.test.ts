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

test("live view puts nested tools on the named agent and notifies subscribers", async (t) => {
  const root = await gitRepo(t);
  let gate;
  const wait = new Promise((resolve) => { gate = resolve; });
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await wait;
      context.observe({ id: "lead-1", tool: "read", args: { path: "src/a.ts" }, status: "running" });
      context.note("survey-a", "survey", "map source a", "running");
      context.note("survey-b", "survey", "map source b", "running");
      context.observe({ scope: "survey-a", id: "s1", tool: "grep", args: { pattern: "Order" }, status: "running" });
      context.observe({ scope: "survey-a", id: "s1", tool: "grep", args: { pattern: "Order" }, status: "complete" });
      context.observe({ scope: "survey-b", id: "s2", tool: "ls", args: { path: "frontend" }, status: "running" });
      await writeText(path.join(context.candidateRoot, "overview.md"), "---\ntype: overview\ntitle: Overview\n---\n# Overview\n");
      const published = await context.publish();
      assert.equal(published.ok, true);
    },
  });
  const handle = await producer.start({ cwd: root });
  const views = [];
  const stop = handle.subscribe((view) => views.push(view));
  gate();
  await handle.result();
  stop();
  const live = views.findLast((view) => view.agents?.filter((agent) => agent.agent === "survey").length === 2);
  assert.ok(live);
  const lead = live.agents.find((agent) => agent.agent === "lead");
  const surveys = live.agents.filter((agent) => agent.agent === "survey");
  assert.equal(lead.tools[0].tool, "read");
  assert.equal(surveys.length, 2);
  assert.equal(surveys[0].tools[0].tool, "grep");
  assert.equal(surveys[0].tools[0].status, "complete");
  assert.equal(surveys[1].tools[0].tool, "ls");
  const record = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", handle.id, "run.json"), "utf8"));
  assert.equal(record.agents.length, 2);
  assert.equal(record.agents[0].agent, "survey");
  assert.notEqual(record.agents[0].id, record.agents[1].id);
  assert.equal(record.agents[0].tools, undefined);
});

test("board writes notify subscribers and tool tails stay capped", async (t) => {
  const root = await gitRepo(t);
  let gate;
  const wait = new Promise((resolve) => { gate = resolve; });
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await wait;
      await context.board.write({
        goal: "Auth wiki",
        tasks: [{ id: "write", content: "Write overview", status: "in_progress" }],
      });
      for (let index = 0; index < 20; index += 1) {
        context.observe({ id: `t${index}`, tool: "read", args: { path: `src/${index}.ts` }, status: "complete" });
      }
      context.observe({ id: "live", tool: "grep", args: { pattern: "x" }, status: "running" });
      await writeText(path.join(context.candidateRoot, "overview.md"), "---\ntype: overview\ntitle: Overview\n---\n# Overview\n");
      assert.equal((await context.publish()).ok, true);
    },
  });
  const handle = await producer.start({ cwd: root });
  const views = [];
  handle.subscribe((view) => views.push(view));
  gate();
  await handle.result();
  assert.ok(views.some((view) => view.tasks?.[0]?.id === "write"));
  const capped = views.find((view) => view.agents?.[0]?.tools.some((tool) => tool.id === "live"));
  assert.ok(capped);
  const lead = capped.agents.find((agent) => agent.agent === "lead");
  assert.equal(lead.tools.length, 12);
  assert.ok(lead.tools.some((tool) => tool.id === "live" && tool.status === "running"));
  assert.equal(lead.tools.filter((tool) => tool.status === "running").length, 1);
});

test("unsubscribe stops live view delivery", async (t) => {
  const root = await gitRepo(t);
  let contextReady;
  let release;
  const started = new Promise((resolve) => { contextReady = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const producer = createProductionWikiProducer({
    async runLead(context) {
      contextReady(context);
      await hold;
      await writeText(path.join(context.candidateRoot, "overview.md"), "---\ntype: overview\ntitle: Overview\n---\n# Overview\n");
      assert.equal((await context.publish()).ok, true);
    },
  });
  const handle = await producer.start({ cwd: root });
  const context = await started;
  const views = [];
  let stop;
  await new Promise((resolve) => {
    stop = handle.subscribe((view) => {
      views.push(view);
      resolve(undefined);
    });
  });
  stop();
  const before = views.length;
  context.observe({ id: "1", tool: "ls", args: { path: "." }, status: "running" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(views.length, before);
  release();
  await handle.result();
});
