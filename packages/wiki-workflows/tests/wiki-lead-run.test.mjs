import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { WikiCandidateCorruptionError, WikiLeadRun } from "../dist/lead.js";
import { verifyWikiPublicationSeal } from "../dist/wiki-publication-seal.js";

const policy = { templates: { requiredSections: [] }, review: { mustCover: [] } };

const spec = { pages: ["overview.md", "source/source.md", "source/core/domain.md"] };

function content(type, title, suffix = "") {
  return ["---", `type: ${type}`, `title: ${title}`, "description: Runtime behavior", "sources:", "  - id: source-a", "    resource: source/a.ts#L1-L1", "---", "", `Runtime behavior${suffix}.[^source-a]`, "", "[^source-a]: [Source](source/a.ts#L1-L1)", ""].join("\n");
}

function sourcePlan(root) {
  const source = path.join(root, "source");
  return {
    workspaceRoot: root, workspaceRealPath: root, configPath: path.join(root, "workspace.yaml"), defaultSourceIgnores: true, excludes: [], fingerprint: "a".repeat(64),
    sources: [{ scopeId: "source", logicalPath: "source", absolutePath: source, realPath: source, repositoryRoot: source, repositoryIdentity: "source", head: "0".repeat(40), dirtyFingerprint: "b".repeat(64) }],
  };
}

function memoryLead() {
  let facts;
  return {
    commitLead: async (next) => { facts = structuredClone(next); },
    readLead: async () => facts,
    snapshot: () => facts,
    replace(next) { facts = next; },
  };
}

async function fixture(t, fault, finalizeFault, planned = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-lead-run-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "source"));
  await writeFile(path.join(root, "source", "a.ts"), "export const a = true;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: path.join(root, "source") });
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1", "language: en", "defaultSourceIgnores: true", "wiki:", "  exclude: []",
    "sources:", "  - path: source", "    origin:", "      type: link", `      localPath: ${JSON.stringify(path.join(root, "source"))}`, "",
  ].join("\n"));
  const candidate = path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki");
  const fence = createFence("execution-1");
  const persist = memoryLead();
  const run = await WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, fault, finalizeFault, allowedSourceScopeIds: ["source"], ...fence, ...persist });
  if (!planned) return { root, candidate, run, fence, persist };
  const discovery = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Survey the pinned Source" }]);
  await settleResearchWave(run, discovery);
  await run.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source", domainId: "core", conceptIds: [] }], conflictIds: [] });
  await run.saveSpec(spec);
  return { root, candidate, run, fence, persist };
}

async function settleResearchWave(run, wave) {
  for (const contract of wave.contracts) {
    await run.taskStarted(wave.batchId, contract.id, { attempt: 1 });
    await run.taskSettled(wave.batchId, contract.id, { attempt: 1, receipt: {
      id: contract.id, role: "research", status: "complete", summary: "complete", outputs: [],
      completedAssignmentIds: contract.assignmentIds, needsFollowup: false, followups: [],
      domains: [{ sourceScopeId: contract.sourceScopeIds[0], domainId: "core", conceptIds: [] }],
      coverage: contract.assignmentIds, gaps: [], attempts: 1,
      contractId: contract.contractId, contractDigest: contract.contractDigest,
    } });
  }
  await run.tasksCollected(wave.batchId, wave.contracts.map((contract) => contract.id));
}

function createFence(token) {
  const state = { token };
  return {
    executionToken: token,
    assertActive: async () => {
      if (state.token !== token) throw new Error(`Wiki Lead execution 1/${token} is no longer active`);
    },
    retire(next = "retired") { state.token = next; },
  };
}

function sealInput(extra = {}) {
  return { requiredProfileCoverage: [], sourceFingerprint: "a".repeat(64), summary: "complete", ...extra };
}

async function settleReviews(run) {
  const contracts = await queueReviewWave(run);
  for (const contract of contracts) {
    const receipt = {
      id: contract.id, role: "review", status: "complete", summary: "pass", outputs: [], coverage: [], gaps: [], attempts: 1,
      contractId: contract.contractId, contractDigest: contract.contractDigest,
      review: { verdict: "pass", reviewedPaths: contract.reviewPaths, findings: [], profileCoverage: [] },
    };
    await run.taskStarted(contract.batchId, contract.id, { attempt: 1 });
    await run.taskSettled(contract.batchId, contract.id, { attempt: 1, receipt });
  }
  return contracts;
}

