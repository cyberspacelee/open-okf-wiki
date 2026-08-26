import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git } from "../extensions/wiki/lib/git.js";
import { exists, writeText } from "../extensions/wiki/lib/files.js";
import { reviewCandidatePages, writeHandoff, taskDigest } from "../extensions/wiki/lib/handoff.js";
import { createProductionWikiProducer } from "../extensions/wiki/lib/producer.js";
import type { WikiLeadContext } from "../extensions/wiki/lib/producer.js";
import { installWikiPublication } from "../extensions/wiki/lib/publication.js";
import { candidateTargetRevision, candidateRevision, fileRevision } from "../extensions/wiki/lib/revisions.js";
import { inspectWiki } from "../extensions/wiki/lib/inspect.js";
import { loadWikiTemplatePack, packagedTemplatesRoot } from "../extensions/wiki/lib/templates.js";
import { createSubagentRuntime } from "../extensions/wiki/lib/subagent.js";
import { RunActivity } from "../extensions/wiki/lib/run-activity.js";
import { wikiWorkspaceManagement } from "../extensions/wiki/lib/workspace.js";

const ACTIVITY_AT = "2026-08-22T00:00:00.000Z";
const SURVEY_RECEIPT = [
  "## Source", "self", "## Domains", "none", "## Concepts", "none",
  "## Cross-Source leads", "none", "## Contract hints", "none",
  "## Tables", "none", "## Survey gaps", "none", "",
].join("\n\n");
const SYNTHESIS_RECEIPT = "## Workspace\n\nworkspace\n\n## Relationships\n\nnone\n\n## End-to-end flows\n\nnone\n\n## Shared contracts\n\nnone\n\n## Gaps\n\nnone\n";
const WRITE_RECEIPT = "## Status\n\ncomplete\n\n## Written\n\nnone\n\n## Rejected hints\n\nnone\n\n## Evidence gaps\n\nnone\n";

function toolEvent(id, tool, args, status, scope) {
  return { kind: "tool", id, at: ACTIVITY_AT, tool, args, status, ...(scope ? { scope } : {}) };
}

