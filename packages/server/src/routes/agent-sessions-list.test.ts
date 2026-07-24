import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace, listRuns, registerRunRecord, saveWorkspace } from "@okf-wiki/core";
import { resetAgentSessionRegistryForTests } from "../agent-session-registry.ts";
import { dispatch } from "../dispatch.ts";

test("Operator Session HTTP uses only SessionManager and cascades v2 Run data on delete", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-session-http-"));
  const oldMode = process.env.OKF_WIKI_AGENT_MODE;
  process.env.OKF_WIKI_AGENT_MODE = "fixture";
  t.after(async () => {
    resetAgentSessionRegistryForTests();
    if (oldMode === undefined) delete process.env.OKF_WIKI_AGENT_MODE;
    else process.env.OKF_WIKI_AGENT_MODE = oldMode;
    await rm(root, { recursive: true, force: true });
  });

  const workspace = await createWorkspace({
    name: "Session HTTP",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    modelId: "openai/test",
  });
  await saveWorkspace(workspace);

  const server = createServer((req, res) => void dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}/agent/sessions`;
  const query = `?rootPath=${encodeURIComponent(root)}`;

  const createdResponse = await fetch(`${base}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "operator-http-1" }),
  });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const created = (await createdResponse.json()) as {
    session: { id: string; title: string };
  };
  assert.equal(created.session.id, "operator-http-1");
  assert.equal(created.session.title, "Wiki Agent · Session HTTP");

  // Legacy side metadata is ignored rather than merged or deleted.
  const legacyMeta = path.join(root, ".okf-wiki", "pi-sessions", "legacy.json");
  await writeFile(legacyMeta, JSON.stringify({ id: "legacy", cwd: root }), "utf8");

  const promptResponse = await fetch(`${base}/operator-http-1/command${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", text: "Build a concise wiki" }),
  });
  assert.equal(promptResponse.status, 202);
  const prompt = (await promptResponse.json()) as { ok: boolean; command: string };
  assert.equal(prompt.ok, true);
  assert.equal(prompt.command, "prompt");

  const getResponse = await fetch(`${base}/operator-http-1${query}`);
  assert.equal(getResponse.status, 404);

  const listResponse = await fetch(`${base}${query}`);
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()) as { sessions: Array<{ id: string; title?: string }> };
  assert.deepEqual(
    listed.sessions.map((session) => session.id),
    ["operator-http-1"],
  );
  assert.equal(listed.sessions[0]?.title, "Build a concise wiki");

  const pinnedResponse = await fetch(`${base}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "pinned-title", title: "Wiki Agent · pinned" }),
  });
  assert.equal(pinnedResponse.status, 201, await pinnedResponse.clone().text());
  const pinnedPrompt = await fetch(`${base}/pinned-title/command${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", text: "Do not replace my title" }),
  });
  assert.equal(pinnedPrompt.status, 202, await pinnedPrompt.clone().text());
  const relistedResponse = await fetch(`${base}${query}`);
  const relisted = (await relistedResponse.json()) as {
    sessions: Array<{ id: string; title?: string }>;
  };
  assert.equal(
    relisted.sessions.find((session) => session.id === "pinned-title")?.title,
    "Wiki Agent · pinned",
  );

  await registerRunRecord(root, workspace.id, {
    runId: "owned-run",
    sessionId: "operator-http-1",
    autoApprove: false,
    skillPath: path.join(root, ".okf-wiki", "runs", "owned-run", "skill"),
    skillDigest: "a".repeat(64),
    sources: [{ id: "main", revision: "b".repeat(40), effectiveIgnores: [] }],
  });
  const runWork = path.join(root, ".okf-wiki", "runs", "owned-run");
  await mkdir(runWork, { recursive: true });
  await writeFile(path.join(runWork, "scratch.txt"), "run work", "utf8");
  await mkdir(workspace.publicationPath, { recursive: true });
  const published = path.join(workspace.publicationPath, "index.md");
  await writeFile(published, "# Published\n", "utf8");

  const deleteResponse = await fetch(`${base}/operator-http-1${query}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await listRuns(root), []);
  assert.equal(await readFile(published, "utf8"), "# Published\n");
  assert.equal(await readFile(legacyMeta, "utf8"), JSON.stringify({ id: "legacy", cwd: root }));

  const missingCommand = await fetch(`${base}/missing/command${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "abort" }),
  });
  assert.equal(missingCommand.status, 404);
  const missingDelete = await fetch(`${base}/missing${query}`, { method: "DELETE" });
  assert.equal(missingDelete.status, 404);
});
