import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadWikiAgents, packagedAgentsRoot, parseAgentMarkdown } from "../extensions/wiki/lib/agents.js";
import { createSubagentRuntime, createSubagentTool } from "../extensions/wiki/lib/subagent.js";
import { loadWikiTemplatePack, packagedTemplatesRoot } from "../extensions/wiki/lib/templates.js";

function implicitPlan(workspaceRoot: string) {
  return {
    workspaceRoot,
    workspaceRealPath: workspaceRoot,
    configPath: undefined,
    defaultSourceIgnores: true,
    excludes: [],
    catalogs: {},
    sources: [{
      scopeId: "self",
      logicalPath: ".",
      absolutePath: workspaceRoot,
      realPath: workspaceRoot,
      repositoryRoot: workspaceRoot,
      repositoryIdentity: "test",
      origin: { type: "implicit" as const },
      head: "test",
      dirtyFingerprint: "test",
    }],
    fingerprint: "test",
  };
}

test("survey workers receive only the Catalog bound to their Source", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-catalog-scope-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const plan = implicitPlan(workspaceRoot);
  plan.sources[0].catalog = "shared";
  plan.catalogs = {
    shared: { url: "postgresql://shared@localhost/app", schema: "public", tables: [] },
    other: { url: "postgresql://other@localhost/app", schema: "public", tables: [] },
  };
  const catalog = (name: string) => ({
    config: plan.catalogs[name],
    async listTables() { return `${name} tables`; },
    async describeTables() { return { text: `${name} schema`, tables: [] }; },
  });
  let dbTables;
  const runtime = await createSubagentRuntime(plan, path.join(workspaceRoot, "candidate"), {
    async createSession(options) {
      dbTables = options.customTools.find((tool) => tool.name === "db_tables");
      return {
        session: {
          sessionFile: undefined,
          subscribe() { return () => {}; },
          async prompt() {},
          async waitForIdle() {},
          getLastAssistantText() { return "survey complete"; },
          dispose() {},
          abort() {},
        },
        modelFallbackMessage: undefined,
      };
    },
  }, undefined, undefined, new Map([
    ["shared", catalog("shared")],
    ["other", catalog("other")],
  ]));
  const [result] = await runtime.run([{
    agent: "survey",
    task: "Map Source",
    boardTaskId: "survey",
    partition: "self",
  }], new AbortController().signal);
  assert.equal(result.error, undefined);
  assert.ok(dbTables);
  const shared = await dbTables.execute("shared", { catalog: "shared" }, undefined, undefined, undefined);
  const other = await dbTables.execute("other", { catalog: "other" }, undefined, undefined, undefined);
  assert.match(shared.content[0].text, /shared tables/);
  assert.equal(other.isError, true);
});

function completionPack() {
  return {
    templates: [{
      sourceFile: "overview.md",
      id: "overview",
      type: "Overview",
      altitudes: ["wiki", "repo"] as Array<"wiki" | "repo">,
      identities: ["wiki", "repo"] as Array<"wiki" | "repo">,
      filename: "overview.md",
      cardinality: "one" as const,
      required: true,
      purpose: "Route readers into the Wiki.",
      sections: [{ title: "Details", guidance: "Describe the source." }],
    }],
  };
}

test("illegal survey partitions are rejected when Sources are pinned", async () => {
  const workspaceRoot = path.resolve("/tmp/okf-wiki-subagent-partition");
  const runtime = await createSubagentRuntime(
    {
      workspaceRoot,
      workspaceRealPath: workspaceRoot,
      configPath: path.join(workspaceRoot, "workspace.yaml"),
      defaultSourceIgnores: true,
      excludes: [],
      sources: [{
        scopeId: "api",
        logicalPath: "api",
        absolutePath: path.join(workspaceRoot, "api"),
        realPath: workspaceRoot,
        repositoryRoot: workspaceRoot,
        repositoryIdentity: "test",
        origin: { type: "link", localPath: workspaceRoot },
        head: "test",
        dirtyFingerprint: "test",
      }],
      fingerprint: "test",
    },
    path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate"),
    {},
  );
  await assert.rejects(
    () => runtime.run(
      [{ agent: "survey", task: "map", boardTaskId: "survey", partition: "web" }],
      new AbortController().signal,
    ),
    /pinned Source id/,
  );
});