async function queueReviewWave(run) {
  while (true) {
    const wave = await run.startNextReadyWave();
    if (wave.wave === "review") return wave.contracts;
    if (wave.wave !== "write") throw new Error(`expected write or review, got ${wave.wave}`);
    for (const contract of wave.contracts) {
      await run.taskStarted(wave.batchId, contract.id, { attempt: 1 });
      await run.taskSettled(wave.batchId, contract.id, { attempt: 1, receipt: {
        id: contract.id, role: "write", status: "complete", summary: "wrote", outputs: [], coverage: contract.writePaths, gaps: [], attempts: 1,
        contractId: contract.contractId, contractDigest: contract.contractDigest,
      } });
    }
    await run.tasksCollected(wave.batchId, wave.contracts.map((contract) => contract.id));
  }
}

async function completeAndApprove(run) {
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  await run.replacePage({ path: "wiki/source/source.md", content: content("Source", "Source"), actor: "lead" });
  await run.replacePage({ path: "wiki/source/core/domain.md", content: content("Domain", "Core"), actor: "lead" });
  return await settleReviews(run);
}

test("successful page write leaves no candidate journal or lead lock", async (t) => {
  const { root, candidate, run } = await fixture(t);
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  assert.match(await readFile(path.join(candidate, "overview.md"), "utf8"), /Runtime behavior/);
  await assert.rejects(readFile(path.join(root, ".okf-wiki", "runs", "run-1", "candidate-transaction.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, ".okf-wiki", "runs", "run-1", "lead-operation.lock")), { code: "ENOENT" });
});

test("candidate rejects a symlink page and globally invalidates accepted review after any page write", async (t) => {
  const { root, candidate, run } = await fixture(t);
  await mkdir(path.join(candidate, "source", "core"), { recursive: true });
  await symlink(path.join(root, "source", "a.ts"), path.join(candidate, "overview.md"));
  await assert.rejects(run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" }), /regular file|escapes/);
  await rm(path.join(candidate, "overview.md"));
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  await run.replacePage({ path: "wiki/source/source.md", content: content("Source", "Source"), actor: "lead" });
  await run.replacePage({ path: "wiki/source/core/domain.md", content: content("Domain", "Core"), actor: "lead" });
  const reviewPaths = ["wiki/overview.md", "wiki/source/source.md", "wiki/source/core/domain.md"];
  await settleReviews(run);
  await run.finish(reviewPaths, []);
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview", " changed"), actor: "lead" });
  await assert.rejects(run.finish(reviewPaths, []), /lacks passing independent review/);
});

test("a second WikiLeadRun instance sees the latest Candidate Revision after the first writes", async (t) => {
  const { root, candidate, run: first, fence, persist } = await fixture(t);
  await first.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  const second = await WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, ...fence, ...persist });
  await second.replacePage({ path: "wiki/source/core/domain.md", content: content("Domain", "Core"), actor: "lead" });
  assert.match(await readFile(path.join(candidate, "overview.md"), "utf8"), /Runtime behavior/);
  assert.match(await readFile(path.join(candidate, "source", "core", "domain.md"), "utf8"), /Runtime behavior/);
  assert.equal((await persist.readLead()).candidateRevision, 3);
});

test("each review contract persists an exact independent path basis", async (t) => {
  const { run } = await fixture(t);
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  await run.replacePage({ path: "wiki/source/source.md", content: content("Source", "Source"), actor: "lead" });
  await run.replacePage({ path: "wiki/source/core/domain.md", content: content("Domain", "Core"), actor: "lead" });
  const contracts = await queueReviewWave(run);
  assert.deepEqual(contracts.map((contract) => contract.reviewBasis.paths), [
    ["wiki/overview.md"], ["wiki/source/source.md"], ["wiki/source/core/domain.md"],
  ]);
  assert.ok(contracts.every((contract) => contract.reviewBasis.treeDigest === contracts[0].reviewBasis.treeDigest));
});

test("rollbackDelegateBatch removes an unlaunched queued batch so the next queue can reuse its identity", async (t) => {
  const { run } = await fixture(t, undefined, undefined, false);
  const first = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Research" }]);
  assert.equal(first.batchId, 1);
  await run.rollbackDelegateBatch(1);
  const second = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Research again" }]);
  assert.equal(second.batchId, 1);
  assert.equal(second.contracts[0].contractId, first.contracts[0].contractId);
  assert.equal(run.taskRuntimeState.batches.length, 1);
});

test("rollbackDelegateBatch rejects a launched or terminal batch", async (t) => {
  const { run } = await fixture(t, undefined, undefined, false);
  const { batchId, contracts: [contract] } = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Research" }]);
  await run.taskStarted(batchId, contract.id, { attempt: 1 });
  await assert.rejects(run.rollbackDelegateBatch(batchId), /Cannot roll back delegate batch 1 after launch/);
  assert.equal(run.taskRuntimeState.batches.length, 1);
  await run.taskSettled(batchId, contract.id, {
    attempt: 1,
    receipt: {
      id: contract.id, role: contract.role, status: "complete", summary: "done", outputs: [], coverage: [], gaps: [], attempts: 1,
      completedAssignmentIds: contract.assignmentIds, needsFollowup: false, followups: [],
      domains: [{ sourceScopeId: contract.sourceScopeIds[0], domainId: "core", conceptIds: [] }],
      contractId: contract.contractId, contractDigest: contract.contractDigest,
    },
  });
  await assert.rejects(run.rollbackDelegateBatch(batchId), /Cannot roll back delegate batch 1 after launch/);
});

test("semantic task transitions reject rollback, collection before terminal, and forged receipts", async (t) => {
  const { run } = await fixture(t, undefined, undefined, false);
  const { contracts: [contract] } = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Research" }]);
  await assert.rejects(run.tasksCollected(1, [contract.id]), /Only terminal/);
  await assert.rejects(run.taskSettled(1, contract.id, { attempt: 1, receipt: { id: contract.id } }), /Only the current running attempt/);
  await run.taskStarted(1, contract.id, { attempt: 1 });
  await assert.rejects(run.taskStarted(1, contract.id, { attempt: 3 }), /not monotonic/);
  const forged = { id: contract.id, role: contract.role, status: "failed", summary: "failed", outputs: [], coverage: [], gaps: [], attempts: 1, contractId: contract.contractId, contractDigest: "f".repeat(64), error: { code: "schema", message: "bad", retryable: false } };
  await assert.rejects(run.taskSettled(1, contract.id, { attempt: 1, receipt: forged }), /does not match durable contract/);
});

test("durable research receipts must cover only, and then all, contract assignments", async (t) => {
  const { run } = await fixture(t, undefined, undefined, false);
  const { contracts: [empty] } = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Research" }]);
  await run.taskStarted(empty.batchId, empty.id, { attempt: 1 });
  await assert.rejects(run.taskSettled(empty.batchId, empty.id, {
    attempt: 1,
    receipt: {
      id: empty.id, role: "research", status: "complete", summary: "done", outputs: [], coverage: [], gaps: [], attempts: 1,
      completedAssignmentIds: [], needsFollowup: false, followups: [],
      domains: [{ sourceScopeId: empty.sourceScopeIds[0], domainId: "core", conceptIds: [] }],
      contractId: empty.contractId, contractDigest: empty.contractDigest,
    },
  }), /must exactly match durable contract/);

  const { run: other } = await fixture(t, undefined, undefined, false);
  const { contracts: [unknown] } = await other.startNextReadyWave([{ sourceScopeId: "source", instruction: "Research" }]);
  await other.taskStarted(unknown.batchId, unknown.id, { attempt: 1 });
  await assert.rejects(other.taskSettled(unknown.batchId, unknown.id, {
    attempt: 1,
    receipt: {
      id: unknown.id, role: "research", status: "complete", summary: "done", outputs: [], coverage: [], gaps: [], attempts: 1,
      completedAssignmentIds: ["not-assigned"], needsFollowup: false, followups: [],
      domains: [{ sourceScopeId: unknown.sourceScopeIds[0], domainId: "core", conceptIds: [] }],
      contractId: unknown.contractId, contractDigest: unknown.contractDigest,
    },
  }), /do not match durable contract/);
});

test("durable research followups must stay within contract source scopes", async (t) => {
  const { run } = await fixture(t, undefined, undefined, false);
  const { contracts: [contract] } = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Research" }]);
  await run.taskStarted(contract.batchId, contract.id, { attempt: 1 });
  await assert.rejects(run.taskSettled(contract.batchId, contract.id, {
    attempt: 1,
    receipt: {
      id: contract.id, role: "research", status: "incomplete", summary: "needs evidence", outputs: [], coverage: [], gaps: [], attempts: 1,
      completedAssignmentIds: [], needsFollowup: true,
      followups: [{ id: "outside-scope", kind: "evidence_gap", question: "Need evidence", sourceScopeIds: ["other"] }],
      domains: [],
      contractId: contract.contractId, contractDigest: contract.contractDigest,
    },
  }), /followup sourceScopeIds do not match durable contract/);
});

test("persisted delegate history cannot delete queued tasks or forge a phase rollback", async (t) => {
  const { root, candidate, run, fence, persist } = await fixture(t, undefined, undefined, false);
  const { contracts: [contract] } = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Research" }]);
  await run.taskStarted(1, contract.id, { attempt: 1 });
  const forged = structuredClone(await persist.readLead());
  forged.delegates.batches[0].tasks[0].phase = "queued";
  persist.replace(forged);
  await assert.rejects(WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, ...fence, ...persist }), /Invalid Wiki delegate task/);
  forged.delegates.batches[0].tasks = [];
  persist.replace(forged);
  await assert.rejects(WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, ...fence, ...persist }), /Invalid Wiki delegate/);
});