function toolActivity(agent) {
  return agent.activity.filter((entry) => entry.kind === "tool");
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function mermaidStub(kind: string): string {
  if (kind === "sequenceDiagram") return "```mermaid\nsequenceDiagram\n  A->>B: call\n```\n";
  if (kind === "classDiagram") return "```mermaid\nclassDiagram\n  class A\n```\n";
  if (kind === "stateDiagram-v2") return "```mermaid\nstateDiagram-v2\n  [*] --> A\n```\n";
  if (kind === "erDiagram") return "```mermaid\nerDiagram\n  A ||--|| B : rel\n```\n";
  return "```mermaid\nflowchart TD\n  A --> B\n```\n";
}

async function writeValidCandidate(candidateRoot: string, sourceResource = "main.ts#L1", repositoryId?: string) {
  const pack = await loadWikiTemplatePack(packagedTemplatesRoot("zh"));
  const writePage = async (relative: string, template: (typeof pack.templates)[number], title: string) => {
    const absolute = path.join(candidateRoot, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    const description = `${title} description.`;
    const sections = template.sections.map(({ title: section }) => {
      const content = template.diagram?.section === section
        ? mermaidStub(template.diagram.kinds[0] ?? "flowchart")
        : template.table?.section === section
          ? `| ${template.table.columns.join(" | ")} |\n| ${template.table.columns.map(() => "---").join(" | ")} |\n| ${section} [^main] | ${template.table.columns.slice(1).map(() => "Evidence").join(" | ")} |\n`
          : `${section} is grounded here. [^main]\n`;
      return `## ${section}\n\n${content}`;
    }).join("\n");
    await writeText(absolute, [
      "---",
      `type: ${template.type}`,
      `title: ${title}`,
      `description: ${description}`,
      "sources:",
      "  - id: main",
      `    resource: ${sourceResource}`,
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
    if (!template.required) continue;
    if (template.scope === "wiki") await writePage(template.filename, template, "Overview");
    else if (template.altitudes) {
      await writePage(template.filename, template, "Architecture");
      if (repositoryId) await writePage(`${repositoryId}/${template.filename}`, template, `${repositoryId} architecture`);
    } else if (template.scope === "domain") {
      await writePage(`${repositoryId ? `${repositoryId}/` : ""}runtime/${template.filename}`, template, "runtime");
    } else if (template.scope === "concept") {
      await writePage(`${repositoryId ? `${repositoryId}/` : ""}runtime/ready/${template.filename}`, template, "ready");
    }
  }
}

async function attestHandoff(context: WikiLeadContext, assignment: {
  id: string;
  agent: string;
  task: string;
  boardTaskId: string;
  partition: string;
  writeMode?: "subtree" | "directory";
}, text: string) {
  const whole = (await candidateRevision(context.candidateRoot)).digest;
  const completed = assignment.agent === "write"
    ? (await candidateTargetRevision(context.candidateRoot, { path: assignment.partition, mode: assignment.writeMode })).digest
    : assignment.agent === "survey" ? undefined : whole;
  const relative = await writeHandoff({
    workspaceRoot: context.plan.workspaceRoot,
    handoffsRoot: path.join(path.dirname(context.candidateRoot), "handoffs"),
    task: assignment,
    text,
    baseCandidateRevision: whole,
    completedCandidateRevision: completed,
  });
  return {
    handoff: relative,
    handoffRevision: await fileRevision(path.join(context.plan.workspaceRoot, ...relative.split("/"))),
    ...(completed ? { candidateRevision: completed } : {}),
  };
}

async function writeReviewPass(context: WikiLeadContext) {
  const checked = await context.check();
  assert.equal(checked.ok, true, checked.message);
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
  await startExecution(context, assignment);
  const pages = reviewCandidatePages((await candidateRevision(context.candidateRoot)).files);
  const coverage = pages.map((page) => `- page: ${page} | result: pass | evidence: main.ts#L1 reopened`).join("\n");
  const attested = await attestHandoff(context, assignment, `verdict: pass\n\n## Coverage\n\n${coverage}\n\n## Repairs\n\nnone\n`);
  await context.record({ ...assignment, status: "complete", ...attested });
}

async function startExecution(context: WikiLeadContext, assignment) {
  await context.record({ ...assignment, status: "queued" });
  await context.record({ ...assignment, status: "running" });
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
      const record = JSON.parse(await readFile(path.join(root, ".okf-wiki", "run", "run.json"), "utf8"));
      assert.ok(Array.isArray(record.executions));
      assert.equal(record.executions.some((entry) => entry.tools), false);
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
  assert.match(rootIndex, /## 系统/);
  assert.match(rootIndex, /## Domain/);
  assert.match(rootIndex, /\[runtime\]\(\.\/runtime\/index\.md\) - runtime description\./);
  assert.equal((await handle.view()).status, "succeeded");
});

test("explicit Workspace publishes repository sections directly under the Source id", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "wiki-run-explicit-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const workspace = await wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace" });
  const source = await gitRepo(t);
  await wikiWorkspaceManagement.addLink({ cwd: workspace.root, localPath: source, name: "my.repo_ui" });
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await writeValidCandidate(context.candidateRoot, "my.repo_ui/main.ts#L1", "my.repo_ui");
      await writeReviewPass(context);
      const published = await context.publish();
      assert.equal(published.ok, true, published.message);
    },
  });

  await (await producer.start({ cwd: workspace.root })).result();
  assert.match(await readFile(path.join(workspace.root, "wiki", "my.repo_ui", "architecture.md"), "utf8"), /my\.repo_ui architecture/);
  assert.match(await readFile(path.join(workspace.root, "wiki", "my.repo_ui", "index.md"), "utf8"), /runtime/);
  await assert.rejects(() => readFile(path.join(workspace.root, "wiki", "repos", "my.repo_ui", "architecture.md"), "utf8"));
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
        const assignment = {
          id: "survey-lost",
          agent: "survey",
          task: "Survey source",
          boardTaskId: "survey",
          partition: "self",
        };
        await startExecution(context, assignment);
        return;
      }
      const board = await context.board.read();
      assert.equal(board.tasks.find((task) => task.id === "survey")?.status, "pending");
      const record = JSON.parse(await readFile(path.join(root, ".okf-wiki", "run", "run.json"), "utf8"));
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
        const assignment = {
          id: "survey-adopt",
          agent: "survey",
          task: "Survey source",
          boardTaskId: "survey",
          partition: "self",
        };
        await startExecution(context, assignment);
        await attestHandoff(context, assignment, SURVEY_RECEIPT);
        return;
      }
      assert.equal((await context.board.read()).tasks[0]?.status, "completed");
      const record = JSON.parse(await readFile(path.join(root, ".okf-wiki", "run", "run.json"), "utf8"));
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

