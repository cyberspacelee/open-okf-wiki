import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { WikiLeadRun } from "../dist/lead.js";
import {
  createWikiDelegateCancelTool,
  createWikiDelegateCollectTool,
  createWikiDelegateStartTool,
  createWikiFinishTool,
  createWikiPlanTool,
  createWikiTaxonomyTool,
} from "../dist/pi/host-tools.js";

const policy = { templates: { requiredSections: [] }, review: { mustCover: [] } };
const spec = { pages: ["overview.md", "source/source.md", "source/core/domain.md"] };

function content(type, title) {
  return ["---", `type: ${type}`, `title: ${title}`, "description: Runtime behavior", "sources:", "  - id: source-a", "    resource: source/a.ts#L1-L1", "---", "", "Runtime behavior.[^source-a]", "", "[^source-a]: [Source](source/a.ts#L1-L1)", ""].join("\n");
}

async function lead(t, sourceScopeIds = ["source"], maxDelegatedTasks) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-dispatch-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcesYaml = [];
  for (const scope of sourceScopeIds) {
    const source = path.join(root, scope);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "a.ts"), "export const a = true;\n");
    execFileSync("git", ["init", "--quiet"], { cwd: source });
    sourcesYaml.push(`  - path: ${scope}`, "    origin:", "      type: link", `      localPath: ${JSON.stringify(source)}`);
  }
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1", "language: en", "defaultSourceIgnores: true", "wiki:", "  exclude: []",
    "sources:", ...sourcesYaml, "",
  ].join("\n"));
  let facts;
  return await WikiLeadRun.open({
    workspace: root,
    runId: "run-1",
    candidateWikiRoot: path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki"),
    policy,
    assertActive: async () => {},
    executionToken: "execution-1",
    commitLead: async (next) => { facts = structuredClone(next); },
    readLead: async () => facts,
    allowedSourceScopeIds: sourceScopeIds,
    ...(maxDelegatedTasks === undefined ? {} : { maxDelegatedTasks }),
  });
}

async function settleResearch(run, contracts, extra = {}) {
  for (const contract of contracts) {
    const followups = extra.followups ?? [];
    await run.taskStarted(contract.batchId, contract.id, { attempt: 1 });
    const status = extra.status ?? "complete";
    await run.taskSettled(contract.batchId, contract.id, { attempt: 1, receipt: {
      id: contract.id, role: "research", status, summary: "complete", outputs: [],
      completedAssignmentIds: status === "complete" ? contract.assignmentIds : [],
      needsFollowup: followups.length > 0, followups, coverage: contract.assignmentIds, gaps: [], attempts: 1,
      ...(status === "failed" ? {} : { domains: extra.domains ?? (status === "complete" ? [{ sourceScopeId: contract.sourceScopeIds[0], domainId: "core", conceptIds: [] }] : []) }),
      ...(extra.error ? { error: extra.error } : {}), contractId: contract.contractId, contractDigest: contract.contractDigest,
    } });
  }
}

async function collect(run, contracts) {
  await run.tasksCollected(contracts[0].batchId, contracts.map((contract) => contract.id));
}

async function settleWrite(run, wave) {
  for (const contract of wave.contracts) {
    await run.taskStarted(wave.batchId, contract.id, { attempt: 1 });
    await run.taskSettled(wave.batchId, contract.id, { attempt: 1, receipt: {
      id: contract.id, role: "write", status: "complete", summary: "written", outputs: [],
      coverage: contract.writePaths, gaps: [], attempts: 1,
      contractId: contract.contractId, contractDigest: contract.contractDigest,
    } });
  }
  await collect(run, wave.contracts);
}

function contractForPath(contracts, page) {
  return contracts.find((contract) => (contract.writePaths ?? contract.reviewPaths ?? []).includes(page));
}