test("publication seal fails closed after file, dotfile, or empty-directory drift", async (t) => {
  const { candidate, run } = await fixture(t);
  await completeAndApprove(run);
  const seal = await run.sealForPublication(sealInput({ publicationAt: "2026-01-01T00:00:00.000Z" }));
  assert.equal((await verifyWikiPublicationSeal(seal)).executionToken, "execution-1");
  await writeFile(path.join(candidate, ".drift"), "hidden\n");
  await assert.rejects(verifyWikiPublicationSeal(seal), /changed after it was sealed/);
  await rm(path.join(candidate, ".drift"));
  await mkdir(path.join(candidate, ".empty"));
  await assert.rejects(verifyWikiPublicationSeal(seal), /changed after it was sealed/);
  await rm(path.join(candidate, ".empty"), { recursive: true });
  await writeFile(path.join(candidate, "overview.md"), "tampered\n");
  await assert.rejects(verifyWikiPublicationSeal(seal), /changed after it was sealed/);
});

test("durable execution token fence blocks stale write, settle, and seal after same-attempt resume", async (t) => {
  const { root, candidate, persist } = await fixture(t);
  const staleFence = createFence("execution-old");
  const stale = await WikiLeadRun.open({
    workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy,
    ...staleFence, ...persist,
  });
  await stale.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  const { contracts: [contract] } = await stale.startNextReadyWave();
  await stale.taskStarted(contract.batchId, contract.id, { attempt: 1 });
  const receipt = { id: contract.id, role: contract.role, status: "complete", summary: "done", outputs: [], coverage: contract.writePaths, gaps: [], attempts: 1, contractId: contract.contractId, contractDigest: contract.contractDigest };
  staleFence.retire("execution-new");
  await assert.rejects(
    stale.replacePage({ path: "wiki/source/core/domain.md", content: content("Domain", "Core"), actor: "lead" }),
    /no longer active/,
  );
  await assert.rejects(stale.taskSettled(contract.batchId, contract.id, { attempt: 1, receipt }), /no longer active/);
  await assert.rejects(stale.sealForPublication(sealInput()), /no longer active/);
  const current = await WikiLeadRun.open({
    workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy,
    ...createFence("execution-new"), ...persist,
  });
  await current.taskSettled(contract.batchId, contract.id, { attempt: 1, receipt });
});

