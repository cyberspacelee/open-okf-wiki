import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiArtifactStore } from "../dist/artifact-store.js";
import { createConfiguredWikiProducer } from "../dist/production-run.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-production-v2-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.ts"), "export const answer = 42;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

const spec = () => ({ pages: ["overview.md", "source/source.md", "source/runtime/domain.md"] });
const markdown = (type, title) => ["---", `type: ${type}`, `title: ${title}`, "description: Runtime", "sources:", "  - id: runtime", "    resource: source/src/index.ts#L1-L1", "---", "", "Runtime.[^runtime]", "", "[^runtime]: [Source](source/src/index.ts#L1-L1)", ""].join("\n");

async function acceptTaxonomy(lead) {
  const discovery = await lead.startNextReadyWave([{ sourceScopeId: "source", instruction: "Survey the pinned Source" }]);
  for (const contract of discovery.contracts) {
    await lead.taskStarted(discovery.batchId, contract.id, { attempt: 1 });
    await lead.taskSettled(discovery.batchId, contract.id, { attempt: 1, receipt: {
      id: contract.id, role: "research", status: "complete", summary: "complete", outputs: [],
      completedAssignmentIds: contract.assignmentIds, needsFollowup: false, followups: [],
      domains: [{ sourceScopeId: contract.sourceScopeIds[0], domainId: "core", conceptIds: [] }],
      coverage: contract.assignmentIds, gaps: [], attempts: 1,
      contractId: contract.contractId, contractDigest: contract.contractDigest,
    } });
  }
  await lead.tasksCollected(discovery.batchId, discovery.contracts.map((contract) => contract.id));
  await lead.saveTaxonomy({
    revision: 1,
    decisions: [{ sourceScopeId: "source", domainId: "runtime", conceptIds: [] }],
    conflictIds: [],
  });
}

async function writeComplete(lead) {
  await acceptTaxonomy(lead);
  await lead.saveSpec(spec());
  await lead.replacePage({ path: "wiki/overview.md", content: markdown("Overview", "Overview"), actor: "lead" });
  await lead.replacePage({ path: "wiki/source/source.md", content: markdown("Source", "API"), actor: "lead" });
  await lead.replacePage({ path: "wiki/source/runtime/domain.md", content: markdown("Domain", "Runtime"), actor: "lead" });
  await acceptDerivedReviews(lead);
}

async function acceptDerivedReviews(lead) {
  let reviews;
  while (true) {
    const wave = await lead.startNextReadyWave();
    if (wave.wave === "review") {
      reviews = wave;
      break;
    }
    if (wave.wave !== "write") throw new Error(`expected write or review, got ${wave.wave}`);
    for (const contract of wave.contracts) {
      await lead.taskStarted(wave.batchId, contract.id, { attempt: 1 });
      await lead.taskSettled(wave.batchId, contract.id, { attempt: 1, receipt: {
        id: contract.id, role: "write", status: "complete", summary: "written", outputs: [], coverage: contract.writePaths, gaps: [], attempts: 1,
        contractId: contract.contractId, contractDigest: contract.contractDigest,
      } });
    }
    await lead.tasksCollected(wave.batchId, wave.contracts.map((contract) => contract.id));
  }
  for (const contract of reviews.contracts) {
    await lead.taskStarted(reviews.batchId, contract.id, { attempt: 1 });
    await lead.taskSettled(reviews.batchId, contract.id, { attempt: 1, receipt: {
      id: contract.id, role: "review", status: "complete", summary: "pass", outputs: [], coverage: contract.reviewPaths, gaps: [], attempts: 1,
      contractId: contract.contractId, contractDigest: contract.contractDigest,
      review: { verdict: "pass", reviewedPaths: contract.reviewPaths, findings: [], profileCoverage: [] },
    } });
  }
}

test("fresh production candidate is completely empty and never reads prior Wiki content", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "wiki", "assets"), { recursive: true });
  await writeFile(path.join(root, "wiki", "old.md"), "old\n");
  await writeFile(path.join(root, "wiki", "log.md"), "old log\n");
  await writeFile(path.join(root, "wiki", "assets", "old.txt"), "old asset\n");
  let entries;
  const producer = createConfiguredWikiProducer({ runLead: async (_lead, { plan }) => {
    entries = await readdir(plan.candidateWikiRoot);
    throw new Error("stop after fresh prepare");
  } });
  await assert.rejects((await producer.start({ cwd: root })).result(), /stop after fresh prepare/);
  assert.deepEqual(entries, []);
  assert.equal(await readFile(path.join(root, "wiki", "old.md"), "utf8"), "old\n");
  assert.equal(await readFile(path.join(root, "wiki", "assets", "old.txt"), "utf8"), "old asset\n");
});

