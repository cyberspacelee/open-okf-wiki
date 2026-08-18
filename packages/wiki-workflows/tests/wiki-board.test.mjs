import assert from "node:assert/strict";
import test from "node:test";
import { parseWikiSpec, projectWikiBoard, renderWikiBoard } from "../dist/lead.js";

function sampleModel() {
  return {
    runId: "run-abc",
    specRevision: 2,
    candidateRevision: 4,
    compactionObserved: true,
    directWriteAllowed: false,
    delegatedTaskCount: 3,
    delegateBatchCount: 2,
    clusters: [
      {
        id: "core",
        paths: ["overview.md"],
        status: "accepted",
        terminalWriteOrReviewCount: 0,
      },
      {
        id: "source/core/runtime",
        paths: ["source/core/runtime/concept.md", "source/core/runtime/module.md"],
        status: "writing",
        terminalWriteOrReviewCount: 1,
      },
    ],
    tasks: [
      {
        id: "research-1",
        role: "research",
        paths: ["source/core/runtime/concept.md"],
        phase: "terminal",
        receiptStatus: "complete",
      },
      {
        id: "review-3",
        role: "review",
        paths: ["overview.md"],
        phase: "terminal",
        receiptStatus: "failed",
        errorCode: "review_timeout",
      },
      {
        id: "write-2",
        role: "write",
        paths: ["source/core/runtime/concept.md"],
        phase: "running",
      },
    ],
    remaining: [
      "write source/core/runtime/module.md",
      "review source/core/runtime/concept.md",
    ],
  };
}

const expectedBoard = `\
# Wiki board

- run: run-abc
- specRevision: 2
- candidateRevision: 4
- compactionObserved: yes
- directWriteAllowed: no
- delegatedTasks: 3
- delegateBatches: 2

## Clusters

- \`core\` **accepted** (writes/reviews: 0)
  - overview.md
- \`source/core/runtime\` **writing** (writes/reviews: 1)
  - source/core/runtime/concept.md
  - source/core/runtime/module.md

## Tasks

- \`research-1\` research terminal complete
- \`review-3\` review terminal failed review_timeout
- \`write-2\` write running

## Remaining

- write source/core/runtime/module.md
- review source/core/runtime/concept.md
`;

test("renders a known-good board model as stable Markdown", () => {
  assert.equal(renderWikiBoard(sampleModel()), expectedBoard);
});

test("empty remaining renders - none", () => {
  const model = sampleModel();
  model.remaining = [];
  const rendered = renderWikiBoard(model);
  assert.match(rendered, /^## Remaining\n\n- none\n$/m);
  assert.equal(rendered.includes("- write source/core/runtime/module.md"), false);
});

test("host board declares Sources, active wave, coverage, blockers and next action without ID instructions", () => {
  const model = projectWikiBoard({
    runId: "run-1",
    specRevision: 0,
    candidateRevision: 0,
    sourceScopeIds: ["source-a", "source-b"],
    compactionObserved: false,
    delegates: { batches: [{ batchId: 1, tasks: [{
      id: "research-b1-t1", role: "research", mode: "discovery", phase: "running", collected: false,
      sourceScopeIds: ["source-a"], assignmentIds: ["a-b1-t1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
    }] }] },
  });
  const rendered = renderWikiBoard(model);
  assert.match(rendered, /declaredSources: source-a, source-b/);
  assert.match(rendered, /activeWave: discovery running/);
  assert.match(rendered, /researchCoverage: 0\/1/);
  assert.match(rendered, /nextAction: collect/);
  assert.doesNotMatch(rendered, /pass .*batch|copy .*task|round.trip/i);
});

test("blocked cluster shows blocked when terminalWriteOrReviewCount is at least 3", () => {
  const model = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 1,
    compactionObserved: false,
    spec: projectionSpec(),
    delegates: {
      batches: [{
        tasks: [
          { id: "w1", role: "write", phase: "terminal", writePaths: ["wiki/source/core/runtime/concept.md"], receipt: { status: "complete" } },
          { id: "w2", role: "write", phase: "terminal", writePaths: ["wiki/source/core/runtime/concept.md"], receipt: { status: "complete" } },
          { id: "r1", role: "review", phase: "terminal", reviewPaths: ["wiki/source/core/runtime/concept.md"], receipt: { status: "complete" } },
        ],
      }],
    },
  });
  const runtime = model.clusters.find((cluster) => cluster.id === "source/core/runtime");
  assert.equal(runtime.status, "blocked");
  assert.equal(runtime.terminalWriteOrReviewCount, 3);
  assert.match(renderWikiBoard(model), /`source\/core\/runtime` \*\*blocked\*\* \(writes\/reviews: 3\)/);
  assert.match(renderWikiBoard(model), /`_root` \*\*unplanned\*\*/);
});