test("unknown agent names are reported in parseable agent files", () => {
  const parsed = parseAgentMarkdown("---\nname: survey\ndescription: Map a source\n---\nBody\n", "survey.md");
  assert.equal(parsed.name, "survey");
  assert.match(parsed.prompt, /Body/);
});

test("agent definitions reject malformed YAML instead of silently skipping it", () => {
  assert.throws(
    () => parseAgentMarkdown("---\nname: [survey\ndescription: broken\n---\nBody\n", "broken.md"),
    /broken\.md/,
  );
  assert.throws(
    () => parseAgentMarkdown("---\nname: survey\ndescription: Map\ntools: [read]\n---\nBody\n", "broken.md"),
    /tools must be a comma-separated string/,
  );
});

test("unknown subagent names return Unknown agent and list packaged agents", async () => {
  const packaged = packagedAgentsRoot();
  const files = (await readdir(packaged)).filter((name) => name.endsWith(".md")).sort();
  const agents = await loadWikiAgents(packaged);
  const names = agents.map((agent) => agent.name);
  assert.ok(files.length > 0);
  assert.equal(agents.length, files.length);
  assert.deepEqual(names, ["review", "survey", "synthesize", "write"]);

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
    [{ agent: "not-a-packaged-agent", task: "invent a page", boardTaskId: "survey", partition: "unknown" }],
    new AbortController().signal,
  );
  assert.match(result.error, /Unknown agent "not-a-packaged-agent"/);
  assert.match(result.error, new RegExp(`Available: ${names.join(", ")}`));
});

test("subagent child sessions tag activity with the execution id", async (t) => {
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
  await runtime.run([{ agent: "survey", task: "map source", boardTaskId: "survey", partition: "source" }], new AbortController().signal);
  assert.equal(events.length, 1);
  assert.match(events[0].scope, /^survey-/);
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
  const result = await tool.execute("call-1", {
    agent: "survey",
    task: "map tradingflow",
    boardTaskId: "survey",
    partition: "tradingflow",
  }, new AbortController().signal, async (partial) => {
    updates.push(partial);
  });
  assert.ok(updates.length >= 2);
  assert.match(String(updates[0].content[0].text), /running survey/);
  const withTool = updates.find((update) => update.details?.tasks?.[0]?.tools?.length);
  assert.equal(withTool.details.tasks[0].tools[0].tool, "grep");
  assert.match(result.content[0].text, /## survey/);
  assert.match(result.content[0].text, /Handoff:/);
  assert.doesNotMatch(result.content[0].text, /mapped/);
  assert.match(tool.description, /survey.*write.*review/s);
  const handoff = result.details.results[0].handoff;
  assert.match(handoff, /handoffs\/survey-/);
  assert.match(await readFile(path.join(workspaceRoot, handoff), "utf8"), /mapped/);
});

test("subagent runtime bounds parallel sessions", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-subagent-concurrency-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  let active = 0;
  let peak = 0;
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
      async createSession() {
        return {
          session: {
            sessionFile: undefined,
            subscribe() { return () => {}; },
            async prompt() {
              active += 1;
              peak = Math.max(peak, active);
              await new Promise((resolve) => setTimeout(resolve, 10));
              active -= 1;
            },
            async waitForIdle() {},
            getLastAssistantText() { return "done"; },
            dispose() {},
            abort() {},
          },
          modelFallbackMessage: undefined,
        };
      },
    },
    undefined,
    undefined,
    undefined,
    { maxConcurrency: 2 },
  );
  await runtime.run(
    Array.from({ length: 5 }, (_, index) => ({
      agent: "survey",
      task: `map source ${index}`,
      boardTaskId: "survey",
      partition: `source-${index}`,
    })),
    new AbortController().signal,
  );
  assert.equal(peak, 2);
});