test("resume adopts complete and blocked writer handoffs after sibling targets change", async (t) => {
  const root = await gitRepo(t);
  let leads = 0;
  let handle;
  const producer = createProductionWikiProducer({
    async runLead(context) {
      leads += 1;
      if (leads === 1) {
        await context.board.write({
          goal: "Recover writer",
          tasks: [{ id: "write", content: "Write billing", status: "in_progress" }],
        });
        const assignment = {
          id: "write-adopt",
          agent: "write",
          task: "Write billing",
          boardTaskId: "write",
          partition: "billing",
          writeMode: "subtree",
        };
        await startExecution(context, assignment);
        await mkdir(path.join(context.candidateRoot, "billing"), { recursive: true });
        await writeText(path.join(context.candidateRoot, "billing", "domain.md"), "billing\n");
        await attestHandoff(context, assignment, WRITE_RECEIPT);
        const blocked = {
          ...assignment,
          id: "write-blocked",
          task: "Write orders",
          partition: "orders",
        };
        await startExecution(context, blocked);
        await attestHandoff(context, blocked, "## Status\n\nblocked\n\n## Written\n\nnone\n\n## Rejected hints\n\nnone\n\n## Evidence gaps\n\norders has no source evidence\n");
        await mkdir(path.join(context.candidateRoot, "checkout"), { recursive: true });
        await writeText(path.join(context.candidateRoot, "checkout", "domain.md"), "checkout\n");
        return;
      }
      assert.equal((await context.board.read()).tasks[0]?.status, "pending");
      const record = JSON.parse(await readFile(path.join(root, ".okf-wiki", "run", "run.json"), "utf8"));
      assert.equal(record.executions[0].status, "complete");
      assert.equal(record.executions[1].status, "blocked");
      await rm(context.candidateRoot, { recursive: true, force: true });
      await mkdir(context.candidateRoot, { recursive: true });
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
  const directory = path.join(root, ".okf-wiki", "run");
  const candidateRoot = path.join(directory, "candidate");
  await mkdir(candidateRoot, { recursive: true });
  await writeText(path.join(directory, "board.json"), `${JSON.stringify({
    goal: "Recover crash",
    tasks: [{ id: "survey", content: "Survey source", status: "in_progress" }],
  }, null, 2)}\n`);
  const now = new Date().toISOString();
  await writeText(path.join(directory, "run.json"), `${JSON.stringify({
    schemaVersion: 1,
    id,
    cwd: root,
    status: "running",
    language: "zh",
    createdAt: now,
    updatedAt: now,
    candidateRoot,
    fingerprint: plan.fingerprint,
    plan,
    leadAttempts: [],
    executions: [{
      id: "survey-crash",
      boardTaskId: "survey",
      partition: "self",
      agent: "survey",
      task: "Survey source",
      taskDigest: taskDigest("Survey source"),
      status: "running",
      queuedAt: now,
      startedAt: now,
    }],
  }, null, 2)}\n`);
  const activity = new RunActivity(directory);
  activity.noteAgent("survey-crash", "survey", "Survey source", "running");
  activity.observe({ kind: "input", id: "input-crash", at: ACTIVITY_AT, text: "Survey the Source", scope: "survey-crash" });
  activity.observe({ kind: "output", id: "output-crash", at: ACTIVITY_AT, text: "The Source contains one module.", status: "complete", scope: "survey-crash" });
  activity.observe(toolEvent("tool-crash", "read", { path: "main.ts" }, "complete", "survey-crash"));
  await activity.flush();
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
  const handle = await producer.current(root);
  assert.ok(handle);
  const restored = await handle.view();
  assert.equal(restored.status, "paused");
  assert.equal(restored.tasks?.[0]?.status, "pending");
  const recoveredRecord = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
  assert.equal(recoveredRecord.executions[0].status, "interrupted");
  const restoredSurvey = restored.agents.find((agent) => agent.id === "survey-crash");
  assert.ok(restoredSurvey);
  assert.deepEqual(restoredSurvey.activity.map((entry) => entry.kind), ["input", "output", "tool"]);
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
  await assert.rejects(() => handle.result(), /paused/);
});

test("concurrent starts admit only one current Run", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await waitForAbort(context.signal);
    },
  });
  const attempts = await Promise.allSettled([
    producer.start({ cwd: root }),
    producer.start({ cwd: root }),
  ]);
  const accepted = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof producer.start>>> => result.status === "fulfilled");
  const rejected = attempts.filter((result) => result.status === "rejected");
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  await accepted[0]!.value.control("cancel");
});