test("a fenced open performs no candidate or run-directory writes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-lead-fenced-open-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, ".okf-wiki", "runs", "run-2", "candidate", "wiki");
  const stale = createFence("execution-old");
  stale.retire("execution-new");
  await assert.rejects(WikiLeadRun.open({
    workspace: root, runId: "run-2", candidateWikiRoot: candidate, policy,
    ...stale, ...memoryLead(),
  }), /no longer active/);
  await assert.rejects(readFile(candidate), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, ".okf-wiki", "runs", "run-2")), { code: "ENOENT" });
});

test("pinned validation and finalization ignore workspace configuration changes during a run", async (t) => {
  const { root, candidate, fence, persist } = await fixture(t);
  const run = await WikiLeadRun.open({
    workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy,
    sourcePlan: sourcePlan(root), language: "en", ...fence, ...persist,
  });
  await writeFile(path.join(root, "workspace.yaml"), "this is no longer a valid workspace config\n");
  await completeAndApprove(run);
  const seal = await run.sealForPublication(sealInput({ publicationAt: "2026-01-01T00:00:00.000Z" }));
  await verifyWikiPublicationSeal(seal);
});

test("saveSpec writes host-owned board.md for the run", async (t) => {
  const { root } = await fixture(t);
  const board = await readFile(path.join(root, ".okf-wiki", "runs", "run-1", "board.md"), "utf8");
  assert.match(board, /^# Wiki board/m);
  assert.match(board, /run: run-1/);
});

test("reopening a run regenerates a missing host-owned board from durable state", async (t) => {
  const { root, candidate, fence, persist } = await fixture(t);
  const boardPath = path.join(root, ".okf-wiki", "runs", "run-1", "board.md");
  await rm(boardPath);
  await WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, ...fence, ...persist });
  assert.match(await readFile(boardPath, "utf8"), /# Wiki board/);
  assert.match(await readFile(boardPath, "utf8"), /digest:/);
});