test("parallel survey tasks stay distinct in live updates", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-subagent-parallel-"));
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
      async createSession() {
        return {
          session: {
            sessionFile: undefined,
            subscribe() { return () => {}; },
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
  await tool.execute("call-1", {
    tasks: [
      { agent: "survey", task: "map backend", boardTaskId: "survey", partition: "backend" },
      { agent: "survey", task: "map frontend", boardTaskId: "survey", partition: "frontend" },
    ],
  }, new AbortController().signal, async (partial) => {
    updates.push(partial);
  });
  const live = updates.find((update) => update.details?.tasks?.length === 2);
  assert.ok(live);
  assert.equal(live.details.tasks[0].agent, "survey");
  assert.equal(live.details.tasks[1].agent, "survey");
  assert.notEqual(live.details.tasks[0].id, live.details.tasks[1].id);
  assert.deepEqual(live.details.tasks.map((task) => task.task).sort(), ["map backend", "map frontend"]);
});

test("subagent prompts project templates by role", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-subagent-templates-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const prompts = [];
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
      async createSession() {
        return {
          session: {
            sessionFile: undefined,
            subscribe() { return () => {}; },
            async prompt(value) { prompts.push(value); },
            async waitForIdle() {},
            getLastAssistantText() { return "verdict: pass"; },
            dispose() {},
            abort() {},
          },
          modelFallbackMessage: undefined,
        };
      },
    },
    undefined,
    undefined,
    undefined,
    { templates: await loadWikiTemplatePack(packagedTemplatesRoot("en")), language: "en" },
  );
  for (const agent of ["survey", "synthesize", "write", "review"]) {
    await runtime.run([{
      agent,
      task: `${agent} candidate`,
      boardTaskId: agent,
      partition: agent === "write" ? "wiki-root" : "candidate",
      ...(agent === "write" ? { writeMode: "directory" } : {}),
    }], new AbortController().signal);
  }
  const initial = prompts.filter((prompt) => prompt.includes("# Task"));
  assert.match(initial[0], /Page contract catalog/);
  assert.doesNotMatch(initial[0], /Output skeleton/);
  assert.match(initial[1], /Page contract catalog/);
  assert.doesNotMatch(initial[1], /Output skeleton/);
  assert.match(initial[2], /Output skeleton/);
  assert.match(initial[2], /## Directory contract/);
  assert.match(initial[2], /Assigned write target: `directory:wiki-root`/);
  assert.match(initial[2], /## Output language/);
  assert.match(initial[2], /Run language is `en`/);
  assert.match(initial[2], /Simplified Chinese/);
  assert.match(initial[2], /Preserve source identifiers/);
  assert.match(initial[3], /Page contract catalog/);
  assert.doesNotMatch(initial[3], /Output skeleton/);
  assert.equal(prompts.filter((prompt) => prompt.includes("## Output language")).length, 1);
  assert.equal(prompts.filter((prompt) => prompt.includes("## Directory contract")).length, 1);
});

test("subagent batches allow parallel survey and disjoint writes", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-subagent-guards-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const runtime = await createSubagentRuntime({
    workspaceRoot,
    workspaceRealPath: workspaceRoot,
    configPath: path.join(workspaceRoot, "workspace.yaml"),
    defaultSourceIgnores: true,
    excludes: [],
    sources: [],
    fingerprint: "test",
  }, path.join(workspaceRoot, "candidate"), {});
  await assert.rejects(() => runtime.run([
    { agent: "write", task: "a", boardTaskId: "write", partition: "billing", writeMode: "subtree" },
    { agent: "write", task: "b", boardTaskId: "write", partition: "billing/invoice", writeMode: "subtree" },
  ], new AbortController().signal), /overlapping write targets/);
  const parallelWrite = await createSubagentRuntime({
    workspaceRoot,
    workspaceRealPath: workspaceRoot,
    configPath: path.join(workspaceRoot, "workspace.yaml"),
    defaultSourceIgnores: true,
    excludes: [],
    sources: [],
    fingerprint: "test",
  }, path.join(workspaceRoot, "parallel-candidate"), {
    async createSession() {
      return {
        session: {
          sessionFile: undefined,
          subscribe() { return () => {}; },
          async prompt() {},
          async waitForIdle() {},
          getLastAssistantText() { return "wrote"; },
          dispose() {},
          abort() {},
        },
        modelFallbackMessage: undefined,
      };
    },
  });
  const writes = await parallelWrite.run([
    { agent: "write", task: "a", boardTaskId: "write", partition: "billing", writeMode: "subtree" },
    { agent: "write", task: "b", boardTaskId: "write", partition: "checkout", writeMode: "subtree" },
  ], new AbortController().signal);
  assert.equal(writes.length, 2);
  assert.equal(writes.every((result) => !result.error), true);
  await assert.rejects(() => runtime.run([
    { agent: "survey", task: "a", boardTaskId: "survey", partition: "a" },
    { agent: "review", task: "b", boardTaskId: "survey", partition: "b" },
  ], new AbortController().signal), /review must run alone|one agent role/);
  await assert.rejects(() => runtime.run([
    { agent: "survey", task: "a", boardTaskId: "survey", partition: "same" },
    { agent: "survey", task: "b", boardTaskId: "survey", partition: "same" },
  ], new AbortController().signal), /duplicate subagent partition/);
  await assert.rejects(() => runtime.run([
    { agent: "synthesize", task: "a", boardTaskId: "synthesize", partition: "workspace-a" },
    { agent: "synthesize", task: "b", boardTaskId: "synthesize", partition: "workspace-b" },
  ], new AbortController().signal), /synthesize must run alone/);

  let release;
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const exclusive = await createSubagentRuntime({
    workspaceRoot,
    workspaceRealPath: workspaceRoot,
    configPath: path.join(workspaceRoot, "workspace.yaml"),
    defaultSourceIgnores: true,
    excludes: [],
    sources: [],
    fingerprint: "test",
  }, path.join(workspaceRoot, "exclusive-candidate"), {
    async createSession() {
      return {
        session: {
          sessionFile: undefined,
          subscribe() { return () => {}; },
          async prompt() { announce(); await held; },
          async waitForIdle() {},
          getLastAssistantText() { return "done"; },
          dispose() {},
          abort() {},
        },
        modelFallbackMessage: undefined,
      };
    },
  });
  const writer = exclusive.run([
    { agent: "write", task: "write", boardTaskId: "write", partition: "wiki-root", writeMode: "directory" },
  ], new AbortController().signal);
  await started;
  await assert.rejects(() => exclusive.run([
    { agent: "review", task: "review", boardTaskId: "review", partition: "candidate" },
  ], new AbortController().signal), /exclusive/);
  release();
  await writer;
});

