import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadWikiAgents, packagedAgentsRoot } from "../dist/agents.js";
import { createSubagentRuntime } from "../dist/subagent.js";

test("unknown subagent names return Unknown agent and list packaged agents", async () => {
  const packaged = packagedAgentsRoot();
  const files = (await readdir(packaged)).filter((name) => name.endsWith(".md")).sort();
  const agents = await loadWikiAgents(packaged);
  const names = agents.map((agent) => agent.name);
  assert.ok(files.length > 0);
  assert.equal(agents.length, files.length);
  assert.deepEqual(names, ["review", "survey", "write"]);

  const workspaceRoot = path.resolve("/tmp/okf-wiki-subagent");
  const runtime = await createSubagentRuntime(
    {
      workspaceRoot,
      workspaceRealPath: workspaceRoot,
      configPath: path.join(workspaceRoot, "workspace.yaml"),
      defaultSourceIgnores: true,
      excludes: [],
      sources: [],
      fingerprint: "test",
    },
    path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate"),
    {},
  );

  const [result] = await runtime.run(
    [{ agent: "not-a-packaged-agent", task: "invent a page" }],
    new AbortController().signal,
  );
  assert.match(result.error, /Unknown agent "not-a-packaged-agent"/);
  assert.match(result.error, new RegExp(`Available: ${names.join(", ")}`));
});