test("observeCompaction projects compaction onto the board and disables direct writes", async (t) => {
  const { root, run } = await fixture(t);
  await run.observeCompaction();
  const board = await readFile(path.join(root, ".okf-wiki", "runs", "run-1", "board.md"), "utf8");
  assert.match(board, /compactionObserved: yes/);
  assert.match(board, /directWriteAllowed: no/);
});

test("typed coordination derives at most one write task per Wiki cluster", async (t) => {
  const { run } = await fixture(t);
  const writes = await run.startNextReadyWave();
  assert.equal(writes.wave, "write");
  assert.equal(writes.contracts.filter((contract) => contract.writePaths.includes("wiki/source/core/domain.md")).length, 1);
});

test("changes_requested and a later spec revision block finish", async (t) => {
  const { run } = await fixture(t);
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  await run.replacePage({ path: "wiki/source/source.md", content: content("Source", "Source"), actor: "lead" });
  await run.replacePage({ path: "wiki/source/core/domain.md", content: content("Domain", "Core"), actor: "lead" });
  const contracts = await queueReviewWave(run);
  for (const contract of contracts) {
    const requestChanges = contract.reviewPaths.includes("wiki/overview.md");
    await run.taskStarted(contract.batchId, contract.id, { attempt: 1 });
    await run.taskSettled(contract.batchId, contract.id, {
      attempt: 1,
      receipt: {
        id: contract.id, role: "review", status: "complete", summary: requestChanges ? "changes" : "pass",
        outputs: [], coverage: [], gaps: [], attempts: 1,
        contractId: contract.contractId, contractDigest: contract.contractDigest,
        review: {
          verdict: requestChanges ? "changes_requested" : "pass",
          reviewedPaths: contract.reviewPaths,
          findings: requestChanges
            ? [{ id: "missing-evidence", path: "wiki/overview.md", severity: "major" }]
            : [],
          profileCoverage: [],
        },
      },
    });
  }
  await assert.rejects(run.finish(["wiki/overview.md", "wiki/source/source.md", "wiki/source/core/domain.md"], []), /requested changes/);

  const stale = await fixture(t);
  await completeAndApprove(stale.run);
  await stale.run.saveSpec(spec);
  await assert.rejects(stale.run.finish(["wiki/overview.md", "wiki/source/source.md", "wiki/source/core/domain.md"], []), /lacks passing independent review/);
});

for (const point of ["afterFinalizeJournal", "afterValidation", "afterObsoleteRemoval", "afterStamp", "afterIndexes", "afterCleanup", "afterFinalize", "afterSeal"]) {
  test(`publication finalization recovers after ${point}`, async (t) => {
    let armed = true;
    const { root, candidate, run, fence, persist } = await fixture(t, undefined, (value) => { if (armed && value === point) throw new Error(`fault:${point}`); });
    await completeAndApprove(run);
    await assert.rejects(run.sealForPublication(sealInput({ publicationAt: "2026-01-01T00:00:00.000Z" })), new RegExp(`fault:${point}`));
    armed = false;
    const reopened = await WikiLeadRun.open({ workspace: root, runId: "run-1", candidateWikiRoot: candidate, policy, ...fence, ...persist });
    const seal = await reopened.sealForPublication(sealInput({ publicationAt: "2026-01-01T00:00:00.000Z" }));
    await verifyWikiPublicationSeal(seal);
  });
}
