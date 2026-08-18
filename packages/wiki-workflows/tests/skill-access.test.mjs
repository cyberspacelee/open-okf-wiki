import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { workflowTools, workspaceToolPolicy } from "../dist/agent-tools.js";
import { pinnedWorkspaceToolPolicy } from "../dist/path-policy.js";
import { materializeProductionSkill, skillWorkspacePath } from "../dist/skill-store.js";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-access-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "a.ts"), "export const a = true;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1", "language: en", "defaultSourceIgnores: true",
    "wiki:", "  exclude: []",
    "sources:", "  - path: source", "    origin:", "      type: link", `      localPath: ${JSON.stringify(source)}`, "",
  ].join("\n"));
  const candidateWikiRoot = path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki");
  await mkdir(candidateWikiRoot, { recursive: true });
  await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "wiki", "secret.md"), "published\n");
  const skillRoot = await materializeProductionSkill(root, "run-1");
  return { root, candidateWikiRoot, skillRoot };
}

async function call(tools, name, params) {
  const tool = tools.find((value) => value.name === name);
  assert.ok(tool, `missing ${name}`);
  return await tool.execute("call-1", params, new AbortController().signal);
}

test("survey tools resolve skill-relative references against the materialized skill root", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const policy = pinnedWorkspaceToolPolicy(pinnedPlan(root, path.join(root, "source")), candidateWikiRoot, skillRoot);
  const researcher = workflowTools(policy, "researcher", undefined, ["source"]);
  assert.match(JSON.stringify(await call(researcher, "read", { path: "references/common.md" })), /evidence/i);
});

test("Lead and leaves can read the materialized skill but cannot write it", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const policy = await workspaceToolPolicy(root, candidateWikiRoot, skillRoot);
  const skillFile = path.join(skillWorkspacePath("run-1"), "SKILL.md");
  const lead = workflowTools(policy, "lead", undefined, ["source"], undefined, { async replacePage() {} });
  const read = await call(lead, "read", { path: skillFile });
  assert.match(JSON.stringify(read), /wiki_plan/);

  await assert.rejects(call(lead, "write", { path: skillFile, content: "hijack\n" }), /candidate Wiki|outside|not assigned|Lead may write/);

  const researcher = workflowTools(policy, "researcher", undefined, ["source"]);
  const researchRead = await call(researcher, "read", { path: skillFile });
  assert.match(JSON.stringify(researchRead), /wiki_plan/);
  await assert.rejects(call(researcher, "read", { path: "wiki/secret.md" }), /outside the permitted workspace scope/);
});

test("writer-capable tools require a transactional page writer", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const policy = await workspaceToolPolicy(root, candidateWikiRoot, skillRoot);
  assert.throws(() => workflowTools(policy, "lead", undefined, ["source"], undefined, undefined), /transactional WikiPageWriter/);
  assert.throws(() => workflowTools(policy, "writer", ["wiki/page.md"], ["source"], undefined, undefined), /transactional WikiPageWriter/);
});

test("production source scopeIds construct tools and gate the Workspace root", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const sourceAbs = path.join(root, "source");
  const policy = pinnedWorkspaceToolPolicy(pinnedPlan(root, sourceAbs), candidateWikiRoot, skillRoot);
  assert.throws(() => workflowTools(policy, "researcher", undefined, [sourceAbs]), /undeclared source root: .*Declared: source/);
  const researcher = workflowTools(policy, "researcher", undefined, ["source"]);
  const read = await call(researcher, "read", { path: "source/a.ts" });
  assert.match(JSON.stringify(read), /export const a/);

  for (const [name, params] of [
    ["read", { path: "." }],
    ["read", { path: root }],
    ["read", {}],
    ["grep", { path: ".", pattern: "export" }],
    ["grep", { path: root, pattern: "export" }],
    ["grep", { pattern: "export" }],
    ["find", { path: ".", pattern: "*.ts" }],
    ["find", { path: root, pattern: "*.ts" }],
    ["find", { pattern: "*.ts" }],
  ]) {
    await assert.rejects(call(researcher, name, params), /outside the permitted workspace scope[\s\S]*source/);
  }

  for (const params of [{ path: "." }, {}, { path: root }]) {
    const listing = JSON.stringify(await call(researcher, "ls", params));
    assert.match(listing, /source/);
    assert.doesNotMatch(listing, /wiki/);
    assert.doesNotMatch(listing, /\.okf-wiki/);
  }
});

