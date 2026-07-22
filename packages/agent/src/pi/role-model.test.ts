import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { modelRefForRole, resolveModelSelection } from "./role-model.js";

function baseWorkspace(
  overrides: Partial<WorkspaceConfig> = {},
): WorkspaceConfig {
  return {
    version: 1,
    id: "ws1",
    name: "Test",
    rootPath: "/tmp/ws",
    sources: [],
    model: { id: "openai/default", profileId: "default" },
    publicationPath: "/tmp/wiki",
    limits: { requestTimeoutSeconds: 120 },
    roleModels: { reviewers: [] },
    orchestration: {
      maxDepth: 2,
      maxDomainFanOut: 4,
      maxLeafFanOut: 6,
      rootMaxSteps: 96,
      domainMaxSteps: 12,
      leafMaxSteps: 8,
      reviewerMaxSteps: 8,
      planMaxSteps: 24,
      reviewCouncilSize: 1,
    },
    planConfirm: false,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("role-model", () => {
  it("falls back to workspace.model", () => {
    const ws = baseWorkspace();
    assert.equal(modelRefForRole(ws, "writer").profileId, "default");
    assert.equal(modelRefForRole(ws, "worker").id, "openai/default");
  });

  it("uses roleModels.writer then planner for writer role", () => {
    const ws = baseWorkspace({
      roleModels: {
        planner: { id: "openai/planner", profileId: "planner" },
        writer: { id: "openai/writer", profileId: "writer" },
        reviewers: [],
      },
    });
    assert.equal(modelRefForRole(ws, "writer").profileId, "writer");
    assert.equal(modelRefForRole(ws, "planner").profileId, "planner");
  });

  it("writer falls back to planner when writer unset", () => {
    const ws = baseWorkspace({
      roleModels: {
        planner: { id: "openai/planner", profileId: "planner" },
        reviewers: [],
      },
    });
    assert.equal(modelRefForRole(ws, "writer").profileId, "planner");
  });

  it("overrideProfileId wins for run-time selection", () => {
    const ws = baseWorkspace({
      roleModels: {
        writer: { id: "openai/writer", profileId: "writer" },
        reviewers: [],
      },
    });
    const sel = resolveModelSelection({
      workspace: ws,
      role: "writer",
      overrideProfileId: "fast-local",
    });
    assert.equal(sel.profileId, "fast-local");
    assert.equal(sel.overridden, true);
    assert.equal(sel.role, "writer");
  });
});
