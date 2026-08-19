import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWikiCliCommand,
  renderWikiRun,
  renderWikiSnapshot,
  renderWikiRuns,
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
  assert.deepEqual(parseWikiCliCommand("status run-1"), { action: "status", runId: "run-1" });
  assert.deepEqual(parseWikiCliCommand("runs"), { action: "runs" });
  assert.deepEqual(parseWikiCliCommand("pause"), { action: "pause" });
  assert.deepEqual(parseWikiCliCommand("resume"), { action: "resume" });
  assert.deepEqual(parseWikiCliCommand("cancel run.2"), { action: "cancel", runId: "run.2" });
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
  assert.throws(() => parseWikiCliCommand("runs extra"), /does not accept arguments/);
  assert.throws(() => parseWikiCliCommand("resume one two"), /Usage/);
  assert.throws(() => parseWikiCliCommand("status ../run"), /Invalid Wiki run id/);
  assert.throws(() => parseWikiCliCommand("init a b"), /Usage/);
  assert.throws(() => parseWikiCliCommand("init --lang fr"), /zh or en/);
  assert.throws(() => parseWikiCliCommand("init --exclude"), /requires a value/);
  assert.throws(() => parseWikiCliCommand("source add link ../api --ref main"), /Unknown/);
  assert.throws(() => parseWikiCliCommand("source add clone"), /Usage/);
});

test("renders plain run, list, and snapshot output", () => {
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
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  }), /in_progress  write  Write overview/);
  assert.equal(renderWikiRuns([]), "Wiki runs: none.");
  assert.match(renderWikiRuns([{ id: "run-1", status: "paused", updatedAt: "2026-08-12" }]), /run-1 \| paused/);
});

test("status snapshots state their freshness", () => {
  const rendered = renderWikiSnapshot({
    id: "run-1", cwd: "/repo", status: "running",
    createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:01:02.000Z",
  });
  const expected = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeStyle: "medium",
  }).format(Date.parse("2026-08-12T00:01:02.000Z"));
  assert.ok(rendered.endsWith(`snapshot as of ${expected}`));
});

test("help lists management and run commands", () => {
  const help = wikiCliHelp();
  assert.match(help, /\/wiki \[focus\]/);
  assert.doesNotMatch(help, /regenerate|refresh/);
  assert.match(help, /\/wiki init/);
  assert.match(help, /\/wiki source add link/);
  assert.match(help, /\/wiki source add clone/);
  assert.match(help, /\/wiki status \[run-id\]/);
  assert.match(help, /\/wiki resume \[run-id\]/);
  assert.doesNotMatch(help, /does not restore Pi sessions/);
  assert.doesNotMatch(help, /batch-N|--process/);
});