test("implicit Workspace source allows ls and reads at the repo root", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await implicitWorkspace(t);
  const policy = pinnedWorkspaceToolPolicy(implicitPinnedPlan(root), candidateWikiRoot, skillRoot);
  const researcher = workflowTools(policy, "researcher", undefined, ["source"]);
  const listing = JSON.stringify(await call(researcher, "ls", { path: "." }));
  assert.match(listing, /a\.ts/);
  const read = await call(researcher, "read", { path: "a.ts" });
  assert.match(JSON.stringify(read), /export const a/);
});

test("research with no source scopes and no artifacts fails closed", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const policy = pinnedWorkspaceToolPolicy(pinnedPlan(root, path.join(root, "source")), candidateWikiRoot, skillRoot);
  assert.throws(() => workflowTools(policy, "researcher", undefined, []), /declared source roots or exact artifact paths/);
});

test("Pi file tools map only exact fixed workflow slots and reject siblings, read-only files, and symlinks", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const policy = pinnedWorkspaceToolPolicy(pinnedPlan(root, path.join(root, "source")), candidateWikiRoot, skillRoot);
  const taskRoot = path.join(root, ".okf-wiki", "runs", "run-1", "task-files", "1", "research", "1");
  await mkdir(taskRoot, { recursive: true });
  await writeFile(path.join(taskRoot, "brief.md"), "assigned brief\n");
  const slots = [
    { logicalPath: ".okf-wiki/task/brief.md", physicalPath: path.join(taskRoot, "brief.md"), writable: false },
    { logicalPath: ".okf-wiki/task/handoff.md", physicalPath: path.join(taskRoot, "handoff.md"), writable: true },
  ];
  const tools = workflowTools(policy, "researcher", undefined, ["source"], undefined, undefined, undefined, slots);

  assert.match(JSON.stringify(await call(tools, "read", { path: ".okf-wiki/task/brief.md" })), /assigned brief/);
  await call(tools, "write", { path: ".okf-wiki/task/handoff.md", content: "first draft\n" });
  await call(tools, "edit", { path: ".okf-wiki/task/handoff.md", edits: [{ oldText: "first", newText: "final" }] });
  assert.equal(await readFile(path.join(taskRoot, "handoff.md"), "utf8"), "final draft\n");

  await assert.rejects(call(tools, "write", { path: ".okf-wiki/task/brief.md", content: "replace\n" }), /read-only/);
  await assert.rejects(call(tools, "write", { path: ".okf-wiki/task/other.md", content: "escape\n" }), /not an assigned fixed workflow file|outside/);
  await assert.rejects(call(tools, "read", { path: ".okf-wiki/task" }), /outside the permitted workspace scope/);

  const target = path.join(taskRoot, "outside.md");
  await writeFile(target, "outside\n");
  await rm(path.join(taskRoot, "handoff.md"), { force: true });
  await symlink(target, path.join(taskRoot, "handoff.md"));
  await assert.rejects(call(tools, "read", { path: ".okf-wiki/task/handoff.md" }), /symbolic link/);
  await assert.rejects(call(tools, "write", { path: ".okf-wiki/task/handoff.md", content: "replace\n" }), /symbolic link/);
});

