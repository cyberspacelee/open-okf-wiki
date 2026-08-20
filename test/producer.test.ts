import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../extensions/wiki/lib/git.js";
import { writeText } from "../extensions/wiki/lib/files.js";
import { createProductionWikiProducer } from "../extensions/wiki/lib/producer.js";
import type { WikiLeadContext } from "../extensions/wiki/lib/producer.js";
import { candidateRevision, fileRevision } from "../extensions/wiki/lib/revisions.js";
import { inspectWiki } from "../extensions/wiki/lib/inspect.js";
import { loadWikiTemplatePack, packagedTemplatesRoot } from "../extensions/wiki/lib/templates.js";

function mermaidStub(kind: string): string {
  if (kind === "sequenceDiagram") return "```mermaid\nsequenceDiagram\n  A->>B: call\n```\n";
  if (kind === "classDiagram") return "```mermaid\nclassDiagram\n  class A\n```\n";
  if (kind === "stateDiagram-v2") return "```mermaid\nstateDiagram-v2\n  [*] --> A\n```\n";
  if (kind === "erDiagram") return "```mermaid\nerDiagram\n  A ||--|| B : rel\n```\n";
  return "```mermaid\nflowchart TD\n  A --> B\n```\n";
}

async function writeValidCandidate(candidateRoot: string, sourceId = "source") {
  const pack = await loadWikiTemplatePack(packagedTemplatesRoot("zh"));
  const writePage = async (relative: string, template: (typeof pack.templates)[number], title: string) => {
    const absolute = path.join(candidateRoot, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    const description = `${title} description.`;
    const sections = template.sections.map((section, index) => {
      const diagram = template.diagram?.length && index === template.sections.length - 1
        ? mermaidStub(template.diagram[0]!)
        : `${section} is grounded here. [^main]\n`;
      return `## ${section}\n\n${diagram}`;
    }).join("\n");
    await writeText(absolute, [
      "---",
      `type: ${template.type}`,
      `title: ${title}`,
      `description: ${description}`,
      "sources:",
      "  - id: main",
      `    resource: ${sourceId}/main.ts#L1`,
      "    title: main",
      "---",
      `# ${title}`,
      "",
      description,
      "",
      sections,
      "[^main]: main",
      "",
    ].join("\n"));
  };
  for (const template of pack.templates) {
    if (template.optional) continue;
    if (template.scope === "wiki") await writePage(template.file, template, "Overview");
    else if (template.scope === "source") await writePage(`${sourceId}/${template.file}`, template, sourceId);
    else if (template.scope === "domain") await writePage(`${sourceId}/runtime/${template.file}`, template, "runtime");
    else await writePage(`${sourceId}/runtime/ready/${template.file}`, template, "ready");
  }
}

async function writeReviewPass(context: WikiLeadContext) {
  const current = await context.board.read();
  await context.board.write({
    goal: current.goal,
    tasks: [
      ...current.tasks
        .filter((task) => task.id !== "review-test")
        .map((task) => ({ ...task, status: task.status === "in_progress" ? "completed" as const : task.status })),
      { id: "review-test", content: "Review current Candidate", status: "in_progress" },
    ],
  });
  const assignment = {
    id: "review-test",
    agent: "review",
    task: "Review current Candidate",
    boardTaskId: "review-test",
    partition: "candidate",
  };
  await context.record({ ...assignment, status: "running" });
  const handoffs = path.join(path.dirname(context.candidateRoot), "handoffs");
  await mkdir(handoffs, { recursive: true });
  const handoff = path.join(handoffs, "review-test.md");
  await writeText(handoff, "verdict: pass\n");
  await context.record({
    ...assignment,
    status: "complete",
    text: "verdict: pass\n",
    handoff: path.relative(context.plan.workspaceRoot, handoff).replaceAll("\\", "/"),
    handoffRevision: await fileRevision(handoff),
    candidateRevision: (await candidateRevision(context.candidateRoot)).digest,
  });
}

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
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
      const published = await context.publish();
      assert.equal(published.ok, true, published.message);
    },
  });
  const handle = await producer.start({ cwd: root, focus: "runtime" });
  const result = await handle.result();
  assert.ok(result.pages.includes("overview.md"));
  const installed = await readFile(path.join(root, "wiki", "overview.md"), "utf8");
  assert.match(installed, /type: Overview/);
  assert.match(installed, /verified:/);
  const rootIndex = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  assert.match(rootIndex, /## 目录/);
  assert.match(rootIndex, /\[source\]\(\.\/source\/index\.md\) - source description\./);
  const sourceIndex = await readFile(path.join(root, "wiki", "source", "index.md"), "utf8");
  assert.match(sourceIndex, /\[runtime\]\(\.\/runtime\/index\.md\) - runtime description\./);
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
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
      const published = await context.publish();
      assert.equal(published.ok, true, published.message);
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

test("resume turns an unacknowledged execution into retryable durable state", async (t) => {
  const root = await gitRepo(t);
  let leads = 0;
  const producer = createProductionWikiProducer({
    async runLead(context) {
      leads += 1;
      if (leads === 1) {
        await context.board.write({
          goal: "Recover survey",
          tasks: [{ id: "survey", content: "Survey source", status: "in_progress" }],
        });
        await context.record({
          id: "survey-lost",
          agent: "survey",
          task: "Survey source",
          boardTaskId: "survey",
          partition: "source",
          status: "running",
        });
        return;
      }
      const board = await context.board.read();
      assert.equal(board.tasks.find((task) => task.id === "survey")?.status, "pending");
      const record = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", handle.id, "run.json"), "utf8"));
      assert.equal(record.executions[0].status, "interrupted");
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
      assert.equal((await context.publish()).ok, true);
    },
  });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(() => handle.result(), /running|failed/);
  await handle.control("resume");
  await handle.result();
  assert.equal(leads, 2);
});

test("resume adopts an exact handoff written before the terminal receipt", async (t) => {
  const root = await gitRepo(t);
  let leads = 0;
  let handle;
  const producer = createProductionWikiProducer({
    async runLead(context) {
      leads += 1;
      if (leads === 1) {
        await context.board.write({
          goal: "Adopt survey",
          tasks: [{ id: "survey", content: "Survey source", status: "in_progress" }],
        });
        const task = "Survey source";
        await context.record({
          id: "survey-adopt",
          agent: "survey",
          task,
          boardTaskId: "survey",
          partition: "source",
          status: "running",
        });
        const metadata = {
          executionId: "survey-adopt",
          boardTaskId: "survey",
          partition: "source",
          agent: "survey",
          taskDigest: createHash("sha256").update(task).digest("hex"),
          baseCandidateRevision: (await candidateRevision(context.candidateRoot)).digest,
        };
        const location = path.join(path.dirname(context.candidateRoot), "handoffs", "survey-adopt.md");
        await mkdir(path.dirname(location), { recursive: true });
        await writeText(location, `<!-- wiki-handoff ${JSON.stringify(metadata)} -->\n# survey handoff\n\ncomplete\n`);
        return;
      }
      assert.equal((await context.board.read()).tasks[0]?.status, "completed");
      const record = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", handle.id, "run.json"), "utf8"));
      assert.equal(record.executions[0].status, "complete");
      assert.match(record.executions[0].handoff.path, /survey-adopt\.md$/);
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
      assert.equal((await context.publish()).ok, true);
    },
  });
  handle = await producer.start({ cwd: root });
  await assert.rejects(() => handle.result(), /running|failed/);
  await handle.control("resume");
  await handle.result();
  assert.equal(leads, 2);
});

test("a reopened process-crash Run reconciles persisted running receipts", async (t) => {
  const root = await gitRepo(t);
  const plan = await inspectWiki(root);
  const id = "crash001";
  const directory = path.join(root, ".okf-wiki", "runs", id);
  const candidateRoot = path.join(directory, "candidate");
  await mkdir(candidateRoot, { recursive: true });
  await writeText(path.join(directory, "board.json"), `${JSON.stringify({
    goal: "Recover crash",
    tasks: [{ id: "survey", content: "Survey source", status: "in_progress" }],
  }, null, 2)}\n`);
  const now = new Date().toISOString();
  await writeText(path.join(directory, "run.json"), `${JSON.stringify({
    schemaVersion: 2,
    id,
    cwd: root,
    status: "running",
    language: "zh",
    objective: "Recover crash",
    createdAt: now,
    updatedAt: now,
    candidateRoot,
    fingerprint: plan.fingerprint,
    executions: [{
      id: "survey-crash",
      boardTaskId: "survey",
      partition: "source",
      agent: "survey",
      task: "Survey source",
      taskDigest: createHash("sha256").update("Survey source").digest("hex"),
      status: "running",
      sourceFingerprint: plan.fingerprint,
      startedAt: now,
    }],
  }, null, 2)}\n`);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      assert.equal((await context.board.read()).tasks[0]?.status, "pending");
      const record = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
      assert.equal(record.executions[0].status, "interrupted");
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
      assert.equal((await context.publish()).ok, true);
    },
  });
  const handle = await producer.open(id, root);
  assert.ok(handle);
  await handle.control("resume");
  await handle.result();
  assert.equal((await handle.view()).status, "succeeded");
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

