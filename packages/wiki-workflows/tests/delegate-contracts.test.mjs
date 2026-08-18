import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseWikiDelegateContract, parseWikiDelegateReceipt, parseWikiDelegateTask, parseWikiResearchCompletion, projectWikiAgentOutcome } from "../dist/delegate-contracts.js";

const stable = (value) => JSON.stringify(sort(value));
const sort = (value) => Array.isArray(value) ? value.map(sort) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)])) : value;
const digest = (value) => createHash("sha256").update(stable(value)).digest("hex");

test("delegate task parser rejects unknown fields and impossible role/path states", () => {
  const base = { id: "task", instruction: "Do work", sourceScopeIds: [], contextRefs: [] };
  assert.throws(() => parseWikiDelegateTask({ ...base, role: "research", writePaths: ["wiki/a.md"] }), /Research delegate/);
  assert.throws(() => parseWikiDelegateTask({ ...base, role: "write" }), /must not be empty|Invalid Wiki writePaths/);
  assert.throws(() => parseWikiDelegateTask({ ...base, role: "review", reviewPaths: ["wiki/a.md"], extra: true }), /unknown fields/);
});

test("delegate contract and receipt parsers reject forged identity, digest, attempt shapes and review roles", () => {
  const body = { id: "review", role: "review", instruction: "Review", sourceScopeIds: [], contextRefs: [], reviewPaths: ["wiki/a.md"], contractVersion: 2, contractId: "b1-review", batchId: 1, reviewBasis: { version: 1, candidateRevision: 2, treeDigest: "a".repeat(64), policyDigest: "b".repeat(64), paths: ["wiki/a.md"] } };
  const contract = { ...body, contractDigest: digest(body) };
  assert.deepEqual(parseWikiDelegateContract(contract).contractId, "b1-review");
  assert.throws(() => parseWikiDelegateContract({ ...contract, contractId: "forged" }), /identity|digest/);
  assert.throws(() => parseWikiDelegateContract({ ...contract, contractDigest: "c".repeat(64) }), /digest mismatch/);
  assert.throws(() => parseWikiDelegateReceipt({ id: "x", role: "research", status: "complete", summary: "ok", outputs: [], coverage: [], gaps: [], attempts: 1, review: { verdict: "pass", reviewedPaths: ["wiki/a.md"], findings: [], profileCoverage: [] } }), /Only complete review/);
  assert.throws(() => parseWikiDelegateReceipt({ id: "x", role: "research", status: "complete", summary: "ok", outputs: [], coverage: [], gaps: [], attempts: 0 }), /Invalid Wiki delegate receipt/);
});

test("delegate receipt codec requires exact durable contract identity and projects a public-only outcome", () => {
  const receipt = {
    id: "research", role: "research", status: "complete", summary: "done", outputs: [],
    completedAssignmentIds: ["assignment-1"], needsFollowup: false, followups: [],
    domains: [{ sourceScopeId: "source", domainId: "core", conceptIds: ["session"] }],
    attempts: 1,
    contractId: "b1-research", contractDigest: "a".repeat(64),
  };
  assert.deepEqual(parseWikiDelegateReceipt(receipt), receipt);
  assert.throws(() => parseWikiDelegateReceipt({ ...receipt, forged: true }), /unknown fields/);
  assert.throws(() => parseWikiDelegateReceipt({ ...receipt, completedAssignmentIds: ["assignment-1", "assignment-1"] }), /completedAssignmentIds must be unique/);
  const { contractId: _contractId, ...missingId } = receipt;
  assert.throws(() => parseWikiDelegateReceipt(missingId), /contract id/);
  assert.deepEqual(projectWikiAgentOutcome(receipt), {
    id: "research", role: "research", status: "complete", summary: "done", coverage: ["assignment-1"], gaps: [], attempts: 1,
    completedAssignmentIds: ["assignment-1"], domains: receipt.domains,
  });
});

test("research completion accepts every concrete followup kind", () => {
  const kinds = ["unread_scope", "evidence_gap", "conflict", "taxonomy_uncertain", "tool_failure"];
  const completion = parseWikiResearchCompletion({
    status: "incomplete", summary: "needs targeted follow-up", completedAssignmentIds: ["assignment-1"], needsFollowup: true,
    followups: kinds.map((kind) => ({ kind, question: `Question for ${kind}`, sourceScopeIds: ["source"] })),
    domains: [],
  });
  assert.deepEqual(completion.followups.map((followup) => followup.kind), kinds);
});

test("incomplete research completion may report no completed assignments", () => {
  const completion = parseWikiResearchCompletion({
    status: "incomplete", summary: "no assignment completed", completedAssignmentIds: [], needsFollowup: true,
    followups: [{ kind: "tool_failure", question: "Source read failed", sourceScopeIds: ["source"] }],
    domains: [],
  });
  assert.deepEqual(completion.completedAssignmentIds, []);
});

test("incomplete research completion requires a follow-up blocker", () => {
  assert.throws(() => parseWikiResearchCompletion({
    status: "incomplete", summary: "blocked", completedAssignmentIds: [], needsFollowup: false, followups: [], domains: [],
  }), /requires followups/);
  assert.throws(() => parseWikiDelegateReceipt({
    id: "research", role: "research", status: "incomplete", summary: "blocked", outputs: [],
    completedAssignmentIds: [], needsFollowup: false, followups: [], domains: [], attempts: 1,
    contractId: "b1-research", contractDigest: "a".repeat(64),
  }), /requires followups/);
});
