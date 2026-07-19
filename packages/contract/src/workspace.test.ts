import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceConfigSchema, WorkspaceSourceSchema } from "./workspace.js";
import { exitCodeForStatus, WikiRunExitCode } from "./run.js";

test("WorkspaceSourceSchema accepts a clean local source", () => {
  const source = WorkspaceSourceSchema.parse({
    id: "application",
    path: "D:/src/my-app",
  });
  assert.equal(source.applyDefaultIgnores, true);
  assert.deepEqual(source.ignore, []);
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
  assert.equal(ws.adaptive, false);
  assert.equal(ws.version, 1);
});

test("exit codes map publication gate statuses", () => {
  assert.equal(exitCodeForStatus("awaiting_publication"), WikiRunExitCode.awaitingPublication);
  assert.equal(exitCodeForStatus("publication_declined"), WikiRunExitCode.publicationDeclined);
  assert.equal(exitCodeForStatus("published"), WikiRunExitCode.success);
});
