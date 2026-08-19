import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadWikiAgents, packagedAgentsRoot, parseAgentMarkdown } from "../extensions/wiki/lib/agents.js";
import { createSubagentRuntime } from "../extensions/wiki/lib/subagent.js";

test("unknown agent names are reported in parseable agent files", () => {
  const parsed = parseAgentMarkdown("---\nname: survey\ndescription: Map a source\n---\nBody\n", "survey.md");
  assert.equal(parsed.name, "survey");
  assert.match(parsed.prompt, /Body/);
});

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