test("renderWikiBoard prints projected status without overriding accepted to blocked", () => {
  const model = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 1,
    compactionObserved: false,
    spec: projectionSpec(),
    reviews: [
      { verdict: "pass", reviewedPaths: ["wiki/source/core/domain.md"] },
    ],
    delegates: {
      batches: [{
        tasks: [
          { id: "w1", role: "write", phase: "terminal", writePaths: ["wiki/source/core/domain.md"], receipt: { status: "complete" } },
          { id: "w2", role: "write", phase: "terminal", writePaths: ["wiki/source/core/domain.md"], receipt: { status: "complete" } },
          { id: "r1", role: "review", phase: "terminal", reviewPaths: ["wiki/source/core/domain.md"], receipt: { status: "complete" } },
        ],
      }],
    },
  });
  const core = model.clusters.find((cluster) => cluster.id === "source/core");
  assert.equal(core.status, "accepted");
  assert.equal(core.terminalWriteOrReviewCount, 3);
  assert.match(renderWikiBoard(model), /`source\/core` \*\*accepted\*\* \(writes\/reviews: 3\)/);
});

function projectionSpec(pages = ["overview.md", "source/source.md", "source/core/domain.md", "source/core/runtime/concept.md"]) {
  return parseWikiSpec({ pages });
}

test("projector maps a DTO to accepted, blocked, and remaining cluster work", () => {
  const model = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 4,
    compactionObserved: false,
    spec: projectionSpec(),
    reviews: [
      { verdict: "pass", reviewedPaths: ["wiki/source/core/domain.md"] },
      { verdict: "changes_requested", reviewedPaths: ["wiki/source/core/runtime/concept.md"] },
    ],
    delegates: {
      batches: [{
        tasks: [
          { id: "w1", role: "write", phase: "terminal", writePaths: ["wiki/source/core/runtime/concept.md"], receipt: { status: "complete" } },
          { id: "w2", role: "write", phase: "terminal", writePaths: ["wiki/source/core/runtime/concept.md"], receipt: { status: "complete" } },
          { id: "r1", role: "review", phase: "terminal", reviewPaths: ["wiki/source/core/runtime/concept.md"], receipt: { status: "complete" } },
        ],
      }],
    },
  });
  const byId = Object.fromEntries(model.clusters.map((cluster) => [cluster.id, cluster]));
  assert.equal(byId._root.status, "unplanned");
  assert.deepEqual(byId._root.paths, ["overview.md"]);
  assert.equal(byId["source/core"].status, "accepted");
  assert.equal(byId["source/core/runtime"].status, "blocked");
  assert.equal(byId["source/core/runtime"].terminalWriteOrReviewCount, 3);
  assert.deepEqual(model.remaining, [
    "write _root",
    "write source/_source",
    "changes_requested source/core/runtime",
    "blocked source/core/runtime",
  ]);
  assert.equal(model.directWriteAllowed, false);
  assert.equal(model.delegatedTaskCount, 3);
  assert.equal(model.delegateBatchCount, 1);
});

test("directWriteAllowed requires one domain, at most three pages, and no compaction", () => {
  const input = {
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 1,
    compactionObserved: false,
  };
  assert.equal(projectWikiBoard({ ...input, spec: projectionSpec(["overview.md", "source/source.md", "source/core/domain.md"]) }).directWriteAllowed, true);
  assert.equal(projectWikiBoard({
    ...input,
    compactionObserved: true,
    spec: projectionSpec(["overview.md", "source/source.md", "source/core/domain.md"]),
  }).directWriteAllowed, false);
  assert.equal(projectWikiBoard({
    ...input,
    spec: projectionSpec(["overview.md", "source/source.md", "source/core/domain.md", "source/core/runtime/concept.md", "source/core/runtime/flows.md"]),
  }).directWriteAllowed, false);
  assert.equal(projectWikiBoard({
    ...input,
    spec: projectionSpec(["overview.md", "source/source.md", "source/core/domain.md", "source/billing/domain.md"]),
  }).directWriteAllowed, false);
});

