import assert from "node:assert/strict";
import test from "node:test";
import { createWikiDelegateContract, truncateUtf8 } from "../dist/delegate-contracts.js";
import { inspectHandoff } from "../dist/handoff.js";
import { MAX_WIKI_WORK_FILE_BYTES } from "../dist/wiki-work-files.js";

const completeYaml = "followups: []\ndomains:\n  - id: runtime\n    conceptIds: [session]";

function researchContract(sourceScopeIds = ["source"], assignmentIds = ["assignment-1"]) {
  return createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds, contextRefs: [],
    mode: "discovery", assignmentIds, domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
}

function reviewContract(reviewPaths = ["wiki/a.md", "wiki/b.md"]) {
  return createWikiDelegateContract(1, {
    id: "task", role: "review", instruction: "Review", sourceScopeIds: ["source"], contextRefs: [],
    reviewPaths,
  }, {
    version: 1, candidateRevision: 1, treeDigest: "a".repeat(64), policyDigest: "b".repeat(64),
    paths: reviewPaths,
  });
}

function writeContract() {
  return createWikiDelegateContract(1, {
    id: "task", role: "write", instruction: "Write", sourceScopeIds: ["source"], contextRefs: [],
    writePaths: ["wiki/source/core/domain.md"],
  });
}

function researchBody(coverage = "The runtime maps each request to a pinned Source.") {
  return [
    "# Research Handoff",
    "## Scope", "- **Source:** source",
    "## Coverage", coverage,
    "## Evidence", "source/file.ts#L1-L2",
    "## Conflicts and alternatives", "None",
    "## Gaps and failed reads", "None",
  ].join("\n");
}

function researchMarkdown(yaml, body = researchBody()) {
  return `---\n${yaml}\n---\n${body}\n`;
}

function reviewMarkdown(yaml) {
  return [
    "---", yaml, "---",
    "# Review Handoff",
    "## Findings", "The page needs one evidence correction.",
    "## Evidence", "source/file.ts#L1-L2",
    "",
  ].join("\n");
}

function inspectResearch(bytes, status = "complete", sourceScopeIds = ["source"]) {
  return inspectHandoff({
    bytes,
    contract: researchContract(sourceScopeIds),
    finish: { field: "status", value: status },
  });
}

function defectsOf(result) {
  assert.equal("ok" in result, false);
  return result.defects;
}

test("inspectHandoff rejects malformed UTF-8", () => {
  assert.deepEqual(defectsOf(inspectResearch(Uint8Array.from([0xc3, 0x28]))), ["Malformed UTF-8 input"]);
});

test("inspectHandoff accepts CRLF YAML frontmatter", () => {
  const markdown = `---\r\n${completeYaml.replaceAll("\n", "\r\n")}\r\n---\r\n${researchBody().replaceAll("\n", "\r\n")}\r\n`;
  const inspected = inspectResearch(markdown);
  assert.equal("ok" in inspected, true);
  assert.equal(inspected.research.status, "complete");
  assert.deepEqual(inspected.research.domains, [{ id: "runtime", conceptIds: ["session"] }]);
});

test("inspectHandoff requires domains for complete research", () => {
  assert.ok(defectsOf(inspectResearch(researchMarkdown("followups: []\ndomains: []"))).includes("complete research requires domains"));
});

test("inspectHandoff requires followups for incomplete research", () => {
  assert.ok(defectsOf(inspectResearch(researchMarkdown("followups: []\ndomains: []"), "incomplete")).includes("incomplete research requires followups"));
});

test("inspectHandoff returns structural defects without later semantic collection", () => {
  assert.deepEqual(defectsOf(inspectResearch("---\nfollowups: []\ndomains: []\n---\n   ")), ["handoff.md body must be nonempty"]);
});