test("workflow tool schemas expose no prose or opaque Run IDs", () => {
  const empty = [createWikiDelegateStartTool(async () => ({})), createWikiTaxonomyTool(async () => ({})), createWikiPlanTool(async () => ({})), createWikiFinishTool(async () => ({}))];
  for (const tool of empty) {
    assert.equal(Check(tool.parameters, {}), true);
    assert.equal(Check(tool.parameters, { tasks: [] }), false);
  }
  const collectTool = createWikiDelegateCollectTool(async () => ({}));
  assert.equal(Check(collectTool.parameters, { until: "all", timeoutSeconds: 10 }), true);
  assert.equal(Check(collectTool.parameters, { batchId: 1, until: "all", timeoutSeconds: 10 }), false);
  const cancel = createWikiDelegateCancelTool(async () => ({}));
  for (const reasonCode of ["superseded", "blocked", "user_requested"]) assert.equal(Check(cancel.parameters, { reasonCode }), true);
  assert.equal(Check(cancel.parameters, { reasonCode: "shutdown" }), false);
  assert.equal(Check(cancel.parameters, { taskIds: ["task-1"] }), false);
});

test("coordinator mints discovery identities and requires complete pinned Source coverage", async (t) => {
  const run = await lead(t, ["source-a", "source-b"]);
  await assert.rejects(run.startNextReadyWave([{ sourceScopeId: "source-a", instruction: "Survey A" }]), /cover every pinned Source: source-b/);
  assert.equal(await run.currentActiveWave(), undefined);
  const queued = await run.startNextReadyWave([
    { sourceScopeId: "source-a", instruction: "Survey A" },
    { sourceScopeId: "source-b", instruction: "Survey B" },
  ]);
  assert.equal(queued.wave, "discovery");
  assert.deepEqual(queued.contracts.map((contract) => contract.id), ["research-b1-t1", "research-b1-t2"]);
  assert.deepEqual(queued.contracts.map((contract) => contract.assignmentIds), [["a-b1-t1"], ["a-b1-t2"]]);
  assert.deepEqual(await run.currentActiveWave(), { wave: "discovery", batchId: 1 });
});