test("invalid full candidate fails deterministic validation and leaves published Wiki untouched", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "wiki"));
  await writeFile(path.join(root, "wiki", "sentinel.md"), "published\n");
  const producer = createConfiguredWikiProducer({ runLead: async (lead) => {
    await acceptTaxonomy(lead);
    await lead.saveSpec(spec());
    await mkdir(path.join(lead.candidateWikiRoot, "runtime"), { recursive: true });
    await writeFile(path.join(lead.candidateWikiRoot, "overview.md"), "# invalid\n");
    await acceptDerivedReviews(lead);
    return { kind: "complete", summary: "invalid" };
  } });
  await assert.rejects((await producer.start({ cwd: root })).result(), /valid target Wiki|missing/i);
  assert.equal(await readFile(path.join(root, "wiki", "sentinel.md"), "utf8"), "published\n");
});

test("initial production plan pins workspace policy and role models", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "api"));
  await writeFile(path.join(root, "api", "index.ts"), "export const api = true;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: path.join(root, "api") });
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1", "language: zh", "defaultSourceIgnores: true", "wiki:", "  maxConcurrentAgents: 5", "  transientRetries: 3",
    "  sessionTimeoutSeconds: 3600", "  maxDelegatedTasks: 40", "  maxDelegateBatches: 10", "  maxTurnsPerSession: 75", "  maxToolCallsPerSession: 220",
    "  models:", "    research:", "      provider: test", "      id: research", "sources:", "  - path: api", "    origin:", "      type: link", `      localPath: ${JSON.stringify(path.join(root, "api"))}`, "",
  ].join("\n"));
  let pinned;
  const model = { provider: "test", id: "research" };
  const producer = createConfiguredWikiProducer({ getModelRegistry: () => ({ find: () => model }), runLead: async (_lead, { plan }) => {
    pinned = plan;
    throw new Error("stop");
  } });
  await assert.rejects((await producer.start({ cwd: root })).result(), /stop/);
  assert.equal(pinned.language, "zh");
  assert.equal(pinned.maxConcurrentAgents, 5);
  assert.equal(pinned.transientRetries, 3);
  assert.equal(pinned.sessionTimeoutMs, 3_600_000);
  assert.deepEqual(pinned.models.research, { provider: "test", id: "research" });
  assert.match(pinned.prompt, /Simplified Chinese/);
  const runDir = path.join(root, ".okf-wiki", "runs", (await producer.list(root))[0].id);
  const disk = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  assert.equal(disk.productionPlan, undefined);
  const plan = JSON.parse(await readFile(path.join(runDir, "plan.json"), "utf8"));
  assert.deepEqual(plan, pinned);
});