test("task line includes batch n when batchId is present and omits it otherwise", () => {
  const withBatch = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 1,
    compactionObserved: false,
    spec: projectionSpec(),
    delegates: {
      batches: [{
        batchId: 2,
        tasks: [
          { id: "w1", role: "write", phase: "running", writePaths: ["wiki/source/core/domain.md"] },
        ],
      }],
    },
  });
  assert.equal(withBatch.tasks[0].batch, 2);
  assert.match(renderWikiBoard(withBatch), /`w1` write running batch 2/);

  const withoutBatch = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 1,
    compactionObserved: false,
    spec: projectionSpec(),
    delegates: {
      batches: [{
        tasks: [
          { id: "w1", role: "write", phase: "running", writePaths: ["wiki/source/core/domain.md"] },
        ],
      }],
    },
  });
  assert.equal(withoutBatch.tasks[0].batch, undefined);
  assert.equal(renderWikiBoard(withoutBatch).includes("batch "), false);
});

test("sorts clusters, cluster paths, and tasks independently of input order", () => {
  const model = sampleModel();
  model.clusters = [
    {
      id: "source/core/runtime",
      paths: ["source/core/runtime/module.md", "source/core/runtime/concept.md"],
      status: "writing",
      terminalWriteOrReviewCount: 1,
    },
    {
      id: "core",
      paths: ["overview.md"],
      status: "accepted",
      terminalWriteOrReviewCount: 0,
    },
  ];
  model.tasks = [...model.tasks].reverse();
  assert.equal(renderWikiBoard(model), expectedBoard);
});

test("projects taxonomy, artifact context, assignment coverage, and blocker followups", () => {
  const model = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    taxonomy: {
      accepted: true,
      revision: 2,
      decisions: [{ sourceScopeId: "api", domainId: "runtime", conceptIds: ["session"] }],
      conflictIds: ["conflict-runtime"],
      digest: "a".repeat(64),
    },
    candidateRevision: 1,
    compactionObserved: true,
    spec: projectionSpec(["overview.md", "api/source.md", "api/runtime/domain.md"]),
    delegates: { batches: [{ batchId: 1, tasks: [{
      id: "research-runtime", role: "research", phase: "terminal", mode: "discovery",
      sourceScopeIds: ["api"], contextRefs: ["b1-research-runtime"], assignmentIds: ["api-runtime"],
      domainScopeIds: ["runtime"], lensScopeIds: ["entry"],
      receipt: {
        status: "incomplete", outputs: [{ nodeId: "b1-research-runtime", attempt: 1 }],
        completedAssignmentIds: [], coverage: ["api-entry"], needsFollowup: true,
        followups: [{ id: "gap-runtime", kind: "evidence_gap", question: "Where is retry state persisted?", sourceScopeIds: ["api"] }],
        domains: [{ sourceScopeId: "api", domainId: "runtime", conceptIds: ["session"] }],
      },
    }] }] },
  });
  assert.equal(model.taxonomy?.revision, 2);
  assert.deepEqual(model.tasks[0].artifactRefs?.map((ref) => ref.nodeId), ["b1-research-runtime"]);
  assert.deepEqual(model.tasks[0].contextRefs, ["b1-research-runtime"]);
  assert.deepEqual(model.tasks[0].domains, [{ sourceScopeId: "api", domainId: "runtime", conceptIds: ["session"] }]);
  assert.deepEqual(model.blockers, ["gap-runtime"]);
  assert.match(renderWikiBoard(model), /api\/runtime: session/);
  assert.doesNotMatch(renderWikiBoard(model), /artifact: b1-research-runtime/);
  assert.match(renderWikiBoard(model), /Where is retry state persisted\?/);
});