test("inspectHandoff collects semantic YAML defects", () => {
  const unknown = defectsOf(inspectResearch(researchMarkdown("summary: forged"))).join("; ");
  assert.match(unknown, /handoff\.md frontmatter has unknown fields: summary/);
  assert.match(unknown, /handoff\.md frontmatter missing fields: followups, domains/);
  const followups = defectsOf(inspectResearch(researchMarkdown([
    "followups:",
    "  - kind: nope",
    "    question: ",
    "    source: forged",
    "  - kind: evidence_gap",
    "domains: []",
  ].join("\n")), "incomplete")).join("; ");
  assert.match(followups, /followups\[0\] has unknown fields: source/);
  assert.match(followups, /followups\[0\]\.kind "nope" is not supported \(allowed: unread_scope, evidence_gap, conflict, taxonomy_uncertain, tool_failure\)/);
  assert.match(followups, /followups\[0\]\.question must be a nonempty string/);
  assert.match(followups, /followups\[1\] missing fields: question/);
});

test("inspectHandoff derives a byte-bounded summary and injects Source scopes", () => {
  const inspected = inspectResearch(researchMarkdown(completeYaml, researchBody("😀".repeat(300))));
  assert.equal("ok" in inspected, true);
  assert.equal(Buffer.byteLength(inspected.research.summary, "utf8"), 1024);
  assert.equal(inspected.research.summary, "😀".repeat(256));
  const incomplete = inspectResearch(researchMarkdown([
    "followups:",
    "  - kind: tool_failure",
    "    question: Artifact read failed",
    "domains: []",
  ].join("\n")), "incomplete");
  assert.equal("ok" in incomplete, true);
  assert.deepEqual(incomplete.research.followups[0].sourceScopeIds, ["source"]);
});

test("inspectHandoff accepts every followup kind", () => {
  const kinds = ["unread_scope", "evidence_gap", "conflict", "taxonomy_uncertain", "tool_failure"];
  const yaml = ["followups:", ...kinds.flatMap((kind) => [
    `  - kind: ${kind}`,
    `    question: Question for ${kind}`,
  ]), "domains: []"].join("\n");
  const inspected = inspectResearch(researchMarkdown(yaml), "incomplete");
  assert.equal("ok" in inspected, true);
  assert.deepEqual(inspected.research.followups.map((followup) => followup.kind), kinds);
});

test("inspectHandoff truncates oversized followup questions to 512 UTF-8 bytes", () => {
  const oversized = "中".repeat(171);
  const inspected = inspectResearch(researchMarkdown([
    "followups:",
    "  - kind: evidence_gap",
    `    question: ${oversized}`,
    "domains: []",
  ].join("\n")), "incomplete");
  assert.equal("ok" in inspected, true);
  assert.equal(inspected.research.followups[0].question, truncateUtf8(oversized, 512));
  assert.ok(Buffer.byteLength(inspected.research.followups[0].question, "utf8") <= 512);
  assert.equal(inspected.research.followups[0].question, "中".repeat(170));
});

test("inspectHandoff rejects files over 256 KiB", () => {
  assert.deepEqual(defectsOf(inspectResearch("x".repeat(MAX_WIKI_WORK_FILE_BYTES + 1))), ["handoff.md exceeds 256 KiB"]);
});

test("inspectHandoff host-mints deterministic review finding IDs", () => {
  const markdown = reviewMarkdown([
    "findings:",
    "  - path: wiki/a.md",
    "    severity: major",
    "  - path: wiki/b.md",
    "    severity: minor",
    "profileCoverage:",
    "  - evidence-fidelity",
  ].join("\n"));
  const inspect = () => inspectHandoff({
    bytes: markdown,
    contract: reviewContract(),
    finish: { field: "verdict", value: "changes_requested" },
  });
  const first = inspect();
  const second = inspect();
  assert.equal("ok" in first, true);
  assert.deepEqual(first.review, second.review);
  assert.deepEqual(first.review, {
    verdict: "changes_requested",
    reviewedPaths: ["wiki/a.md", "wiki/b.md"],
    findings: [
      { id: "finding-1", path: "wiki/a.md", severity: "major" },
      { id: "finding-2", path: "wiki/b.md", severity: "minor" },
    ],
    profileCoverage: ["evidence-fidelity"],
  });
});