test("Lead fixed current slots expose the board and mutable YAML drafts without granting the run directory", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const policy = pinnedWorkspaceToolPolicy(pinnedPlan(root, path.join(root, "source")), candidateWikiRoot, skillRoot);
  const runRoot = path.join(root, ".okf-wiki", "runs", "run-1");
  const draftRoot = path.join(runRoot, "work-files", "current");
  await mkdir(runRoot, { recursive: true });
  await writeFile(path.join(runRoot, "board.md"), "# Board\n");
  const slots = [
    { logicalPath: ".okf-wiki/current/board.md", physicalPath: path.join(runRoot, "board.md"), writable: false },
    { logicalPath: ".okf-wiki/current/taxonomy.yaml", physicalPath: path.join(draftRoot, "taxonomy.yaml"), writable: true },
  ];
  const tools = workflowTools(policy, "lead", undefined, ["source"], undefined, { async replacePage() {} }, undefined, slots);

  assert.match(JSON.stringify(await call(tools, "read", { path: ".okf-wiki/current/board.md" })), /# Board/);
  await call(tools, "write", { path: ".okf-wiki/current/taxonomy.yaml", content: "revision: 1\n" });
  await call(tools, "edit", { path: ".okf-wiki/current/taxonomy.yaml", edits: [{ oldText: "1", newText: "2" }] });
  assert.equal(await readFile(path.join(draftRoot, "taxonomy.yaml"), "utf8"), "revision: 2\n");
  await assert.rejects(call(tools, "write", { path: ".okf-wiki/current/board.md", content: "replace\n" }), /read-only/);
  await assert.rejects(call(tools, "read", { path: ".okf-wiki/current" }), /outside the permitted workspace scope/);
  await assert.rejects(call(tools, "read", { path: ".okf-wiki/runs/run-1/board.md" }), /outside the permitted workspace scope/);
});

test("Lead cannot read research blobs; writers receive the exact blob path as context", async (t) => {
  const { root, candidateWikiRoot, skillRoot } = await workspace(t);
  const sha = "a".repeat(64);
  const relativePath = `.okf-wiki/blobs/${sha}.md`;
  await mkdir(path.join(root, ".okf-wiki", "blobs"), { recursive: true });
  await writeFile(path.join(root, relativePath), "# Research Handoff\n");
  const policy = pinnedWorkspaceToolPolicy(pinnedPlan(root, path.join(root, "source")), candidateWikiRoot, skillRoot);
  const lead = workflowTools(policy, "lead", undefined, ["source"], undefined, { async replacePage() {} });
  await assert.rejects(call(lead, "read", { path: relativePath }), /outside the permitted workspace scope/);

  policy.sourceRoots.set(relativePath, { logicalRoot: path.resolve(root, relativePath), physicalRoot: path.resolve(root, relativePath) });
  const writer = workflowTools(policy, "writer", ["wiki/overview.md"], ["source", relativePath], undefined, { async replacePage() {} });
  assert.match(JSON.stringify(await call(writer, "read", { path: relativePath })), /Research Handoff/);
});

function pinnedPlan(root, sourceAbs) {
  return {
    workspaceRoot: root,
    workspaceRealPath: root,
    configPath: path.join(root, "workspace.yaml"),
    defaultSourceIgnores: true,
    excludes: [],
    fingerprint: "a".repeat(64),
    sources: [{
      scopeId: "source",
      logicalPath: "source",
      absolutePath: sourceAbs,
      realPath: sourceAbs,
      repositoryRoot: sourceAbs,
      repositoryIdentity: "test-source",
      head: "0".repeat(40),
      dirtyFingerprint: "b".repeat(64),
    }],
  };
}

function implicitPinnedPlan(root) {
  return {
    workspaceRoot: root,
    workspaceRealPath: root,
    configPath: path.join(root, "workspace.yaml"),
    defaultSourceIgnores: true,
    excludes: [],
    fingerprint: "a".repeat(64),
    sources: [{
      scopeId: "source",
      logicalPath: ".",
      absolutePath: root,
      realPath: root,
      repositoryRoot: root,
      repositoryIdentity: "test-self",
      head: "0".repeat(40),
      dirtyFingerprint: "b".repeat(64),
    }],
  };
}

async function implicitWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-skill-implicit-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.ts"), "export const a = true;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const candidateWikiRoot = path.join(root, ".okf-wiki", "runs", "run-1", "candidate", "wiki");
  await mkdir(candidateWikiRoot, { recursive: true });
  const skillRoot = await materializeProductionSkill(root, "run-1");
  return { root, candidateWikiRoot, skillRoot };
}