test("subtracts blockers resolved by a completed supplement", () => {
  const model = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 1,
    compactionObserved: true,
    spec: projectionSpec(["overview.md", "api/source.md", "api/runtime/domain.md"]),
    delegates: { batches: [{ batchId: 1, tasks: [
      {
        id: "discover", role: "research", phase: "terminal", mode: "discovery", assignmentIds: ["discover"],
        receipt: {
          status: "complete", outputs: [], completedAssignmentIds: ["discover"], coverage: ["discover"],
          needsFollowup: true, followups: [{ id: "gap-discover", kind: "evidence_gap", question: "Need evidence", sourceScopeIds: ["api"] }],
        },
      },
      {
        id: "supplement", role: "research", phase: "terminal", mode: "supplement", assignmentIds: ["supplement"], resolvesIds: ["gap-discover"],
        receipt: { status: "complete", outputs: [], completedAssignmentIds: ["supplement"], coverage: ["supplement"], needsFollowup: false, followups: [] },
      },
    ] }] },
  });
  assert.deepEqual(model.blockers, []);
  assert.equal(renderWikiBoard(model).includes("gap-discover"), false);
});

test("supplement completion covers the original discovery assignment", () => {
  const model = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 1,
    compactionObserved: true,
    delegates: { batches: [{ batchId: 1, tasks: [
      {
        id: "discover", role: "research", phase: "terminal", mode: "discovery", assignmentIds: ["assignment"],
        receipt: { status: "incomplete", outputs: [], completedAssignmentIds: [], needsFollowup: true, followups: [{ id: "gap", kind: "evidence_gap", question: "Need evidence", sourceScopeIds: ["api"] }] },
      },
      {
        id: "supplement", role: "research", phase: "terminal", mode: "supplement", assignmentIds: ["assignment"], resolvesIds: ["gap"],
        receipt: { status: "complete", outputs: [], completedAssignmentIds: ["assignment"], needsFollowup: false, followups: [] },
      },
    ] }] },
  });
  assert.equal(model.researchAssignments.every((assignment) => assignment.completed), true);
  assert.deepEqual(model.remaining.filter((line) => line === "research assignment"), []);
});

for (const correctiveStatus of ["failed", "incomplete"]) {
  test(`a ${correctiveStatus} write after changes_requested keeps write next until a successful write`, () => {
    const research = {
      id: "discover", role: "research", phase: "terminal", collected: true, mode: "discovery",
      sourceScopeIds: ["source"], assignmentIds: ["assignment"],
      receipt: { status: "complete", completedAssignmentIds: ["assignment"], needsFollowup: false, followups: [] },
    };
    const firstWrite = {
      id: "write-1", role: "write", phase: "terminal", collected: true,
      writePaths: ["wiki/overview.md"], receipt: { status: "complete" },
    };
    const requestedChanges = {
      id: "review-1", role: "review", phase: "terminal", collected: true,
      reviewPaths: ["wiki/overview.md"],
      receipt: { status: "complete", review: { verdict: "changes_requested" } },
    };
    const correctiveWrite = {
      id: "write-2", role: "write", phase: "terminal", collected: true,
      writePaths: ["wiki/overview.md"], receipt: { status: correctiveStatus },
    };
    const input = {
      runId: "run-ordered-events",
      specRevision: 1,
      candidateRevision: 1,
      sourceScopeIds: ["source"],
      compactionObserved: false,
      taxonomy: {
        accepted: true, revision: 1,
        decisions: [{ sourceScopeId: "source", domainId: "core", conceptIds: [] }],
        conflictIds: [], digest: "a".repeat(64),
      },
      spec: projectionSpec(["overview.md", "source/source.md", "source/core/domain.md"]),
      reviews: [{ verdict: "pass", reviewedPaths: ["wiki/source/source.md", "wiki/source/core/domain.md"] }],
    };

    const pending = projectWikiBoard({
      ...input,
      delegates: { batches: [{ batchId: 1, tasks: [research] }, { batchId: 2, tasks: [firstWrite] }, { batchId: 3, tasks: [requestedChanges] }, { batchId: 4, tasks: [correctiveWrite] }] },
    });
    assert.equal(pending.clusters[0].nextStep, "write");
    assert.equal(pending.nextAction, "write");

    const successfulWrite = { ...correctiveWrite, id: "write-3", receipt: { status: "complete" } };
    const readyForReview = projectWikiBoard({
      ...input,
      delegates: { batches: [{ batchId: 1, tasks: [research] }, { batchId: 2, tasks: [firstWrite] }, { batchId: 3, tasks: [requestedChanges] }, { batchId: 4, tasks: [correctiveWrite] }, { batchId: 5, tasks: [successfulWrite] }] },
    });
    assert.equal(readyForReview.clusters[0].nextStep, "review");
    assert.equal(readyForReview.nextAction, "review");
  });
}