test("writer read ledger resolves linked Source citations from the Workspace root", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-citation-ledger-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  const workspaceRoot = path.join(parent, "workspace");
  const sourceRoot = path.join(parent, "source");
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "main.ts"), "export const ready = true;\n");
  await symlink(sourceRoot, path.join(workspaceRoot, "api"), "dir");
  let listener = () => {};
  let writerPrompt = "";
  const runtime = await createSubagentRuntime({
    workspaceRoot,
    workspaceRealPath: workspaceRoot,
    configPath: path.join(workspaceRoot, "workspace.yaml"),
    defaultSourceIgnores: true,
    excludes: [],
    sources: [{
      scopeId: "api",
      logicalPath: "api",
      absolutePath: path.join(workspaceRoot, "api"),
      realPath: sourceRoot,
      repositoryRoot: sourceRoot,
      repositoryIdentity: "test",
      origin: { type: "link", localPath: sourceRoot },
      head: "test",
      dirtyFingerprint: "test",
    }],
    fingerprint: "test",
  }, candidateRoot, {
    async createSession() {
      return {
        session: {
          sessionFile: undefined,
          subscribe(next) { listener = next; return () => {}; },
          async prompt(value) {
            writerPrompt = value;
            await writeFile(path.join(candidateRoot, "overview.md"), [
              "---",
              "type: Overview",
              "title: Overview",
              "description: Overview.",
              "sources:",
              "  - id: main",
              "    resource: api/main.ts#L1",
              "---",
              "# Overview",
              "",
              "Overview.",
              "",
              "## Details",
              "",
              "Grounded. [^main]",
              "",
              "[^main]: main",
              "",
            ].join("\n"));
            listener({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "api/main.ts" } });
            listener({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false });
            listener({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "wiki/overview.md" } });
            listener({ type: "tool_execution_end", toolCallId: "write-1", toolName: "write", result: {}, isError: false });
          },
          async waitForIdle() {},
          getLastAssistantText() { return "wrote"; },
          dispose() {},
          abort() {},
        },
        modelFallbackMessage: undefined,
      };
    },
  });
  const [result] = await runtime.run([
    { agent: "write", task: "Write overview", boardTaskId: "write", partition: "wiki-root", writeMode: "directory" },
  ], new AbortController().signal);
  assert.equal(result.error, undefined);
  assert.match(writerPrompt, /## Citation contract/);
});