test("resume waits for the paused Lead generation to finish", async (t) => {
  const root = await gitRepo(t);
  let calls = 0;
  let oldFinished = false;
  let announce;
  const ready = new Promise((resolve) => { announce = resolve; });
  const producer = createProductionWikiProducer({
    async runLead(context) {
      calls += 1;
      if (calls === 1) {
        announce();
        await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        oldFinished = true;
        return;
      }
      assert.equal(oldFinished, true);
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
      assert.equal((await context.publish()).ok, true);
    },
  });
  const handle = await producer.start({ cwd: root });
  await ready;
  await handle.control("pause");
  await handle.control("resume");
  await handle.result();
  assert.equal(calls, 2);
});

test("publish refuses a valid Candidate without a review pass", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await writeValidCandidate(context.candidateRoot);
      const published = await context.publish();
      assert.equal(published.ok, false);
      assert.match(published.message, /Review is required/);
    },
  });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(() => handle.result(), /Review is required|failed/);
});

test("publish rejects a review whose Candidate digest is stale", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
      await writeFile(path.join(context.candidateRoot, "overview.md"), `${await readFile(path.join(context.candidateRoot, "overview.md"), "utf8")}\nCurrent note.\n`);
      const published = await context.publish();
      assert.equal(published.ok, false);
      assert.match(published.message, /stale/);
    },
  });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(() => handle.result(), /stale|failed/);
});

