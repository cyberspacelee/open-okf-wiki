import assert from "node:assert/strict";
import test from "node:test";
import { createWikiDelegateContract } from "../dist/delegate-contracts.js";
import { ingestEvidenceHandoff } from "../dist/handoff.js";
import { WikiRejectedError } from "../dist/wiki-reject.js";

const ref = (kind) => ({
  version: 1, runId: "run-1", contractId: "b1-task", attempt: 1, scope: ["source"], kind,
  relativePath: `.okf-wiki/blobs/${"a".repeat(64)}.md`, sha256: "a".repeat(64), sizeBytes: 1, mediaType: "text/markdown",
});

function researchContract(overrides = {}) {
  return createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
    ...overrides,
  });
}

const researchMarkdown = [
  "# Research Handoff", "## Scope", "assignment:assignment-1",
  "## Coverage", "assignment:assignment-1", "## Conflicts and alternatives", "None", "## Gaps and failed reads", "None", "## Evidence", "source/src/runtime.ts#L10-L20",
].join("\n");

test("ingestEvidenceHandoff indexes research Markdown without retaining prose", () => {
  const contract = researchContract({ domainScopeIds: ["runtime"], lensScopeIds: ["api"] });
  const entry = ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown: researchMarkdown, contract, completedAssignmentIds: ["assignment-1"] });
  assert.deepEqual(entry.indexes.assignmentIds, ["assignment-1"]);
  assert.deepEqual(entry.indexes.citations, [{ scope: "source", path: "src/runtime.ts", startLine: 10, endLine: 20 }]);
  assert.equal(Object.hasOwn(entry, "markdown"), false);
});

test("ingestEvidenceHandoff accepts host completion coverage when Markdown omits assignment tokens", () => {
  const markdown = "# Research Handoff\n## Scope\nCovered the assigned source scope.\n## Coverage\nVerified entry points.\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nsource/file.ts#L1-L2";
  const entry = ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract: researchContract(), completedAssignmentIds: ["assignment-1"] });
  assert.deepEqual(entry.completedAssignmentIds, ["assignment-1"]);
  assert.deepEqual(entry.indexes.assignmentIds, []);
});

test("ingestEvidenceHandoff requires host-owned identity and clones the artifact", () => {
  const contract = researchContract();
  const artifact = ref("research-handoff");
  const entry = ingestEvidenceHandoff({ artifact, markdown: researchMarkdown, contract, completedAssignmentIds: ["assignment-1"] });
  assert.deepEqual(entry.artifact, artifact);
  artifact.runId = "mutated";
  assert.equal(entry.artifact.runId, "run-1");
  assert.throws(
    () => ingestEvidenceHandoff({ artifact: { ...ref("research-handoff"), runId: "" }, markdown: researchMarkdown, contract }),
    /host-owned identity/,
  );
  assert.throws(
    () => ingestEvidenceHandoff({ artifact: { ...ref("research-handoff"), contractId: "" }, markdown: researchMarkdown, contract }),
    /host-owned identity/,
  );
  assert.throws(
    () => ingestEvidenceHandoff({ artifact: { ...ref("research-handoff"), attempt: 0 }, markdown: researchMarkdown, contract }),
    /host-owned identity/,
  );
});

test("ingestEvidenceHandoff rejects a mismatched artifact kind", () => {
  assert.throws(
    () => ingestEvidenceHandoff({ artifact: ref("write-handoff"), markdown: researchMarkdown, contract: researchContract(), completedAssignmentIds: ["assignment-1"] }),
    /kind/,
  );
});

test("ingestEvidenceHandoff rejects host-owned undeclared assignment IDs", () => {
  assert.throws(
    () => ingestEvidenceHandoff({
      artifact: ref("research-handoff"),
      markdown: "# Research Handoff\n## Scope\nCovered the assigned source scope.\n## Coverage\nVerified entry points.\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nsource/file.ts#L1-L2",
      contract: researchContract(),
      completedAssignmentIds: ["other"],
    }),
    /undeclared/,
  );
});