test("writer repairs every unread citation in one session for more than two rounds", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-citation-repair-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate");
  await mkdir(candidateRoot, { recursive: true });
  for (const name of ["a.ts", "b.ts", "c.ts"]) {
    await writeFile(path.join(workspaceRoot, name), `export const ${name[0]} = true;\n`);
  }
  let listener = () => {};
  const prompts: string[] = [];
  const runtime = await createSubagentRuntime(implicitPlan(workspaceRoot), candidateRoot, {
    async createSession() {
      return {
        session: {
          sessionFile: undefined,
          subscribe(next) { listener = next; return () => {}; },
          async prompt(value) {
            prompts.push(value);
            if (prompts.length === 1) {
              await writeFile(path.join(candidateRoot, "overview.md"), [
                "---", "type: Overview", "title: Overview", "description: Overview.", "sources:",
                "  - id: a", "    resource: a.ts#L1",
                "  - id: b", "    resource: b.ts#L1",
                "  - id: c", "    resource: c.ts#L1",
                "---", "# Overview", "", "Overview.", "", "## Details", "", "Grounded. [^a] [^b] [^c]",
                "", "[^a]: a", "[^b]: b", "[^c]: c", "",
              ].join("\n"));
              listener({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "wiki/overview.md" } });
              listener({ type: "tool_execution_end", toolCallId: "write-1", toolName: "write", result: {}, isError: false });
              return;
            }
            const resource = ["a.ts", "b.ts", "c.ts"][prompts.length - 2];
            listener({ type: "tool_execution_start", toolCallId: `read-${prompts.length}`, toolName: "read", args: { path: resource } });
            listener({ type: "tool_execution_end", toolCallId: `read-${prompts.length}`, toolName: "read", result: {}, isError: false });
          },
          async waitForIdle() {},
          getLastAssistantText() { return "repaired"; },
          dispose() {},
          abort() {},
        },
        modelFallbackMessage: undefined,
      };
    },
  });
  const [result] = await runtime.run([
    { agent: "write", task: "Write overview", boardTaskId: "write", partition: "wiki-root", writeMode: "directory" },
  ], new AbortController().signal);
  assert.equal(result.error, undefined);
  assert.equal(prompts.length, 4);
  assert.match(prompts[1], /a\.ts#L1/);
  assert.match(prompts[1], /b\.ts#L1/);
  assert.match(prompts[1], /c\.ts#L1/);
  assert.match(prompts[1], /Suggested action/i);
});

test("writer repairs Todo and target validation before its session ends", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-writer-completion-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "run", "candidate");
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "main.ts"), "export const ready = true;\n");
  let listener = () => {};
  let output = "";
  const prompts: string[] = [];
  const runtime = await createSubagentRuntime(implicitPlan(workspaceRoot), candidateRoot, {
    async createSession(options) {
      const todo = options.customTools.find((tool) => tool.name === "todo");
      assert.ok(todo);
      return {
        session: {
          sessionFile: undefined,
          subscribe(next) { listener = next; return () => {}; },
          async prompt(value) {
            prompts.push(value);
            if (prompts.length === 1) {
              await todo.execute("todo-1", {
                action: "write",
                items: [{ path: "wiki/overview.md", status: "pending" }],
              }, new AbortController().signal, undefined, undefined);
              await writeFile(path.join(candidateRoot, "overview.md"), [
                "---", "type: Overview", "title: Overview", "description:", "sources:",
                "  - id: main", "    resource: main.ts#L1", "---", "# Overview", "", "Overview.",
                "", "## Details", "", "Grounded. [^main]", "", "[^main]: main", "",
              ].join("\n"));
              listener({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "main.ts" } });
              listener({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false });
              listener({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "wiki/overview.md" } });
              listener({ type: "tool_execution_end", toolCallId: "write-1", toolName: "write", result: {}, isError: false });
              output = "complete";
              return;
            }
            assert.match(value, /Writer completion validation/);
            assert.match(value, /writer-todo/);
            assert.match(value, /description/);
            await todo.execute("todo-2", {
              action: "write",
              items: [{ path: "wiki/overview.md", status: "completed" }],
            }, new AbortController().signal, undefined, undefined);
            await writeFile(path.join(candidateRoot, "overview.md"), [
              "---", "type: Overview", "title: Overview", "description: Overview.", "sources:",
              "  - id: main", "    resource: main.ts#L1", "---", "# Overview", "", "Overview.",
              "", "## Details", "", "Grounded. [^main]", "", "[^main]: main", "",
            ].join("\n"));
            listener({ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: "wiki/overview.md" } });
            listener({ type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", result: {}, isError: false });
            output = "complete";
          },
          async waitForIdle() {},
          getLastAssistantText() { return output; },
          dispose() {},
          abort() {},
        },
        modelFallbackMessage: undefined,
      };
    },
  }, undefined, undefined, undefined, { templates: completionPack() });
  const [result] = await runtime.run([{
    agent: "write",
    task: "Write overview",
    boardTaskId: "write",
    partition: "wiki-root",
    writeMode: "directory",
  }], new AbortController().signal);
  assert.equal(result.error, undefined);
  assert.equal(prompts.length, 2);
});

