import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceConfigSchema, WorkspaceSourceSchema } from "./workspace.js";

test("WorkspaceSourceSchema accepts a clean local source", () => {
  const source = WorkspaceSourceSchema.parse({
    id: "application",
    path: "D:/src/my-app",
  });
  assert.equal(source.applyDefaultIgnores, true);
  assert.deepEqual(source.ignore, []);
  // Legacy records without origin normalize to path-linked on parse.
  assert.deepEqual(source.origin, { type: "path" });
});

test("WorkspaceSourceSchema accepts clone origin", () => {
  const source = WorkspaceSourceSchema.parse({
    id: "openwiki",
    path: "D:/ws/demo/sources/openwiki",
    origin: {
      type: "clone",
      remoteUrl: "https://example.com/openwiki.git",
      clonedAt: new Date().toISOString(),
    },
  });
  assert.equal(source.origin.type, "clone");
});

test("WorkspaceConfigSchema rejects secrets-shaped extra keys only via strict parse of known fields", () => {
  const ws = WorkspaceConfigSchema.parse({
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [{ id: "application", path: "D:/src/app" }],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    createdAt: new Date().toISOString(),
  });
  assert.equal(ws.planConfirm, false);
  assert.equal(ws.orchestration.maxDomainFanOut, 4);
  assert.equal(ws.orchestration.reviewCouncilSize, 1);
  assert.deepEqual(ws.roleModels.reviewers, []);
  assert.equal(ws.version, 1);
  assert.equal(ws.wikiLanguage, "en");
  assert.deepEqual(ws.sources[0]?.origin, { type: "path" });
});

test("WorkspaceConfigSchema accepts wikiLanguage zh", () => {
  const ws = WorkspaceConfigSchema.parse({
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    wikiLanguage: "zh",
    createdAt: new Date().toISOString(),
  });
  assert.equal(ws.wikiLanguage, "zh");
});

test("WorkspaceConfigSchema strips legacy orchestration MaxSteps keys", () => {
  const ws = WorkspaceConfigSchema.parse({
    id: "ws_1",
    name: "Demo",
    rootPath: "D:/ws/demo",
    sources: [],
    model: { id: "openai/corp-model" },
    publicationPath: "D:/ws/demo/wiki",
    createdAt: new Date().toISOString(),
    orchestration: {
      maxDepth: 2,
      maxDomainFanOut: 3,
      maxLeafFanOut: 5,
      rootMaxSteps: 96,
      domainMaxSteps: 12,
      leafMaxSteps: 8,
      reviewerMaxSteps: 8,
      planMaxSteps: 24,
      reviewCouncilSize: 2,
    },
  });
  assert.equal(ws.orchestration.maxDomainFanOut, 3);
  assert.equal(ws.orchestration.reviewCouncilSize, 2);
  assert.equal("rootMaxSteps" in ws.orchestration, false);
  assert.equal("planMaxSteps" in ws.orchestration, false);
});
