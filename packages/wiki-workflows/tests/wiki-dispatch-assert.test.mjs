import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDispatchable,
  clusterSourceScopeIds,
  contextRefsForSources,
  selectReadyClusters,
} from "../dist/lead.js";

const spec = {
  pages: [
    "overview.md",
    "api/source.md",
    "api/billing/domain.md",
    "api/billing/invoice/concept.md",
    "web/source.md",
    "web/billing/domain.md",
  ],
};

const writeFrontier = [
  { id: "_root", nextStep: "write" },
  { id: "api/_source", nextStep: "write" },
  { id: "api/billing", nextStep: "write" },
  { id: "api/billing/invoice", nextStep: "write" },
  { id: "web/_source", nextStep: "write" },
  { id: "web/billing", nextStep: "write" },
];

const artifacts = [
  { contractId: "a", sourceScopeIds: ["api"] },
  { contractId: "b", sourceScopeIds: ["web"] },
];

test("selectReadyClusters write frontier is leaves only", () => {
  assert.deepEqual(
    selectReadyClusters(writeFrontier, "write").map((cluster) => cluster.id),
    ["api/billing/invoice", "web/billing"],
  );
});

test("selectReadyClusters write frontier advances after child leaves leave write", () => {
  const afterLeaves = [
    { id: "_root", nextStep: "write" },
    { id: "api/_source", nextStep: "write" },
    { id: "api/billing", nextStep: "write" },
    { id: "api/billing/invoice", nextStep: "review" },
    { id: "web/_source", nextStep: "write" },
    { id: "web/billing", nextStep: "done" },
  ];
  assert.deepEqual(
    selectReadyClusters(afterLeaves, "write").map((cluster) => cluster.id),
    ["api/billing", "web/_source"],
  );
});

test("selectReadyClusters write frontier admits _root after every other cluster leaves write", () => {
  const rootOnly = [
    { id: "_root", nextStep: "write" },
    { id: "api/_source", nextStep: "done" },
    { id: "api/billing", nextStep: "review" },
    { id: "api/billing/invoice", nextStep: "done" },
    { id: "web/_source", nextStep: "review" },
    { id: "web/billing", nextStep: "done" },
  ];
  assert.deepEqual(
    selectReadyClusters(rootOnly, "write").map((cluster) => cluster.id),
    ["_root"],
  );
});

test("selectReadyClusters review returns every review cluster without topo wait", () => {
  const mixedReview = [
    { id: "_root", nextStep: "review" },
    { id: "api/_source", nextStep: "write" },
    { id: "api/billing", nextStep: "review" },
    { id: "api/billing/invoice", nextStep: "review" },
    { id: "web/_source", nextStep: "review" },
    { id: "web/billing", nextStep: "done" },
  ];
  assert.deepEqual(
    selectReadyClusters(mixedReview, "review").map((cluster) => cluster.id),
    ["_root", "api/billing", "api/billing/invoice", "web/_source"],
  );
});

test("clusterSourceScopeIds pins every source on _root and one source elsewhere", () => {
  assert.deepEqual(clusterSourceScopeIds("_root", ["api", "web"]), ["api", "web"]);
  assert.deepEqual(clusterSourceScopeIds("api/billing", ["api", "web"]), ["api"]);
});

test("contextRefsForSources keeps artifacts whose sources are a subset of the scope", () => {
  assert.deepEqual(contextRefsForSources(["api"], artifacts), ["a"]);
  assert.deepEqual(contextRefsForSources(["api", "web"], artifacts), ["a", "b"]);
});

test("assertDispatchable rejects research that spans multiple sources", () => {
  assert.throws(
    () => assertDispatchable({
      tasks: [{
        id: "research-1",
        role: "research",
        instruction: "Survey both sources",
        sourceScopeIds: ["api", "web"],
        assignmentIds: ["a-1"],
      }],
    }),
    /exactly one|single source/,
  );
});

test("assertDispatchable rejects mixed-source write of a non-root cluster", () => {
  assert.throws(() => assertDispatchable({
    spec,
    tasks: [{
      id: "write-billing",
      role: "write",
      instruction: "Write billing domain",
      cluster: "api/billing",
      sourceScopeIds: ["api", "web"],
    }],
  }));
  assert.throws(() => assertDispatchable({
    spec,
    tasks: [{
      id: "write-billing-paths",
      role: "write",
      instruction: "Write billing domain",
      writePaths: ["wiki/api/billing/domain.md"],
      sourceScopeIds: ["api", "web"],
    }],
  }));
});

test("assertDispatchable accepts _root write covering every spec source", () => {
  assert.doesNotThrow(() => assertDispatchable({
    spec,
    tasks: [{
      id: "write-root",
      role: "write",
      instruction: "Write overview",
      writePaths: ["wiki/overview.md"],
      sourceScopeIds: ["api", "web"],
    }],
  }));
});

test("assertDispatchable rejects contextRefs that are not source-local to the task", () => {
  assert.throws(() => assertDispatchable({
    spec,
    knownContextRefs: [{ contractId: "b", sourceScopeIds: ["web"] }],
    tasks: [{
      id: "write-billing",
      role: "write",
      instruction: "Write billing domain",
      cluster: "api/billing",
      sourceScopeIds: ["api"],
      contextRefs: ["b"],
    }],
  }), /source/);
});

test("assertDispatchable accepts contextRefs whose sources are a subset of the task", () => {
  assert.doesNotThrow(() => assertDispatchable({
    spec,
    knownContextRefs: [{ contractId: "a", sourceScopeIds: ["api"] }],
    tasks: [{
      id: "write-billing",
      role: "write",
      instruction: "Write billing domain",
      cluster: "api/billing",
      sourceScopeIds: ["api"],
      contextRefs: ["a"],
    }],
  }));
});