test("successful Runs are terminal and leave no historical Run directory", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
      assert.equal((await context.publish()).ok, true);
    },
  });
  const handle = await producer.start({ cwd: root });
  await handle.result();
  assert.equal(await producer.current(root), undefined);
  assert.equal(await exists(path.join(root, ".okf-wiki", "run")), false);
  await assert.rejects(() => handle.control("pause"), /Cannot pause a succeeded/);
});

test("current reconciles a publication interrupted after Candidate install", async (t) => {
  const root = await gitRepo(t);
  await mkdir(path.join(root, "wiki"));
  await writeFile(path.join(root, "wiki", "old.md"), "old\n");
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await writeValidCandidate(context.candidateRoot);
      await writeReviewPass(context);
      throw new Error("stop before publication");
    },
  });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(() => handle.result(), /stop before publication/);
  await assert.rejects(() => installWikiPublication(root, path.join(root, ".okf-wiki", "run", "candidate"), {
    fault(phase) { if (phase === "candidate_installed") throw new Error("simulated publication crash"); },
  }), /simulated publication crash/);

  assert.equal(await producer.current(root), undefined);
  assert.equal(await exists(path.join(root, ".okf-wiki", "run")), false);
  assert.equal(await exists(path.join(root, "wiki", "old.md")), false);
  assert.equal(await exists(path.join(root, "wiki", "overview.md")), true);
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
        await waitForAbort(context.signal);
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
      assert.match(checked.message, /Suggested action/);
      assert.match(published.message, /frontmatter|type/);
    },
  });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(() => handle.result(), /frontmatter|type|failed/);
});

test("Run exposes only Catalogs bound by pinned Sources", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "wiki-run-bound-catalogs-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const workspace = await wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace" });
  const source = await gitRepo(t);
  const config = await readFile(workspace.configPath, "utf8");
  await writeFile(workspace.configPath, config.replace("sources: []", [
    "catalogs:",
    "  shared:",
    "    url: postgresql://shared@localhost/app",
    "  unused:",
    "    url: postgresql://unused@localhost/app",
    "sources: []",
  ].join("\n")));
  await wikiWorkspaceManagement.addLink({ cwd: workspace.root, localPath: source, name: "api", catalog: "shared" });
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const producer = createProductionWikiProducer({
    async runLead(context) {
      assert.deepEqual([...context.catalogs.keys()], ["shared"]);
      ready();
      await waitForAbort(context.signal);
    },
  });
  const handle = await producer.start({ cwd: workspace.root });
  await started;
  await handle.control("cancel");
});

