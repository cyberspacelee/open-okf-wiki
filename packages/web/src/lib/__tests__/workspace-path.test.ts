import assert from "node:assert/strict";
import test from "node:test";
import { agentWorkspaceHref, workspaceHref } from "../workspace-path.ts";

test("workspace links separate the Agent Workspace from secondary pages", () => {
  assert.equal(agentWorkspaceHref("team/wiki", "/repo"), "/w/team%2Fwiki?rootPath=%2Frepo");
  assert.equal(
    workspaceHref("team/wiki", "/sources", "/repo", { view: "tracked" }),
    "/workspaces/team%2Fwiki/sources?rootPath=%2Frepo&view=tracked",
  );
});