test("taxonomy cannot bypass discovery and must cover every pinned Source", async (t) => {
  const run = await lead(t, ["source-a", "source-b"]);
  await assert.rejects(run.saveTaxonomy({ revision: 1, decisions: [], conflictIds: [] }), /discovery research wave/);
  const discovery = await run.startNextReadyWave([
    { sourceScopeId: "source-a", instruction: "Survey A" },
    { sourceScopeId: "source-b", instruction: "Survey B" },
  ]);
  await settleResearch(run, discovery.contracts);
  await collect(run, discovery.contracts);
  await assert.rejects(run.saveTaxonomy({ revision: 1, decisions: [], conflictIds: [] }), /taxonomy decisions must not be empty/);
  await assert.rejects(run.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source-a", domainId: "core", conceptIds: [] }], conflictIds: [] }), /cover every pinned Source: source-b/);
  await assert.rejects(
    run.saveTaxonomy({
      extra: true,
      revision: 1,
      decisions: [{ sourceScopeId: "nope", domainId: "core", conceptIds: [] }],
      conflictIds: [],
    }),
    (error) => {
      assert.match(error.message, /unknown fields: extra/);
      assert.match(error.message, /scopes outside pinned sources: nope \(allowed: source-a, source-b\)/);
      assert.match(error.message, /cover every pinned Source: source-a, source-b/);
      return true;
    },
  );
});

test("supplement splits one task per Source and keeps questions source-local", async (t) => {
  const run = await lead(t, ["source-a", "source-b"]);
  const discovery = await run.startNextReadyWave([
    { sourceScopeId: "source-a", instruction: "Survey A" },
    { sourceScopeId: "source-b", instruction: "Survey B" },
  ]);
  await settleResearch(run, [discovery.contracts[0]], {
    status: "incomplete",
    followups: [{ id: "gap-a", kind: "evidence_gap", question: "Which fallback is authoritative?", sourceScopeIds: ["source-a"] }],
  });
  await settleResearch(run, [discovery.contracts[1]], {
    status: "incomplete",
    followups: [{ id: "gap-b", kind: "evidence_gap", question: "Who owns the widget schema?", sourceScopeIds: ["source-b"] }],
  });
  await collect(run, discovery.contracts);
  const supplement = await run.startNextReadyWave();
  assert.equal(supplement.wave, "supplement");
  assert.equal(supplement.contracts.length, 2);
  assert.deepEqual(supplement.contracts.map((contract) => contract.sourceScopeIds), [["source-a"], ["source-b"]]);
  assert.ok(supplement.contracts.every((contract) => contract.sourceScopeIds.length === 1));
  assert.deepEqual(supplement.contracts[0].domainScopeIds, []);
  assert.deepEqual(supplement.contracts[0].lensScopeIds, []);
  assert.match(supplement.contracts[0].instruction, /Answer only these research blockers with locators/);
  assert.match(supplement.contracts[0].instruction, /Finish complete with empty followups once they are answered/);
  assert.match(supplement.contracts[0].instruction, /Which fallback is authoritative\?/);
  assert.doesNotMatch(supplement.contracts[0].instruction, /Who owns the widget schema\?/);
  assert.doesNotMatch(supplement.contracts[0].instruction, /gap-a/);
  assert.match(supplement.contracts[1].instruction, /Who owns the widget schema\?/);
  assert.doesNotMatch(supplement.contracts[1].instruction, /Which fallback is authoritative\?/);
  assert.doesNotMatch(supplement.contracts[1].instruction, /gap-b/);
});

test("coordinator expands accepted spec into source-local write waves then review", async (t) => {
  const run = await lead(t);
  const discovery = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Survey" }]);
  await settleResearch(run, discovery.contracts);
  await collect(run, discovery.contracts);
  await run.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source", domainId: "core", conceptIds: [] }], conflictIds: [] });
  await run.saveSpec(spec);
  const domain = await run.startNextReadyWave();
  assert.equal(domain.wave, "write");
  assert.deepEqual(domain.contracts.map((contract) => contract.writePaths), [["wiki/source/core/domain.md"]]);
  assert.deepEqual(domain.contracts[0].sourceScopeIds, ["source"]);
  await assert.rejects(run.startNextReadyWave(), /Collect or cancel the current Wiki wave before starting another/);
  await settleWrite(run, domain);

  const sourcePage = await run.startNextReadyWave();
  assert.equal(sourcePage.wave, "write");
  assert.deepEqual(sourcePage.contracts.map((contract) => contract.writePaths), [["wiki/source/source.md"]]);
  assert.deepEqual(sourcePage.contracts[0].sourceScopeIds, ["source"]);
  await settleWrite(run, sourcePage);

  const overview = await run.startNextReadyWave();
  assert.equal(overview.wave, "write");
  assert.deepEqual(overview.contracts.map((contract) => contract.writePaths), [["wiki/overview.md"]]);
  assert.deepEqual(overview.contracts[0].sourceScopeIds, ["source"]);
  await settleWrite(run, overview);
  await run.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  await run.replacePage({ path: "wiki/source/source.md", content: content("Source", "Source"), actor: "lead" });
  await run.replacePage({ path: "wiki/source/core/domain.md", content: content("Domain", "Core"), actor: "lead" });

  const reviews = await run.startNextReadyWave();
  assert.equal(reviews.wave, "review");
  assert.equal(reviews.contracts.length, 3);
  assert.deepEqual(contractForPath(reviews.contracts, "wiki/source/core/domain.md")?.reviewPaths, ["wiki/source/core/domain.md"]);
  assert.deepEqual(contractForPath(reviews.contracts, "wiki/source/source.md")?.reviewPaths, ["wiki/source/source.md"]);
  assert.deepEqual(contractForPath(reviews.contracts, "wiki/overview.md")?.reviewPaths, ["wiki/overview.md"]);
  assert.ok(reviews.contracts.every((contract) => {
    assert.deepEqual(contract.sourceScopeIds, ["source"]);
    return true;
  }));
});

test("coordinator writes a two-source spec bottom-up with single-source contracts", async (t) => {
  const twoSourceSpec = {
    pages: [
      "overview.md",
      "source-a/source.md", "source-a/core/domain.md", "source-a/core/widget/concept.md",
      "source-b/source.md", "source-b/core/domain.md", "source-b/core/widget/concept.md",
    ],
  };
  const run = await lead(t, ["source-a", "source-b"]);
  const discovery = await run.startNextReadyWave([
    { sourceScopeId: "source-a", instruction: "Survey A" },
    { sourceScopeId: "source-b", instruction: "Survey B" },
  ]);
  await settleResearch(run, discovery.contracts);
  await collect(run, discovery.contracts);
  await run.saveTaxonomy({
    revision: 1,
    decisions: [
      { sourceScopeId: "source-a", domainId: "core", conceptIds: ["widget"] },
      { sourceScopeId: "source-b", domainId: "core", conceptIds: ["widget"] },
    ],
    conflictIds: [],
  });
  await run.saveSpec(twoSourceSpec);

  const concepts = await run.startNextReadyWave();
  assert.equal(concepts.wave, "write");
  assert.deepEqual(
    concepts.contracts.flatMap((contract) => contract.writePaths).sort(),
    ["wiki/source-a/core/widget/concept.md", "wiki/source-b/core/widget/concept.md"],
  );
  assert.deepEqual(contractForPath(concepts.contracts, "wiki/source-a/core/widget/concept.md")?.sourceScopeIds, ["source-a"]);
  assert.deepEqual(contractForPath(concepts.contracts, "wiki/source-b/core/widget/concept.md")?.sourceScopeIds, ["source-b"]);
  assert.ok(concepts.contracts.every((contract) => contract.sourceScopeIds.length === 1));
  await settleWrite(run, concepts);

  const domains = await run.startNextReadyWave();
  assert.equal(domains.wave, "write");
  assert.deepEqual(
    domains.contracts.flatMap((contract) => contract.writePaths).sort(),
    ["wiki/source-a/core/domain.md", "wiki/source-b/core/domain.md"],
  );
  assert.deepEqual(contractForPath(domains.contracts, "wiki/source-a/core/domain.md")?.sourceScopeIds, ["source-a"]);
  assert.deepEqual(contractForPath(domains.contracts, "wiki/source-b/core/domain.md")?.sourceScopeIds, ["source-b"]);
  await settleWrite(run, domains);

  const sources = await run.startNextReadyWave();
  assert.equal(sources.wave, "write");
  assert.deepEqual(
    sources.contracts.flatMap((contract) => contract.writePaths).sort(),
    ["wiki/source-a/source.md", "wiki/source-b/source.md"],
  );
  assert.deepEqual(contractForPath(sources.contracts, "wiki/source-a/source.md")?.sourceScopeIds, ["source-a"]);
  assert.deepEqual(contractForPath(sources.contracts, "wiki/source-b/source.md")?.sourceScopeIds, ["source-b"]);
  await settleWrite(run, sources);

  const overview = await run.startNextReadyWave();
  assert.equal(overview.wave, "write");
  assert.deepEqual(overview.contracts.map((contract) => contract.writePaths), [["wiki/overview.md"]]);
  assert.deepEqual(overview.contracts[0].sourceScopeIds, ["source-a", "source-b"]);
});

test("taxonomy sourceScopeId must match the Wiki source folder", async (t) => {
  const run = await lead(t);
  const discovery = await run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Survey" }]);
  await settleResearch(run, discovery.contracts);
  await collect(run, discovery.contracts);
  await run.saveTaxonomy({ revision: 1, decisions: [{ sourceScopeId: "source", domainId: "core", conceptIds: [] }], conflictIds: [] });
  await assert.rejects(run.saveSpec({ pages: ["overview.md", "api/source.md", "api/core/domain.md"] }), /taxonomy domains not owned by their source: source\/core/);
});

test("budget preflight leaves no partial active wave", async (t) => {
  const run = await lead(t, ["source"], 0);
  await assert.rejects(run.startNextReadyWave([{ sourceScopeId: "source", instruction: "Survey" }]), /Delegated task limit exhausted/);
  assert.equal(await run.currentActiveWave(), undefined);
});