test("multi-Source checks require survey fan-in followed by synthesis", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "wiki-run-multi-source-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const workspace = await wikiWorkspaceManagement.init({ cwd: parent, workspace: "workspace" });
  const api = await gitRepo(t);
  const web = await gitRepo(t);
  await wikiWorkspaceManagement.addLink({ cwd: workspace.root, localPath: api, name: "api" });
  await wikiWorkspaceManagement.addLink({ cwd: workspace.root, localPath: web, name: "web" });
  let checked = false;
  let synthesisPrompt = "";
  let synthesisCheckpoint = "";
  let surveyHandoffs: string[] = [];
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await context.board.write({
        goal: "Check multi-Source workflow",
        tasks: [{ id: "survey", content: "Survey every Source", status: "in_progress" }],
      });
      const runtime = await createSubagentRuntime(
        context.plan,
        context.candidateRoot,
        {
          async createSession(options) {
            let listener = (_event: unknown) => {};
            const system = options.resourceLoader.getAppendSystemPrompt().join("\n");
            const output = system.includes("Analyze one explicit Workspace") ? SYNTHESIS_RECEIPT : SURVEY_RECEIPT;
            return {
              session: {
                sessionFile: undefined,
                subscribe(next) { listener = next; return () => {}; },
                async prompt(value) {
                  if (value.includes("# Required handoffs")) {
                    synthesisPrompt = value;
                    const manifest = /manifest at `([^`]+)`/.exec(value)?.[1];
                    assert.ok(manifest);
                    for (const location of [manifest, ...surveyHandoffs]) {
                      listener({ type: "tool_execution_start", toolCallId: `read-${location}`, toolName: "read", args: { path: location } });
                      listener({ type: "tool_execution_end", toolCallId: `read-${location}`, toolName: "read", result: {}, isError: false });
                    }
                    listener({ type: "compaction_end", aborted: false, result: {} });
                  }
                },
                async waitForIdle() {},
                getLastAssistantText() { return output; },
                async sendCustomMessage(message) { synthesisCheckpoint = message.content; },
                dispose() {},
                abort() {},
              },
              modelFallbackMessage: undefined,
            };
          },
        },
        undefined,
        (update) => context.record(update),
        undefined,
        {
          templates: context.templates,
          assertDispatch: context.assertDispatch,
          handoffsForTask: () => surveyHandoffs,
        },
      );
      await assert.rejects(
        () => runtime.run([{ agent: "write", task: "Write api", boardTaskId: "survey", partition: "api", writeMode: "directory" }], context.signal),
        /requires one completed synthesize execution/,
      );
      const surveyResults = await runtime.run([
        { agent: "survey", task: "Survey api", boardTaskId: "survey", partition: "api" },
        { agent: "survey", task: "Survey web", boardTaskId: "survey", partition: "web" },
      ], context.signal);
      surveyHandoffs = surveyResults.map((entry) => entry.handoff!);
      const checkedBefore = await context.check();
      assert.equal(checkedBefore.ok, false);
      assert.doesNotMatch(checkedBefore.message, /synthesize execution|completed surveys/);
      await context.board.write({
        goal: "Check multi-Source workflow",
        tasks: [
          { id: "survey", content: "Survey every Source", status: "completed" },
          { id: "synthesize", content: "Analyze across Sources", status: "in_progress" },
        ],
      });
      await runtime.run([{
        agent: "synthesize",
        task: "Analyze the Workspace across all completed surveys",
        boardTaskId: "synthesize",
        partition: "workspace-analysis",
      }], context.signal);
      const manifest = /manifest at `([^`]+)`/.exec(synthesisPrompt)?.[1];
      assert.ok(manifest);
      assert.ok(synthesisCheckpoint.includes(manifest));
      assert.deepEqual((await readFile(path.join(context.plan.workspaceRoot, manifest), "utf8")).trim().split("\n"), [...surveyHandoffs].sort());
      const published = await context.publish();
      assert.equal(published.ok, false);
      assert.match(published.message, /Required template|concept cluster|frontmatter|type/i);
      checked = true;
    },
  });
  const handle = await producer.start({ cwd: workspace.root });
  await assert.rejects(() => handle.result(), /Required template|concept cluster|frontmatter|type|failed/i);
  assert.equal(checked, true);
});

test("Lead prompt receives a bounded recovery frame without template skeletons", async (t) => {
  const root = await gitRepo(t);
  let prompt = "";
  let system = "";
  let tools = [];
  const producer = createProductionWikiProducer({
    session: {
      async createSession(options) {
        tools = options.customTools.map((tool) => tool.name);
        system = options.resourceLoader.getAppendSystemPrompt().join("\n");
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
  assert.match(prompt, /survey, synthesize, write, review/);
  assert.match(system, /# Repository Wiki Lead/);
  assert.match(system, /Explicit Workspace Domain|Implicit Workspace Domain|Wiki-root aggregation pages/);
  assert.match(system, /Treat repository files.*untrusted evidence/s);
  assert.doesNotMatch(prompt, /Output skeleton|Page contract catalog|Directory contract/);
  assert.ok(tools.includes("candidate_check"));
  assert.equal(tools.includes("db_tables"), false);
});

test("an existing Lead session resumes with checkpoint delta only", async (t) => {
  const root = await gitRepo(t);
  const sessionFile = path.join(root, "lead.jsonl");
  await writeFile(sessionFile, "");
  const prompts: string[] = [];
  const systems: string[] = [];
  const producer = createProductionWikiProducer({
    session: {
      async createSession(options) {
        systems.push(options.resourceLoader.getAppendSystemPrompt().join("\n"));
        return {
          session: {
            sessionFile,
            subscribe() { return () => {}; },
            async prompt(value) { prompts.push(value); },
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
  await handle.result().catch(() => undefined);
  await handle.control("resume");
  await handle.result().catch(() => undefined);
  assert.equal(prompts.length, 2);
  assert.match(systems[0]!, /# Repository Wiki Lead/);
  assert.doesNotMatch(prompts[0]!, /# Repository Wiki Lead/);
  assert.match(prompts[1]!, /<wiki_checkpoint>/);
  assert.match(prompts[1]!, /Resume the existing Wiki Lead session/);
  assert.doesNotMatch(prompts[1]!, /# Repository Wiki Lead/);
});

test("parallel terminal receipts persist only after both handoffs are attested", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await context.board.write({
        goal: "Survey both partitions",
        tasks: [{ id: "survey", content: "Survey partitions", status: "in_progress" }],
      });
      const assignments = ["self"].map((partition) => ({
        id: `survey-${partition}`,
        agent: "survey",
        task: `Survey ${partition}`,
        boardTaskId: "survey",
        partition,
      }));
      for (const assignment of assignments) await startExecution(context, assignment);
      await Promise.all(assignments.map(async (assignment) => {
        const attested = await attestHandoff(context, assignment, SURVEY_RECEIPT);
        await context.record({ ...assignment, status: "complete", ...attested });
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

test("failed executions persist a typed diagnostic artifact", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await context.board.write({
        goal: "Record worker failure",
        tasks: [{ id: "write", content: "Write billing", status: "in_progress" }],
      });
      const assignment = {
        id: "write-failed",
        agent: "write",
        task: "Write billing",
        boardTaskId: "write",
        partition: "billing",
        writeMode: "subtree",
      };
      await startExecution(context, assignment);
      await context.record({
        ...assignment,
        status: "failed",
        error: "Writer completion repair made no progress",
        terminalReason: "completion_no_progress",
      });
      await context.board.write({
        goal: "Record worker failure",
        tasks: [
          { id: "write", content: "Write billing", status: "failed" },
          { id: "write-invalid", content: "Write invalid handoff", status: "in_progress" },
        ],
      });
      const invalid = {
        id: "write-invalid",
        agent: "write",
        task: "Write invalid handoff",
        boardTaskId: "write-invalid",
        partition: "orders",
        writeMode: "subtree" as const,
      };
      await startExecution(context, invalid);
      await context.record({ ...invalid, status: "complete" });
    },
  });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(() => handle.result());
  const record = JSON.parse(await readFile(path.join(root, ".okf-wiki", "run", "run.json"), "utf8"));
  const [receipt, invalid] = record.executions;
  assert.equal(receipt.terminalReason, "completion_no_progress");
  assert.match(receipt.diagnostic.path, /write-failed\.diagnostic\.json$/);
  const diagnostic = JSON.parse(await readFile(path.join(root, ...receipt.diagnostic.path.split("/")), "utf8"));
  assert.equal(diagnostic.terminalReason, "completion_no_progress");
  assert.match(diagnostic.error, /no progress/);
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.terminalReason, "invalid_handoff");
  assert.match(invalid.diagnostic.path, /write-invalid\.diagnostic\.json$/);
});

test("parallel disjoint write receipts are not invalidated by sibling writes", async (t) => {
  const root = await gitRepo(t);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await context.board.write({
        goal: "Write disjoint partitions",
        tasks: [{ id: "write", content: "Write both partitions", status: "in_progress" }],
      });
      const assignments = ["billing", "checkout"].map((partition) => ({
        id: `write-${partition}`,
        agent: "write",
        task: `Write ${partition}`,
        boardTaskId: "write",
        partition,
        writeMode: "subtree",
      }));
      for (const assignment of assignments) await startExecution(context, assignment);

      await mkdir(path.join(context.candidateRoot, "billing"), { recursive: true });
      await writeText(path.join(context.candidateRoot, "billing", "domain.md"), "billing\n");
      await mkdir(path.join(context.candidateRoot, "checkout"), { recursive: true });
      await writeText(path.join(context.candidateRoot, "checkout", "domain.md"), "checkout\n");

      for (const assignment of assignments) {
        const attested = await attestHandoff(context, assignment, WRITE_RECEIPT);
        await context.record({ ...assignment, status: "complete", ...attested });
      }
      const record = JSON.parse(await readFile(path.join(path.dirname(context.candidateRoot), "run.json"), "utf8"));
      assert.equal(record.executions.every((entry) => entry.status === "complete"), true);

      await rm(context.candidateRoot, { recursive: true, force: true });
      await mkdir(context.candidateRoot, { recursive: true });
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
      context.observe(toolEvent("lead-1", "read", { path: "src/a.ts" }, "running"));
      context.note("survey-a", "survey", "map source a", "running");
      context.note("survey-b", "survey", "map source b", "running");
      context.observe(toolEvent("s1", "grep", { pattern: "Order" }, "running", "survey-a"));
      context.observe(toolEvent("s1", "grep", { pattern: "Order" }, "complete", "survey-a"));
      context.observe(toolEvent("s2", "ls", { path: "frontend" }, "running", "survey-b"));
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
  assert.equal(toolActivity(lead)[0].tool, "read");
  assert.equal(surveys.length, 2);
  assert.equal(toolActivity(surveys[0])[0].tool, "grep");
  assert.equal(toolActivity(surveys[0])[0].status, "complete");
  assert.equal(toolActivity(surveys[1])[0].tool, "ls");
});

test("board writes notify subscribers and complete tool history is retained", async (t) => {
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
        context.observe(toolEvent(`t${index}`, "read", { path: `src/${index}.ts` }, "complete"));
      }
      context.observe(toolEvent("live", "grep", { pattern: "x" }, "running"));
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
  const complete = views.find((view) => view.agents?.[0]?.activity.some((entry) => entry.id === "live"));
  assert.ok(complete);
  const lead = complete.agents.find((agent) => agent.agent === "lead");
  const tools = toolActivity(lead);
  assert.equal(tools.length, 21);
  assert.ok(tools.some((tool) => tool.id === "t0"));
  assert.ok(tools.some((tool) => tool.id === "live" && tool.status === "running"));
  assert.equal(tools.filter((tool) => tool.status === "running").length, 1);
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
  context.observe(toolEvent("1", "ls", { path: "." }, "running"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(views.length, before);
  release();
  await handle.result();
});

test("starting the current layout ignores legacy Run history", async (t) => {
  const root = await gitRepo(t);
  const directory = path.join(root, ".okf-wiki", "runs", "oldrun01");
  await mkdir(path.join(directory, "candidate"), { recursive: true });
  await writeText(path.join(directory, "run.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "oldrun01",
    cwd: root,
    status: "paused",
    language: "zh",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateRoot: path.join(directory, "candidate"),
    fingerprint: "x",
    leadAttempts: [],
    executions: [],
  }, null, 2)}\n`);
  const producer = createProductionWikiProducer({
    async runLead(context) {
      await waitForAbort(context.signal);
    },
  });
  const handle = await producer.start({ cwd: root });
  assert.equal(await exists(path.join(root, ".okf-wiki", "runs")), true);
  await handle.control("cancel");
});

test("current deletes a Run record with malformed nested receipts", async (t) => {
  const root = await gitRepo(t);
  const plan = await inspectWiki(root);
  const directory = path.join(root, ".okf-wiki", "run");
  const candidateRoot = path.join(directory, "candidate");
  await mkdir(candidateRoot, { recursive: true });
  const now = new Date().toISOString();
  await writeText(path.join(directory, "run.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "broken01",
    cwd: root,
    status: "failed",
    language: "zh",
    createdAt: now,
    updatedAt: now,
    candidateRoot,
    fingerprint: plan.fingerprint,
    plan,
    leadAttempts: [],
    executions: [{ status: "complete" }],
  }, null, 2)}\n`);

  const producer = createProductionWikiProducer();
  assert.equal(await producer.current(root), undefined);
  assert.equal(await exists(directory), false);
});

test("resume does not adopt a handoff without an envelope", async (t) => {
  const root = await gitRepo(t);
  let leads = 0;
  const producer = createProductionWikiProducer({
    async runLead(context) {
      leads += 1;
      if (leads === 1) {
        await context.board.write({
          goal: "Reject bare handoff",
          tasks: [{ id: "survey", content: "Survey source", status: "in_progress" }],
        });
        const assignment = {
          id: "survey-bare",
          agent: "survey",
          task: "Survey source",
          boardTaskId: "survey",
          partition: "self",
        };
        await startExecution(context, assignment);
        const location = path.join(path.dirname(context.candidateRoot), "handoffs", "survey-bare.md");
        await mkdir(path.dirname(location), { recursive: true });
        await writeText(location, "complete without envelope\n");
        return;
      }
      const record = JSON.parse(await readFile(path.join(root, ".okf-wiki", "run", "run.json"), "utf8"));
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