test("reviewer repairs its verdict before its session ends", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-reviewer-completion-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  let output = "";
  const prompts: string[] = [];
  const runtime = await createSubagentRuntime(implicitPlan(workspaceRoot), path.join(workspaceRoot, "candidate"), {
    async createSession() {
      return {
        session: {
          sessionFile: undefined,
          subscribe() { return () => {}; },
          async prompt(value) {
            prompts.push(value);
            output = prompts.length === 1 ? "Candidate looks correct." : "verdict: pass\n\nEvidence checked.";
          },
          async waitForIdle() {},
          getLastAssistantText() { return output; },
          dispose() {},
          abort() {},
        },
        modelFallbackMessage: undefined,
      };
    },
  });
  const [result] = await runtime.run([{
    agent: "review",
    task: "Review Candidate",
    boardTaskId: "review",
    partition: "candidate",
  }], new AbortController().signal);
  assert.equal(result.error, undefined);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /verdict: changes_requested/);
});

test("failed writes do not validate stale Candidate citations", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-failed-write-"));
  t.after(async () => await rm(workspaceRoot, { recursive: true, force: true }));
  const candidateRoot = path.join(workspaceRoot, ".okf-wiki", "runs", "abcd", "candidate");
  await mkdir(candidateRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "main.ts"), "source\n");
  await writeFile(path.join(candidateRoot, "overview.md"), [
    "---", "type: Overview", "title: Old", "description: Old.", "sources:",
    "  - id: main", "    resource: main.ts#L1", "---", "# Old", "", "Old.", "", "## Details", "",
    "Old. [^main]", "", "[^main]: main", "",
  ].join("\n"));
  const runtime = await createSubagentRuntime(implicitPlan(workspaceRoot), candidateRoot, {
    async createSession() {
      return { session: {
        sessionFile: undefined,
        subscribe(listener) {
          listener({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "wiki/overview.md" } });
          listener({ type: "tool_execution_end", toolCallId: "write-1", toolName: "write", result: {}, isError: true });
          return () => {};
        },
        async prompt() {}, async waitForIdle() {}, getLastAssistantText() { return "failed write"; },
        dispose() {}, abort() {},
      }, modelFallbackMessage: undefined };
    },
  });
  const [result] = await runtime.run([
    { agent: "write", task: "Repair overview", boardTaskId: "write", partition: "wiki-root", writeMode: "directory" },
  ], new AbortController().signal);
  assert.equal(result.error, undefined);
});