test("ingestEvidenceHandoff rejects host-owned followup scopes outside pinned scopes", () => {
  assert.throws(
    () => ingestEvidenceHandoff({
      artifact: ref("research-handoff"),
      markdown: "# Research Handoff\n## Scope\nCovered the assigned source scope.\n## Coverage\nVerified entry points.\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nsource/file.ts#L1-L2",
      contract: researchContract(),
      followups: [{ kind: "evidence_gap", question: "Need another Source", sourceScopeIds: ["other"] }],
    }),
    /followup scopes outside pinned scopes: other \(allowed: source\)/,
  );
});

test("ingestEvidenceHandoff wraps inspect defects as WikiRejectedError", () => {
  assert.throws(
    () => ingestEvidenceHandoff({
      artifact: ref("research-handoff"),
      markdown: "Covered without a role heading.\n## Evidence\nrepo:source/a.ts#L1-L1",
      contract: researchContract(),
    }),
    (error) => {
      assert.ok(error instanceof WikiRejectedError);
      assert.match(error.message, /missing headings: Research Handoff, Scope/);
      return true;
    },
  );
});

test("ingestEvidenceHandoff indexes a handoff after valid leading YAML frontmatter", () => {
  const markdown = "---\nfollowups: []\n---\n# Research Handoff\n## Scope\nassignment:assignment-1\n## Coverage\nComplete\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nsource/file.ts#L1-L2";
  const entry = ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract: researchContract(), completedAssignmentIds: ["assignment-1"] });
  assert.deepEqual(entry.indexes.assignmentIds, ["assignment-1"]);
  assert.deepEqual(entry.indexes.citations, [{ scope: "source", path: "file.ts", startLine: 1, endLine: 2 }]);
});

test("ingestEvidenceHandoff accepts Markdown links, numbered lists, [n]: definitions, and #Lx anchors", () => {
  const markdown = [
    "# Research Handoff", "## Scope", "ok", "## Coverage", "ok",
    "## Conflicts and alternatives", "None", "## Gaps and failed reads", "None",
    "## Evidence",
    "1. [runtime.ts](source/src/runtime.ts#L10-L20)",
    "[file.ts](./source/file.ts#L1)",
    "[1]: source/listed.ts#L2",
    "https://example.test/docs is not source evidence",
  ].join("\n");
  const entry = ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract: researchContract(), completedAssignmentIds: ["assignment-1"] });
  assert.deepEqual(entry.indexes.citations, [
    { scope: "source", path: "src/runtime.ts", startLine: 10, endLine: 20 },
    { scope: "source", path: "file.ts", startLine: 1, endLine: 1 },
    { scope: "source", path: "listed.ts", startLine: 2, endLine: 2 },
  ]);
});

test("ingestEvidenceHandoff accepts the Skill-format write completion handoff", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "write", instruction: "Write", sourceScopeIds: ["source"], contextRefs: [],
    writePaths: ["wiki/source/core/domain.md"],
  });
  const entry = ingestEvidenceHandoff({ artifact: ref("write-handoff"), markdown: "# Write Handoff\n\nUpdated the assigned page.\n", contract });
  assert.deepEqual(entry.indexes.pageIds, []);
  assert.deepEqual(entry.indexes.citations, []);
});

test("ingestEvidenceHandoff accepts the Skill-format review handoff", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "review", instruction: "Review", sourceScopeIds: ["source"], contextRefs: [],
    reviewPaths: ["wiki/source/core/domain.md"],
  }, {
    version: 1, candidateRevision: 1, treeDigest: "a".repeat(64), policyDigest: "b".repeat(64),
    paths: ["wiki/source/core/domain.md"],
  });
  const markdown = [
    "---",
    "findings:",
    "  - path: wiki/source/core/domain.md",
    "    severity: major",
    "profileCoverage:",
    "  - evidence-fidelity",
    "---",
    "# Review Handoff",
    "## Findings", "The page needs one evidence correction.",
    "## Evidence", "source/file.ts#L1-L2",
  ].join("\n");
  const entry = ingestEvidenceHandoff({ artifact: ref("review-handoff"), markdown, contract });
  assert.deepEqual(entry.indexes.citations, [{ scope: "source", path: "file.ts", startLine: 1, endLine: 2 }]);
});