test("resume keeps pinned language, models and generation settings after workspace config edits", async (t) => {
  const root = await fixture(t);
  const source = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-pinned-source-"));
  t.after(async () => await rm(source, { recursive: true, force: true }));
  await writeFile(path.join(source, "index.ts"), "export const source = true;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  await symlink(source, path.join(root, "api"), "dir");
  const config = path.join(root, "workspace.yaml");
  await writeFile(config, [
    "version: 1", "language: zh", "defaultSourceIgnores: true", "wiki:", "  models:", "    research:", "      provider: test", "      id: first",
    "  generation:", "    purpose: first", "sources:", "  - path: api", "    origin:", "      type: link", `      localPath: ${JSON.stringify(source)}`, "",
  ].join("\n"));
  let first;
  let calls = 0;
  let activeModel = { provider: "test", id: "active-first" };
  const producer = createConfiguredWikiProducer({ getModel: () => activeModel, getThinkingLevel: () => "high", runLead: async (_lead, { plan }) => {
    calls += 1;
    if (!first) first = structuredClone(plan);
    else {
      const { leadSessionFile, leadSessionAttempt, ...resumed } = plan;
      assert.deepEqual(resumed, first);
    }
    return { kind: "pause", reason: "quota", summary: "wait" };
  } });
  const run = await producer.start({ cwd: root });
  while ((await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  const current = await readFile(config, "utf8");
  await writeFile(config, current.replace("language: zh", "language: en").replace("id: first", "id: second").replace("purpose: first", "purpose: second"));
  activeModel = { provider: "test", id: "active-second" };
  await run.control("resume");
  while (calls < 2 || (await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(first.language, "zh");
  assert.equal(first.models.research.id, "first");
  assert.equal(first.models.lead.id, "active-first");
  assert.equal(first.models.lead.thinkingLevel, "high");
  assert.equal(first.generation.purpose, "first");
});

test("successful publication keeps provenance and run history while removing transient candidate and backup", async (t) => {
  const root = await fixture(t);
  let artifact;
  const producer = createConfiguredWikiProducer({ runLead: async (lead, { record, plan, signal }) => {
    await mkdir(plan.runSessionDirectory, { recursive: true });
    await writeFile(path.join(plan.runSessionDirectory, "lead.jsonl"), "session\n");
    await writeFile(path.join(root, ".okf-wiki", "runs", lead.runId, ".orphan.tmp-1"), "temporary\n");
    artifact = await createWikiArtifactStore({ workspace: root }).write({ runId: lead.runId, contractId: "research", attempt: 1, scope: ["api"], kind: "research-handoff", content: "handoff\n" });
    await writeComplete(lead);
    return { kind: "complete", summary: "done" };
  } });
  const run = await producer.start({ cwd: root });
  const result = await run.result();
  assert.deepEqual(result.pages, ["overview.md", "source/source.md", "source/runtime/domain.md"]);
  const runRoot = path.join(root, ".okf-wiki", "runs", run.id);
  const state = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8"));
  assert.equal(state.status, "succeeded");
  assert.deepEqual(state.publication.pages, result.pages);
  assert.equal(state.publication.sourceFingerprint, result.sourceFingerprint);
  assert.match(state.publication.finalTreeDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(readFile(path.join(runRoot, "candidate", "wiki", "overview.md"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(runRoot, "publish-backup", "overview.md"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(runRoot, "sessions", "lead.jsonl"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(runRoot, "skill", "SKILL.md"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(runRoot, ".orphan.tmp-1"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(runRoot, "publication-finalization.json"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readdir(path.join(runRoot, "publication-preimage")), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(path.join(runRoot, "manifest.json"), "utf8")).artifacts.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")).lead.delegates.batches.length, 5);
  assert.match(await readFile(path.join(root, artifact.relativePath), "utf8"), /handoff/);
  await assert.rejects(readdir(path.join(runRoot, "events")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(runRoot, "activity.jsonl"), "utf8"), { code: "ENOENT" });
  const published = await readFile(path.join(root, "wiki", "overview.md"), "utf8");
  assert.match(published, /generated:/);
  assert.match(published, /verified:/);
});

test("open reconciles an installed publication when the process crashes before terminal Run commit", async (t) => {
  const root = await fixture(t);
  let crashed = false;
  const producer = createConfiguredWikiProducer({
    fault(point) { if (!crashed && point === "afterPublication") { crashed = true; throw new Error("process crash"); } },
    runLead: async (lead, { record, plan, signal }) => { await writeComplete(lead); return { kind: "complete", summary: "recovered" }; },
  });
  const first = await producer.start({ cwd: root });
  const journalFile = path.join(root, ".okf-wiki", "runs", first.id, "publish.json");
  while (true) {
    try { if (JSON.parse(await readFile(journalFile, "utf8")).state === "committed") break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await first.view()).status, "running");
  const recoveredProducer = createConfiguredWikiProducer({ runLead: () => { throw new Error("reconciliation must not regenerate"); } });
  const recovered = await recoveredProducer.open(first.id, root);
  assert.ok(recovered);
  assert.equal((await recovered.view()).status, "succeeded");
  assert.equal((await recovered.result()).summary, "recovered");
  assert.match(await readFile(path.join(root, "wiki", "overview.md"), "utf8"), /verified:/);
});

test("cleanup failure is durable, does not roll back publication, and reopen retries idempotently", async (t) => {
  const root = await fixture(t);
  let failed = false;
  const producer = createConfiguredWikiProducer({
    cleanupPath: async (location) => {
      if (!failed && location.endsWith(`${path.sep}sessions`)) { failed = true; throw new Error("cleanup fault"); }
      await rm(location, { recursive: true, force: true });
    },
    runLead: async (lead, { record, plan, signal }) => {
      await mkdir(plan.runSessionDirectory, { recursive: true });
      await writeFile(path.join(plan.runSessionDirectory, "lead.jsonl"), "session\n");
      await writeComplete(lead);
      return { kind: "complete", summary: "published despite cleanup warning" };
    },
  });
  const run = await producer.start({ cwd: root });
  await run.result();
  const view = await run.view();
  assert.equal(view.status, "succeeded");
  assert.equal(view.warnings?.[0]?.code, "cleanup_failed");
  assert.match(await readFile(path.join(root, "wiki", "overview.md"), "utf8"), /verified:/);
  const sessionFile = path.join(root, ".okf-wiki", "runs", run.id, "sessions", "lead.jsonl");
  assert.equal(await readFile(sessionFile, "utf8"), "session\n");

  const reopened = await createConfiguredWikiProducer({}).open(run.id, root);
  assert.ok(reopened);
  await assert.rejects(readFile(sessionFile, "utf8"), { code: "ENOENT" });
  assert.equal((await reopened.view()).status, "succeeded");
});
