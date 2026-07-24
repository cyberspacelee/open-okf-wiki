import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { WorkspaceConfigSchema } from "@okf-wiki/contract";
import { registerRunRecord } from "@okf-wiki/core";
import {
  createOperatorSession,
  deleteOperatorSession,
  listOperatorSessions,
  loadOperatorSessionHistory,
  openOperatorSession,
} from "./operator-session.js";

const temps: string[] = [];

after(async () => {
  for (const tmp of temps) await rm(tmp, { recursive: true, force: true });
});

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-operator-session-"));
  temps.push(root);
  const skill = path.join(root, "skill");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# skill\n", "utf8");
  return WorkspaceConfigSchema.parse({
    version: 1,
    id: "workspace",
    name: "Operator Workspace",
    rootPath: root,
    sources: [],
    skillPath: skill,
    model: { id: "openai/test" },
    publicationPath: path.join(root, "published"),
    limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
    planConfirm: true,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
}

const neverGate = {
  waitForDecision: async () => ({ action: "deny" as const }),
};

describe("SessionManager-owned Operator Sessions", () => {
  it("creates, lists, opens history, renames, and deletes through Pi authority", async () => {
    const workspace = await makeWorkspace();
    const created = await createOperatorSession({
      workspace,
      sessionId: "operator-1",
      wikiProduce: { gateCoordinator: neverGate, fixture: true },
    });
    try {
      assert.equal(created.sessionId, "operator-1");
      assert.equal(created.session.sessionManager.getCwd(), path.resolve(workspace.rootPath));
      assert.deepEqual(created.session.getActiveToolNames(), [
        "session_status",
        "wiki_produce",
      ]);

      created.session.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Build the wiki" }],
        timestamp: Date.now(),
      } as never);
      created.session.sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "I will use wiki_produce." }],
        stopReason: "stop",
        timestamp: Date.now(),
      } as never);
    } finally {
      created.dispose();
    }

    const listed = await listOperatorSessions(workspace.rootPath);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, "operator-1");
    assert.equal(listed[0]!.title, "Build the wiki");

    const history = await loadOperatorSessionHistory(workspace.rootPath, "operator-1");
    assert.ok(history);
    assert.deepEqual(
      history.messages.map((message) => message.role),
      ["user", "assistant"],
    );

    const opened = await openOperatorSession({
      workspace,
      sessionId: "operator-1",
      wikiProduce: { gateCoordinator: neverGate, fixture: true },
    });
    try {
      assert.equal(opened.sessionId, "operator-1");
      assert.deepEqual(opened.session.getActiveToolNames(), [
        "session_status",
        "wiki_produce",
      ]);
    } finally {
      opened.dispose();
    }

    const runId = "operator-run";
    const runDir = path.join(workspace.rootPath, ".okf-wiki", "runs", runId);
    const skillPath = path.join(runDir, "skill");
    await mkdir(skillPath, { recursive: true });
    await writeFile(path.join(runDir, "staging.txt"), "run-owned", "utf8");
    await registerRunRecord(workspace.rootPath, workspace.id, {
      runId,
      sessionId: "operator-1",
      autoApprove: false,
      skillPath,
      skillDigest: "a".repeat(64),
      sources: [
        {
          id: "main",
          revision: "b".repeat(40),
          effectiveIgnores: [],
        },
      ],
    });
    const publishedMarker = path.join(workspace.publicationPath, "keep.md");
    await mkdir(workspace.publicationPath, { recursive: true });
    await writeFile(publishedMarker, "published", "utf8");

    const deleted = await deleteOperatorSession(workspace.rootPath, "operator-1");
    assert.equal(deleted.deleted, true);
    assert.deepEqual(deleted.removedRunIds, [runId]);
    assert.equal((await listOperatorSessions(workspace.rootPath)).length, 0);
    await assert.rejects(access(runDir));
    await assert.rejects(
      access(path.join(workspace.rootPath, ".okf-wiki", "runs", `${runId}.json`)),
    );
    assert.equal(await readFile(publishedMarker, "utf8"), "published");
  });
});