test("inspectHandoff collects unknown review fields and findings outside assigned paths", () => {
  const defects = defectsOf(inspectHandoff({
    bytes: reviewMarkdown([
      "findings:",
      "  - path: wiki/outside.md",
      "    severity: critical",
      "  - path: wiki/also-out.md",
      "    severity: nope",
      "profileCoverage: []",
      "reviewedPaths: []",
    ].join("\n")),
    contract: reviewContract(["wiki/a.md"]),
    finish: { field: "verdict", value: "changes_requested" },
  })).join("; ");
  assert.match(defects, /review\.md frontmatter has unknown fields: reviewedPaths/);
  assert.match(defects, /findings\[0\]\.path "wiki\/outside\.md" is outside assigned paths \(assigned: wiki\/a\.md\)/);
  assert.match(defects, /findings\[1\]\.path "wiki\/also-out\.md" is outside assigned paths/);
  assert.match(defects, /findings\[1\]\.severity must be critical, major, or minor/);
});

test("inspectHandoff collects headings, citations, scopes, and assignment IDs together", () => {
  const inspected = inspectHandoff({
    bytes: [
      "Covered without a role heading.",
      "## Coverage",
      "assignment:a3",
      "## Evidence",
      "repo:source/a.ts#L1-L1",
      "foo/file.ts#L1-L2",
      "source-a/file.ts#L9-L2",
    ].join("\n"),
    contract: researchContract(["source-a", "source-b"], ["a1", "a2"]),
  });
  const defects = defectsOf(inspected);
  assert.ok(defects.includes("missing level-one role heading"));
  assert.match(defects.join("; "), /missing headings: Research Handoff, Scope, Conflicts and alternatives, Gaps and failed reads/);
  assert.match(defects.join("; "), /invalid citations: repo:source\/a\.ts#L1-L1 need \[label\]\(scope\/path#Lx\)/);
  assert.match(defects.join("; "), /source-a\/file\.ts#L9-L2 end<start/);
  assert.match(defects.join("; "), /citation scopes outside pinned scopes: foo \(allowed: source-a, source-b\)/);
  assert.match(defects.join("; "), /undeclared assignment IDs: a3 \(declared: a1, a2\)/);
});

test("inspectHandoff names why a citation is invalid without repeating the file body", () => {
  const defects = defectsOf(inspectHandoff({
    bytes: [
      "# Research Handoff", "## Scope", "ok", "## Coverage", "ok",
      "## Conflicts and alternatives", "None", "## Gaps and failed reads", "None",
      "## Evidence",
      "repo:source/a.ts#L1-L1",
      "source/missing.ts#L1-L1",
      "source/a.ts#L9-L12",
      "source/a.ts#L1",
    ].join("\n"),
    contract: researchContract(),
    fileLines: (citation) => citation.path === "a.ts" ? 2 : "missing",
  })).join("; ");
  assert.match(defects, /repo:source\/a\.ts#L1-L1 need \[label\]\(scope\/path#Lx\)/);
  assert.match(defects, /source\/missing\.ts#L1-L1 missing/);
  assert.match(defects, /source\/a\.ts#L9-L12 a\.ts:2 lines/);
  assert.doesNotMatch(defects, /export const|function |# Research Handoff/);
});

test("inspectHandoff requires Skill-format role headings", () => {
  const base = "# Research Handoff\n## Scope\nassignment:assignment-1\n## Coverage\n";
  assert.match(
    defectsOf(inspectHandoff({ bytes: `${base}## Evidence\nsource/file.ts#L1-L2`, contract: researchContract() })).join("; "),
    /missing headings: Conflicts and alternatives, Gaps and failed reads/,
  );
  assert.match(
    defectsOf(inspectHandoff({
      bytes: "# Research Handoff\n## Assignments\nCovered the assigned source scope.\n## Coverage\nVerified entry points.\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nsource/file.ts#L1-L2",
      contract: researchContract(),
    })).join("; "),
    /missing headings: Scope/,
  );
});

test("inspectHandoff accepts a write handoff without citations", () => {
  const inspected = inspectHandoff({
    bytes: "# Write Handoff\n\nUpdated the assigned page.\n",
    contract: writeContract(),
  });
  assert.equal("ok" in inspected, true);
  assert.equal(inspected.research, undefined);
  assert.equal(inspected.review, undefined);
});