test("candidate_check and publish share deterministic diagnostics", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await writeText(path.join(context.candidateRoot, "overview.md"), "# Overview\n");
      const checked = await context.check();
      const published = await context.publish();
      assert.equal(checked.ok, false);
      assert.equal(published.ok, false);
      assert.match(checked.message, /frontmatter|type/);
      assert.match(published.message, /frontmatter|type/);
    },
  });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(() => handle.result(), /frontmatter|type|failed/);
});

test("Lead prompt receives a bounded recovery frame without template skeletons", async (t) => {
  const root = await gitRepo(t);
  let prompt = "";
  let tools = [];
  const producer = createProductionWikiProducer({
    session: {
      async createSession(options) {
        tools = options.customTools.map((tool) => tool.name);
        return {
          session: {
            sessionFile: undefined,
            subscribe() { return () => {}; },
            async prompt(value) { prompt = value; },
            async waitForIdle() {},
            getLastAssistantText() { return ""; },
            dispose() {},
            abort() {},
          },
          modelFallbackMessage: undefined,
        };
      },
    },
  });
  const handle = await producer.start({ cwd: root, focus: "runtime" });
  await assert.rejects(() => handle.result());
  assert.match(prompt, /<wiki_checkpoint>/);
  assert.match(prompt, /Goal: runtime/);
  assert.doesNotMatch(prompt, /Skeleton:|Page template catalog/);
  assert.ok(tools.includes("candidate_check"));
  assert.equal(tools.includes("db_tables"), false);
});

test("parallel terminal receipts persist only after both handoffs are attested", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await context.board.write({
        goal: "Survey both partitions",
        tasks: [{ id: "survey", content: "Survey partitions", status: "in_progress" }],
      });
      const assignments = ["a", "b"].map((partition) => ({
        id: `survey-${partition}`,
        agent: "survey",
        task: `Survey ${partition}`,
        boardTaskId: "survey",
        partition,
      }));
      for (const assignment of assignments) await context.record({ ...assignment, status: "running" });
      const handoffs = path.join(path.dirname(context.candidateRoot), "handoffs");
      await mkdir(handoffs, { recursive: true });
      await Promise.all(assignments.map(async (assignment) => {
        const location = path.join(handoffs, `${assignment.id}.md`);
        await writeText(location, `${assignment.partition}\n`);
        await context.record({
          ...assignment,
          status: "complete",
          text: assignment.partition,
          handoff: path.relative(root, location).replaceAll("\\", "/"),
          handoffRevision: await fileRevision(location),
        });
      }));
      const record = JSON.parse(await readFile(path.join(path.dirname(context.candidateRoot), "run.json"), "utf8"));
      assert.equal(record.executions.every((entry) => entry.status === "complete" && entry.handoff?.sha256), true);
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
      assert.equal((await context.publish()).ok, true);
    },
  });
  await (await producer.start({ cwd: root })).result();
});

test("publish refuses a single overview page", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await writeText(path.join(context.candidateRoot, "overview.md"), "---\ntype: overview\ntitle: Overview\n---\n# Overview\n");
      const published = await context.publish();
      assert.equal(published.ok, false);
      assert.match(published.message, /template|concept cluster/i);
    },
  });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(() => handle.result(), /template|concept cluster|failed/i);
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
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
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
  assert.ok(Array.isArray(record.executions));
  assert.equal(record.executions.some((entry) => entry.tools), false);
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
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
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
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
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
