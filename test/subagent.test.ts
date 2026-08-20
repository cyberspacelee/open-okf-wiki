import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadWikiAgents, packagedAgentsRoot, parseAgentMarkdown } from "../extensions/wiki/lib/agents.js";
import { createSubagentRuntime, createSubagentTool } from "../extensions/wiki/lib/subagent.js";

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

test("subagent child sessions tag activity with the agent name", async (t) => {
  const events = [];
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-subagent-activity-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
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
    {
      sessionDir: path.join(workspaceRoot, "sessions"),
      async createSession() {
        return {
          session: {
            sessionFile: undefined,
            subscribe(listener) {
              listener({
                type: "tool_execution_start",
                toolCallId: "call-1",
                toolName: "grep",
                args: { pattern: "Order", path: "src" },
              });
              return () => {};
            },
            async prompt() {},
            async waitForIdle() {},
            getLastAssistantText() { return "mapped"; },
            dispose() {},
            abort() {},
          },
          modelFallbackMessage: undefined,
        };
      },
      onActivity(event) {
        events.push(event);
      },
    },
  );
  await runtime.run([{ agent: "survey", task: "map source" }], new AbortController().signal);
  assert.equal(events.length, 1);
  assert.equal(events[0].scope, "survey");
  assert.equal(events[0].tool, "grep");
  assert.equal(events[0].id, "call-1");
  assert.equal(events[0].status, "running");
});

test("subagent tool reports child tools through onUpdate", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-subagent-update-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const updates = [];
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
    {
      sessionDir: path.join(workspaceRoot, "sessions"),
      async createSession() {
        return {
          session: {
            sessionFile: undefined,
            subscribe(listener) {
              listener({
                type: "tool_execution_start",
                toolCallId: "call-1",
                toolName: "grep",
                args: { pattern: "Order", path: "src" },
              });
              listener({
                type: "tool_execution_end",
                toolCallId: "call-1",
                toolName: "grep",
                result: {},
                isError: false,
              });
              return () => {};
            },
            async prompt() {},
            async waitForIdle() {},
            getLastAssistantText() { return "mapped"; },
            dispose() {},
            abort() {},
          },
          modelFallbackMessage: undefined,
        };
      },
    },
  );
  const tool = createSubagentTool(runtime);
  const result = await tool.execute("call-1", { agent: "survey", task: "map tradingflow" }, new AbortController().signal, async (partial) => {
    updates.push(partial);
  });
  assert.ok(updates.length >= 2);
  assert.match(String(updates[0].content[0].text), /running survey/);
  const withTool = updates.find((update) => update.details?.tasks?.[0]?.tools?.length);
  assert.equal(withTool.details.tasks[0].tools[0].tool, "grep");
  assert.match(result.content[0].text, /## survey/);
  assert.match(tool.description, /survey.*write.*review/s);
});
