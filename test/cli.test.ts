import assert from "node:assert/strict";
import test from "node:test";
import {
  formatToolCall,
  parseWikiCliCommand,
  renderWikiLive,
  renderWikiRun,
  renderWikiSnapshot,
  wikiCliHelp,
} from "../extensions/wiki/lib/cli.js";

test("parses the compact Wiki command surface", () => {
  assert.deepEqual(parseWikiCliCommand(""), { action: "run" });
  assert.deepEqual(parseWikiCliCommand("auth and sessions"), {
    action: "run",
    focus: "auth and sessions",
  });
  assert.deepEqual(parseWikiCliCommand('full "public API"'), {
    action: "run",
    focus: "full public API",
  });
  assert.deepEqual(parseWikiCliCommand("status"), { action: "status" });
  assert.deepEqual(parseWikiCliCommand("pause"), { action: "pause" });
  assert.deepEqual(parseWikiCliCommand("resume"), { action: "resume" });
  assert.deepEqual(parseWikiCliCommand("cancel"), { action: "cancel" });
  assert.deepEqual(parseWikiCliCommand("init"), {
    action: "init", language: "zh", exclude: [], defaultSourceIgnores: true,
  });
  assert.deepEqual(parseWikiCliCommand('init docs --lang en --exclude "vendor/**" --exclude generated/** --no-default-ignores'), {
    action: "init", workspace: "docs", language: "en", exclude: ["vendor/**", "generated/**"], defaultSourceIgnores: false,
  });
  assert.deepEqual(parseWikiCliCommand("source add link ../api --name backend --workspace docs"), {
    action: "source-add", kind: "link", localPath: "../api", name: "backend", workspace: "docs",
  });
  assert.deepEqual(parseWikiCliCommand("source add clone https://example.test/web.git --ref main --name web"), {
    action: "source-add", kind: "clone", url: "https://example.test/web.git", ref: "main", name: "web",
  });
});

test("rejects ambiguous control commands", () => {
  assert.throws(() => parseWikiCliCommand("runs"), /removed/);
  assert.throws(() => parseWikiCliCommand("resume one"), /does not accept arguments/);
  assert.throws(() => parseWikiCliCommand("status run"), /does not accept arguments/);
  assert.throws(() => parseWikiCliCommand("init a b"), /Usage/);
  assert.throws(() => parseWikiCliCommand("init --lang fr"), /zh or en/);
  assert.throws(() => parseWikiCliCommand("init --exclude"), /requires a value/);
  assert.throws(() => parseWikiCliCommand("source add link ../api --ref main"), /Unknown/);
  assert.throws(() => parseWikiCliCommand("source add clone"), /Usage/);
});

test("renders plain run and snapshot output", () => {
  assert.equal(renderWikiRun(undefined), "Wiki: no run.");
  assert.equal(renderWikiRun({
    id: "run-1",
    cwd: "/repo",
    status: "running",
    focus: "auth",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  }), "Wiki run-1 | running | auth");
  assert.match(renderWikiRun({
    id: "run-1",
    cwd: "/repo",
    status: "paused",
    goal: "Auth wiki",
    tasks: [{ id: "write", content: "Write overview", status: "in_progress" }],
    agents: [{ id: "write-1", agent: "write", task: "author pages", status: "running", tools: [{ id: "1", tool: "read", args: { path: "src/a.ts" }, status: "running" }] }],
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  }), /in_progress  write  Write overview[\s\S]*◆ read src\/a\.ts/);
});

test("status snapshots format freshness in the system-default locale and time zone", () => {
  const rendered = renderWikiSnapshot({
    id: "run-1", cwd: "/repo", status: "running",
    createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:01:02.000Z",
  });
  const expected = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "medium",
  }).format(Date.parse("2026-08-12T00:01:02.000Z"));
  assert.ok(rendered.endsWith(`snapshot as of ${expected}`));
  assert.doesNotMatch(rendered, /2026-08-12T00:01:02\.000Z/);
});

test("formats tool calls for the live widget", () => {
  assert.equal(formatToolCall("read", { path: "src/checkout.ts", offset: 1, limit: 80 }), "read src/checkout.ts:1-80");
  assert.equal(formatToolCall("grep", { pattern: "CheckoutSession", path: "backend" }), "grep /CheckoutSession/ in backend");
  assert.equal(formatToolCall("subagent", { agent: "write", task: "author pages" }), "subagent write");
  assert.equal(formatToolCall("subagent", { tasks: [{ agent: "survey" }, { agent: "write" }] }), "subagent survey,write");
  assert.equal(formatToolCall("db_describe", { tables: ["orders", "payments"] }), "db_describe orders,payments");
});

test("renders a compact live widget from running agent tools", () => {
  assert.deepEqual(renderWikiLive({
    id: "run-1",
    cwd: "/repo",
    status: "running",
    focus: "auth",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    tasks: [{ id: "write", content: "Write CheckoutSession pages", status: "in_progress" }],
    agents: [{
      id: "write-1",
      agent: "write",
      task: "author pages",
      status: "running",
      tools: [{ id: "1", tool: "read", args: { path: "src/checkout.ts", offset: 1, limit: 80 }, status: "running" }],
    }],
  }), [
    "Wiki run-1 | running | auth",
    "in_progress  write  Write CheckoutSession pages",
    "◆ write · read src/checkout.ts:1-80",
  ]);
});

test("help lists management and run commands", () => {
  const help = wikiCliHelp();
  assert.match(help, /\/wiki \[focus\]/);
  assert.doesNotMatch(help, /regenerate|refresh/);
  assert.match(help, /\/wiki init/);
  assert.match(help, /\/wiki source add link/);
  assert.match(help, /\/wiki source add clone/);
  assert.match(help, /\/wiki status/);
  assert.match(help, /\/wiki resume/);
  assert.doesNotMatch(help, /run-id|\/wiki runs/);
  assert.doesNotMatch(help, /does not restore Pi sessions/);
  assert.doesNotMatch(help, /batch-N|--process/);
});
